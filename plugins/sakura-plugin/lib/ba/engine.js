/**
 * 碧蓝档案 · 回合制群战 —— 战斗内核
 *
 * 纯函数模块：不碰 Redis、不碰 e.reply，只做 (state, action) => { state, log }。
 * 状态全部是可 JSON 序列化的普通对象，能直接存进 Redis 再取出来接着打。
 *
 * 与 Python 版（docs/ba-battle/sim/engine.py）的唯一结构差异：
 * Python 版一次跑完整局并由 AI 出招，这里改成一次跑一个玩家回合、由玩家指令驱动。
 * 伤害公式、目标选择、状态计时三块逐行对应，改动时两边要同步。
 */

import { CFG, BY_ID, affinity } from "./roster.js"

// ---------------- 随机数 ----------------
// 种子存进 state，整场战斗可复现：群友吵「凭什么这刀没暴击」时用同一个种子重放即可

function nextRandom(state) {
  // mulberry32
  let t = (state.rng = (state.rng + 0x6d2b79f5) >>> 0)
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

function randRange(state, lo, hi) {
  return lo + nextRandom(state) * (hi - lo)
}

function randPick(state, arr) {
  return arr[Math.floor(nextRandom(state) * arr.length)]
}

// ---------------- 单位读取 ----------------

const tmplOf = (u) => BY_ID[u.id]

function modOf(u, stat) {
  let s = 0
  for (const b of u.buffs) if (b.stat === stat) s += b.value
  return s
}

/** 实际攻击力：基础 × (1 + 攻击力增减%)，下限 20% */
export function atkOf(u) {
  return tmplOf(u).atk * Math.max(0.2, 1 + modOf(u, "atk"))
}

/** 实际防御力：走除法减伤曲线，不做减法 */
export function dfsOf(u) {
  return tmplOf(u).dfs * Math.max(0.2, 1 + modOf(u, "dfs"))
}

const aliveOf = (side) => side.units.filter((u) => u.alive)
const sideDead = (side) => side.units.every((u) => !u.alive)

// ---------------- 白热化 ----------------

function sdDmg(state) {
  const n = state.round - CFG.SD_START + 1
  return Math.max(0, n) * CFG.SD_DMG_STEP
}

function sdHeal(state) {
  const n = state.round - CFG.SD_START + 1
  return Math.max(0.15, 1 - Math.max(0, n) * CFG.SD_HEAL_STEP)
}

// ---------------- 建局 ----------------

function makeUnit(tmpl, idx, side) {
  const u = {
    id: tmpl.id,
    idx,
    side,
    maxhp: Math.round(tmpl.hp * CFG.HP_SCALE),
    hp: Math.round(tmpl.hp * CFG.HP_SCALE),
    shield: 0, shieldTurns: 0, shieldSt: -1,
    buffs: [], dots: [],
    stun: 0, stunSt: -1,
    taunt: 0, tauntSt: -1,
    reflect: 0, reflectTurns: 0, reflectSt: -1,
    skillCd: tmpl.skill?.cd ?? 99,
    exCd: 0,
    reviveUsed: false,
    alive: true,
  }
  // 静态被动（如暴击伤害 +45%）实现成一个永不过期的 buff
  const st = tmpl.passive?.static
  if (st) {
    for (const [stat, value] of Object.entries(st)) {
      u.buffs.push({ stat, value, turns: 9999, st: -1 })
    }
  }
  return u
}

/**
 * @param {{uid, name, picks: string[]}} a 蓝方（picks 是 4 个角色 id，顺序即 1~4 号位）
 * @param {{uid, name, picks: string[]}} b 红方
 * @param {{first?: 0|1, seed?: number}} opts
 */
export function createBattle(a, b, opts = {}) {
  const seed = opts.seed ?? (Math.random() * 0xffffffff) >>> 0
  const state = {
    version: 1,
    seed,
    rng: seed,
    round: 0,
    turnId: 0,
    first: opts.first ?? 0,
    activeSide: opts.first ?? 0,
    phase: "command",
    winner: null,
    sides: [a, b].map((s, side) => ({
      side,
      uid: String(s.uid),
      name: s.name || String(s.uid),
      cost: CFG.COST_START,
      regenAcc: 0,
      units: s.picks.map((id, i) => makeUnit(BY_ID[id], i, side)),
    })),
  }
  // 后手方开局补偿：实测 3 点让先手胜率落在 49.0%
  state.sides[1 - state.first].cost += CFG.SECOND_BONUS
  return state
}

// ---------------- 目标选择 ----------------

/**
 * 普攻 / 普通技能的对线锁定，按顺序判定：
 *   1. 敌方有嘲讽 → 打它（多个取编号最小）
 *   2. 同号位存活 → 打同号位
 *   3. 存活敌人中取 |位置差| 最小者，同距离取编号小的
 */
function laneTarget(u, foes) {
  const taunts = foes.units.filter((f) => f.alive && f.taunt > 0)
  if (taunts.length) return taunts[0]

  const direct = foes.units[u.idx]
  if (direct?.alive) return direct

  const cands = aliveOf(foes)
  if (!cands.length) return null
  return cands.reduce((best, f) => {
    const d = Math.abs(f.idx - u.idx)
    const bd = Math.abs(best.idx - u.idx)
    if (d < bd) return f
    if (d === bd && f.idx < best.idx) return f
    return best
  })
}

function estDamage(src, tgt, mult) {
  return (
    atkOf(src) * mult *
    affinity(tmplOf(src).atkType, tmplOf(tgt).defType) *
    (CFG.DEF_K / (CFG.DEF_K + dfsOf(tgt)))
  )
}

/** enemy_single 未指定目标时的默认选择：优先能打死的，其次残血、高攻 */
function pickBestEnemy(src, eff, foes) {
  let best = null
  let bs = -Infinity
  for (const f of aliveOf(foes)) {
    const est = estDamage(src, f, eff.mult ?? 1)
    let s = est
    if (est >= f.hp + f.shield) s += 100000
    s += (1 - f.hp / f.maxhp) * 300 + atkOf(f) * 0.3
    if (s > bs) { bs = s; best = f }
  }
  return best
}

/**
 * @param {object} pick 玩家指定的目标 {scope:'foe'|'ally', idx:0-3}，可为空
 * @returns {Array} 伤害类返回 [unit]，lane_splash 返回 [[unit, 倍率修正]]
 */
function resolveTargets(state, u, eff, foes, allies, pick) {
  const tg = eff.target || "lane"

  // 玩家显式指定目标时，单体类效果直接采用（EX 是唯一能打破对线格局的手段）
  if (pick) {
    const pool = pick.scope === "ally" ? allies : foes
    const t = pool.units[pick.idx]
    if (t?.alive) {
      if (tg === "enemy_single") return [t]
      if (tg === "ally_lowest") return [t]
      if (tg === "lane_splash") {
        const out = [[t, 1.0]]
        for (const j of [t.idx - 1, t.idx + 1]) {
          if (j >= 0 && j < 4 && foes.units[j]?.alive) out.push([foes.units[j], eff.splash ?? 0.5])
        }
        return out
      }
    }
  }

  if (tg === "lane") {
    const t = laneTarget(u, foes)
    return t ? [t] : []
  }
  if (tg === "lane_splash") {
    let base = eff.ignoreDeadLane ? foes.units[u.idx] : laneTarget(u, foes)
    if (!base || !base.alive) base = laneTarget(u, foes)
    if (!base) return []
    const out = [[base, 1.0]]
    for (const j of [base.idx - 1, base.idx + 1]) {
      if (j >= 0 && j < 4 && foes.units[j]?.alive) out.push([foes.units[j], eff.splash ?? 0.5])
    }
    return out.filter(([t]) => t.alive)
  }
  if (tg === "enemy_all") return aliveOf(foes)
  if (tg === "enemy_random") return aliveOf(foes)
  if (tg === "enemy_single") {
    const t = pickBestEnemy(u, eff, foes)
    return t ? [t] : []
  }
  if (tg === "ally_all") return aliveOf(allies)
  if (tg === "ally_lowest") {
    const al = aliveOf(allies)
    if (!al.length) return []
    return [al.reduce((m, a) => (a.hp / a.maxhp < m.hp / m.maxhp ? a : m))]
  }
  if (tg === "self") return [u]
  return []
}

// ---------------- 伤害 ----------------

const nameOf = (u) => tmplOf(u).name

function applyDamage(ctx, src, tgt, dmg, crit = false, aff = 1.0) {
  let absorbed = 0
  if (tgt.shield > 0) {
    absorbed = Math.min(tgt.shield, dmg)
    tgt.shield -= absorbed
    dmg -= absorbed
  }
  tgt.hp -= dmg

  const tag =
    (crit ? "暴击" : "") +
    (aff > 1.01 ? "·克制" : aff < 0.99 ? "·抵抗" : "")
  const ab = absorbed > 0 ? `（护盾吸收 ${Math.round(absorbed)}）` : ""
  ctx.log(`  ${src ? nameOf(src) : "持续伤害"} → ${nameOf(tgt)} ${Math.round(dmg)}${ab} ${tag}`.trimEnd())

  if (tgt.hp <= 0) {
    const rv = tmplOf(tgt).passive?.revive
    if (rv && !tgt.reviveUsed) {
      tgt.reviveUsed = true
      tgt.hp = tgt.maxhp * rv
      ctx.log(`  ★ ${nameOf(tgt)} 顽强，残存 ${Math.round(tgt.hp)}`)
    } else {
      tgt.hp = 0
      tgt.alive = false
      tgt.taunt = 0
      ctx.log(`  ✝ ${nameOf(tgt)} 倒下`)
    }
  }
}

function deal(ctx, src, tgt, mult, eff, mod = 1.0) {
  const { state } = ctx
  if (!tgt.alive || !src.alive) return 0

  // 闪避：真随机（v4 改动，给落后方留翻盘的运气空间）
  const dr = Math.min(CFG.DODGE_CAP, tmplOf(tgt).dodge / (tmplOf(tgt).dodge + CFG.DODGE_K))
  if (dr > 0 && nextRandom(state) < dr) {
    ctx.log(`  ${nameOf(tgt)} 闪避了 ${nameOf(src)}`)
    return 0
  }

  const cr = Math.min(CFG.CRIT_CAP, tmplOf(src).crit)
  const crit = eff.forceCrit ? true : nextRandom(state) < cr

  const aff = affinity(tmplOf(src).atkType, tmplOf(tgt).defType)
  let dmg = atkOf(src) * mult * mod * aff * (CFG.DEF_K / (CFG.DEF_K + dfsOf(tgt)))

  const eb = eff.execBonus
  if (eb && tgt.hp / tgt.maxhp <= eb[0]) dmg *= eb[1]

  dmg *= 1 + modOf(src, "dmg_deal")
  dmg *= Math.max(0.1, 1 + modOf(tgt, "dmg_take"))
  dmg *= 1 + sdDmg(state)
  if (crit) dmg *= CFG.CRIT_DMG + modOf(src, "crit_dmg")
  if (CFG.DMG_JITTER) dmg *= 1 + randRange(state, -CFG.DMG_JITTER, CFG.DMG_JITTER)
  dmg = Math.max(1, dmg)

  applyDamage(ctx, src, tgt, dmg, crit, aff)

  if (tgt.reflect > 0 && tgt.alive && src.alive) {
    const r = dmg * tgt.reflect
    ctx.log(`  ⟲ ${nameOf(tgt)} 反伤 ${Math.round(r)}`)
    applyDamage(ctx, null, src, r)
  }
  return dmg
}

function heal(ctx, src, tgt, amount) {
  if (!tgt.alive) return
  amount *= sdHeal(ctx.state)
  const h = Math.min(amount, tgt.maxhp - tgt.hp)
  tgt.hp += h
  if (h > 0) {
    ctx.log(`  ${nameOf(src)} 治疗 ${tgt === src ? "自身" : nameOf(tgt)} +${Math.round(h)}`)
  }
}

// ---------------- 效果执行 ----------------

function execute(ctx, u, eff, label, pick) {
  const { state } = ctx
  const me = state.sides[u.side]
  const foes = state.sides[1 - u.side]
  const tgs = resolveTargets(state, u, eff, foes, me, pick)
  if (!tgs.length) return

  ctx.log(`[${u.side === 0 ? "蓝" : "红"}] ${nameOf(u)} ${label}`)
  const T = state.turnId

  if ((eff.kind || "damage") === "damage") {
    const mult = eff.mult
    if (eff.target === "enemy_random") {
      for (let i = 0; i < (eff.hits || 1); i++) {
        const al = aliveOf(foes)
        if (!al.length) break
        deal(ctx, u, randPick(state, al), mult, eff)
      }
    } else if (eff.target === "lane_splash") {
      for (const [tgt, m] of tgs) deal(ctx, u, tgt, mult, eff, m)
    } else {
      for (const tgt of tgs) {
        // 引爆：清空目标身上的灼烧，换成一次性追加伤害
        if (eff.detonate && tgt.dots.length) {
          tgt.dots.length = 0
          deal(ctx, u, tgt, mult + eff.detonate, eff)
        } else {
          deal(ctx, u, tgt, mult, eff)
        }
        if (!tgt.alive) continue
        for (const db of eff.debuffs || []) tgt.buffs.push({ ...db, st: T })
        if (eff.dot) {
          tgt.dots.push({ value: eff.dot.value, turns: eff.dot.turns, srcAtk: atkOf(u), st: T })
        }
        if (eff.stun) { tgt.stun = Math.max(tgt.stun, eff.stun); tgt.stunSt = T }
      }
    }
  } else {
    for (const tgt of tgs) {
      if (eff.heal) heal(ctx, u, tgt, atkOf(u) * eff.heal)
      if (eff.shield) {
        tgt.shield = Math.max(tgt.shield, atkOf(u) * eff.shield * sdHeal(state))
        tgt.shieldTurns = eff.shieldTurns ?? 2
        tgt.shieldSt = T
        ctx.log(`  ${nameOf(tgt)} 获得护盾 ${Math.round(tgt.shield)}`)
      }
      if (eff.cleanse) {
        tgt.buffs = tgt.buffs.filter((b) => b.value > 0)
        tgt.dots.length = 0
      }
      if (eff.taunt) { tgt.taunt = eff.taunt; tgt.tauntSt = T }
      if (eff.reflect) {
        tgt.reflect = eff.reflect
        tgt.reflectTurns = eff.reflectTurns ?? 1
        tgt.reflectSt = T
      }
      for (const b of eff.buffs || []) tgt.buffs.push({ ...b, st: T })
    }
  }

  for (const b of eff.selfBuffs || []) u.buffs.push({ ...b, st: T })
  if (eff.selfHeal) heal(ctx, u, u, atkOf(u) * eff.selfHeal)
}

// ---------------- 回合结算 ----------------

/**
 * 状态计时：在其所属角色的回合结束时 −1，但**施加它的那个回合不计**。
 * 漏掉后半句会让嘲讽在敌方回合到来之前就过期（潮汐胜率曾因此从 47% 崩到 17.7%）。
 */
function endTurn(ctx, side) {
  const { state } = ctx
  const T = state.turnId
  for (const u of side.units) {
    if (!u.alive) continue

    for (const d of [...u.dots]) {
      if (d.st === T) continue
      applyDamage(ctx, null, u, d.srcAtk * d.value * (1 + sdDmg(state)))
      d.turns -= 1
      if (d.turns <= 0) u.dots.splice(u.dots.indexOf(d), 1)
    }
    for (const b of [...u.buffs]) {
      if (b.st === T || b.turns >= 9999) continue
      b.turns -= 1
      if (b.turns <= 0) u.buffs.splice(u.buffs.indexOf(b), 1)
    }
    if (u.shieldTurns > 0 && u.shieldSt !== T) {
      u.shieldTurns -= 1
      if (u.shieldTurns === 0) u.shield = 0
    }
    if (u.stun > 0 && u.stunSt !== T) u.stun -= 1
    if (u.taunt > 0 && u.tauntSt !== T) u.taunt -= 1
    if (u.reflectTurns > 0 && u.reflectSt !== T) {
      u.reflectTurns -= 1
      if (u.reflectTurns === 0) u.reflect = 0
    }
    if (u.exCd > 0) u.exCd -= 1
    if (u.skillCd > 0) u.skillCd -= 1
  }
}

function checkEnd(state) {
  return sideDead(state.sides[0]) || sideDead(state.sides[1])
}

function settle(state) {
  const a = sideDead(state.sides[0])
  const b = sideDead(state.sides[1])
  if (a && b) state.winner = -1
  else if (b) state.winner = 0
  else if (a) state.winner = 1
  else {
    const ratio = (s) =>
      s.units.reduce((x, u) => x + u.hp, 0) / s.units.reduce((x, u) => x + u.maxhp, 0)
    const ra = ratio(state.sides[0])
    const rb = ratio(state.sides[1])
    state.winner = ra > rb ? 0 : rb > ra ? 1 : -1
  }
  state.phase = "done"
  return state.winner
}

// ---------------- 对外主接口 ----------------

/** Cost 回复只取决于存活人数，与本回合做了什么无关 */
export function regenOf(side) {
  const n = aliveOf(side).length
  const extra = side.units
    .filter((u) => u.alive)
    .reduce((s, u) => s + (tmplOf(u).passive?.costRegen || 0), 0)
  return CFG.COST_REGEN + CFG.COST_REGEN_PER_UNIT * n + extra
}

/** 校验一条指令能不能执行，返回错误文案或 null。不改动 state。 */
export function validateAction(state, action) {
  if (state.phase !== "command") return "这局已经结束了"
  if (action.type === "pass") return null

  const side = state.sides[state.activeSide]
  const seen = new Set()
  let budget = side.cost

  for (const cast of action.casts) {
    const u = side.units[cast.pos]
    if (!u) return `没有 ${cast.pos + 1} 号位`
    if (seen.has(cast.pos)) return `${nameOf(u)} 一回合只能放一次 EX`
    seen.add(cast.pos)
    if (!u.alive) return `${nameOf(u)} 已经倒下了`
    if (u.stun > 0) return `${nameOf(u)} 被眩晕，放不出 EX`
    if (u.exCd > 0) return `${nameOf(u)} 的 EX 还在冷却`
    const cost = tmplOf(u).ex.cost
    if (budget < cost) {
      return `Cost 不够：${nameOf(u)} 要 ${cost} 点，你还剩 ${budget} 点`
    }
    budget -= cost
  }
  return null
}

/**
 * 打完当前行动方的一个玩家回合。
 * @param {object} prev 战斗状态（不会被修改）
 * @param {{type:'pass'}|{type:'ex', casts:Array<{pos:number, target?:object}>}} action
 * @returns {{state:object, log:string[], error?:string}}
 */
export function playerTurn(prev, action) {
  const err = validateAction(prev, action)
  if (err) return { state: prev, log: [], error: err }

  const state = structuredClone(prev)
  const lines = []
  const ctx = { state, log: (s) => lines.push(s) }

  const side = state.sides[state.activeSide]
  const tag = state.activeSide === 0 ? "蓝" : "红"

  // 每个大回合从先手方开始，此时才推进回合数
  if (state.activeSide === state.first) state.round += 1
  state.turnId += 1

  // ① Cost 回复
  const costAtStart = side.cost
  side.regenAcc += regenOf(side)
  const gain = Math.floor(side.regenAcc)
  side.regenAcc -= gain
  side.cost = Math.min(CFG.COST_MAX, side.cost + gain)
  const gained = side.cost - costAtStart // 撞上限时实际到手会少于 gain
  let spent = 0

  const done = () => ({ state, log: lines, costBefore: costAtStart, gained, spent })

  lines.push(`--- ${tag}方回合（Cost ${side.cost}）---`)

  // ② 玩家指令：EX
  let usedEx = false
  if (action.type === "ex") {
    for (const cast of action.casts) {
      const u = side.units[cast.pos]
      if (!u.alive || u.stun > 0 || u.exCd > 0) continue
      const ex = tmplOf(u).ex
      if (side.cost < ex.cost) continue
      side.cost -= ex.cost
      spent += ex.cost
      u.exCd = CFG.EX_CD + 1
      usedEx = true
      execute(ctx, u, ex, `EX〔${tmplOf(u).role}〕(-${ex.cost})`, cast.target)
      if (checkEnd(state)) { settle(state); return done() }
    }
  }
  if (!usedEx) lines.push(`[${tag}] 过`)

  // ③ 己方角色按位置 1→4 依次自动行动
  for (const u of side.units) {
    if (!u.alive) continue
    if (sideDead(state.sides[1 - state.activeSide])) break
    if (u.stun > 0) {
      lines.push(`[${tag}] ${nameOf(u)} 眩晕，无法行动`)
      continue
    }
    const tmpl = tmplOf(u)
    if (u.skillCd <= 0) {
      u.skillCd = tmpl.skill.cd
      execute(ctx, u, tmpl.skill, "普通技能")
    } else {
      execute(ctx, u, { kind: "damage", mult: 1.0, target: "lane" }, "普攻")
    }
    if (checkEnd(state)) { settle(state); return done() }
  }

  // ④ 回合结束结算
  endTurn(ctx, side)
  if (checkEnd(state)) { settle(state); return done() }

  // 交棒
  state.activeSide = 1 - state.activeSide
  if (state.activeSide === state.first && state.round >= CFG.MAX_ROUND) {
    settle(state)
  }
  return done()
}

export { nameOf, tmplOf, aliveOf, sideDead }
