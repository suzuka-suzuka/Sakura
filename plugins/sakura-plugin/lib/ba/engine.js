/**
 * 碧蓝档案 · 回合制群战 —— 战斗内核
 *
 * 纯函数模块：不碰 Redis、不碰 e.reply，只做 (state, action) => { state, log }。
 * 状态全部是可 JSON 序列化的普通对象，能直接存进 Redis 再取出来接着打。
 *
 * 与 Python 版（docs/ba-battle/sim/engine.py）的唯一结构差异：
 * Python 版一次跑完整局并由 AI 出招，这里改成一次跑一个回合、由玩家指令驱动。
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

function unitRef(u) {
  return u ? { side: u.side, pos: u.idx } : null
}

function affinityMark(value) {
  if (value > 1.01) return "weak"
  if (value < 0.99) return "resist"
  return "normal"
}

function emitEvent(ctx, event) {
  ctx.emit?.(event)
}

function sourceKeyOf(side, pos) {
  return `${side}:${pos}`
}

function statusSourceKey(status) {
  return status.sourceKey
}

function sameStatusLayer(current, next) {
  const currentSource = statusSourceKey(current)
  const nextSource = statusSourceKey(next)
  return Boolean(currentSource && nextSource) &&
    currentSource === nextSource &&
    current.effectKind === next.effectKind &&
    current.stat === next.stat
}

/** 同一施加者的同类状态以最新一层覆盖；不同施加者各自保留一层。 */
function upsertStatusLayer(list, next) {
  const first = list.findIndex((current) => sameStatusLayer(current, next))
  if (first < 0) {
    list.push(next)
    return next
  }
  list[first] = next
  for (let i = list.length - 1; i > first; i--) {
    if (sameStatusLayer(list[i], next)) list.splice(i, 1)
  }
  return next
}

function upsertDotLayer(list, next) {
  const nextSource = statusSourceKey(next)
  const first = list.findIndex((current) =>
    nextSource && statusSourceKey(current) === nextSource
  )
  if (first < 0) {
    list.push(next)
    return next
  }
  list[first] = next
  for (let i = list.length - 1; i > first; i--) {
    if (statusSourceKey(list[i]) === nextSource) list.splice(i, 1)
  }
  return next
}

/** 不同施加者的同类百分比状态逐层乘算。 */
function factorOf(u, stat) {
  let factor = 1
  for (const status of u.buffs) {
    if (status.stat === stat) factor *= 1 + status.value
  }
  return factor
}

// 这类友方增益会影响施放后的 EX 与本回合自动行动，因此施放回合就是第 1 回合。
const CURRENT_TURN_BUFF_STATS = new Set(["atk", "dmg_deal", "crit", "crit_dmg"])
// 这类减益会改变施放方本回合后续攻击的结果，因此也把施放回合算作第 1 回合。
const CURRENT_TURN_DEBUFF_STATS = new Set(["dfs", "dmg_take"])

function timedFriendlyBuff(buff, turnId, source) {
  return {
    ...buff,
    effectKind: "buff",
    sourceKey: sourceKeyOf(source.side, source.idx),
    srcSide: source.side,
    srcPos: source.idx,
    st: turnId,
    countCurrent: CURRENT_TURN_BUFF_STATS.has(buff.stat),
  }
}

function timedEnemyDebuff(debuff, turnId, source, targetSide) {
  const countCurrent = CURRENT_TURN_DEBUFF_STATS.has(debuff.stat)
  return {
    ...debuff,
    effectKind: "debuff",
    sourceKey: sourceKeyOf(source.side, source.idx),
    srcSide: source.side,
    srcPos: source.idx,
    st: turnId,
    countCurrent,
    // 降防、易伤等跟随施放方的攻击窗口倒计时；降攻等则跟随目标的行动倒计时。
    tickSide: countCurrent ? source.side : targetSide,
  }
}

/** 实际攻击力：基础 × 各来源修正层，下限 20% */
export function atkOf(u) {
  return tmplOf(u).atk * Math.max(0.2, factorOf(u, "atk"))
}

/** 实际防御力：走除法减伤曲线，不做减法 */
export function dfsOf(u) {
  return tmplOf(u).dfs * Math.max(0.2, factorOf(u, "dfs"))
}

const aliveOf = (side) => side.units.filter((u) => u.alive)
const sideDead = (side) => side.units.every((u) => !u.alive)

// ---------------- EX 技能牌窗口 ----------------

/**
 * 技能牌初始顺序只由战斗种子和阵营决定，不占用战斗伤害的随机数序列。
 */
function initialExOrder(state, sideIndex) {
  const order = state.sides[sideIndex].units.map((_, i) => i)
  let x = ((Number(state.seed) || 0) ^ Math.imul(sideIndex + 1, 0x9e3779b9)) >>> 0
  if (!x) x = 0x6d2b79f5
  const next = () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return x >>> 0
  }
  for (let i = order.length - 1; i > 0; i--) {
    const j = next() % (i + 1)
    const tmp = order[i]
    order[i] = order[j]
    order[j] = tmp
  }
  return order
}

function initializeExWindows(state) {
  for (let sideIndex = 0; sideIndex < state.sides.length; sideIndex++) {
    const side = state.sides[sideIndex]
    const order = initialExOrder(state, sideIndex)
    side.exHand = order.slice(0, CFG.EX_HAND_SIZE)
    side.exDeck = order.slice(CFG.EX_HAND_SIZE)
    side.exDiscard = []
  }
}

/** 阵亡角色从三个牌区移除，空出的窗口立即补牌。 */
function syncExWindow(state, sideIndex) {
  const side = state.sides[sideIndex]
  const order = initialExOrder(state, sideIndex)

  const live = new Set(side.units.filter((u) => u.alive).map((u) => u.idx))
  const seen = new Set()
  const clean = (cards) => cards.filter((pos) => {
    if (!Number.isInteger(pos) || !live.has(pos) || seen.has(pos)) return false
    seen.add(pos)
    return true
  })
  side.exHand = clean(side.exHand)
  side.exDeck = clean(side.exDeck)
  side.exDiscard = clean(side.exDiscard)

  // 始终维持每名存活角色恰好一张牌；缺失牌按初始牌序回到牌库。
  for (const pos of order) {
    if (live.has(pos) && !seen.has(pos)) {
      side.exDeck.push(pos)
      seen.add(pos)
    }
  }

  const target = Math.min(CFG.EX_HAND_SIZE, live.size)
  while (side.exHand.length < target) {
    if (!side.exDeck.length) {
      if (!side.exDiscard.length) break
      side.exDeck = side.exDiscard
      side.exDiscard = []
    }
    side.exHand.push(side.exDeck.shift())
  }

  return side
}

function syncAllExWindows(state) {
  for (let side = 0; side < state.sides.length; side++) syncExWindow(state, side)
}

function pruneInvalidDots(state) {
  for (const side of state.sides) {
    for (const target of side.units) {
      if (!target.alive) {
        target.dots = []
        continue
      }
      target.dots = target.dots.filter((dot) =>
        Boolean(state.sides[dot.srcSide]?.units[dot.srcPos])
      )
    }
  }
}

function cycleExCard(state, sideIndex, pos) {
  const side = syncExWindow(state, sideIndex)
  const i = side.exHand.indexOf(pos)
  if (i < 0) return false
  side.exHand.splice(i, 1)
  if (side.units[pos]?.alive) side.exDiscard.push(pos)
  syncExWindow(state, sideIndex)
  return true
}

/** 不修改传入状态，返回一侧当前可见的 0-based 角色位置。 */
export function exHandOf(state, sideIndex) {
  const copy = structuredClone(state)
  return [...syncExWindow(copy, sideIndex).exHand]
}

/**
 * 不修改传入状态，返回当前窗口用牌后会依次补入的公开牌序。
 * 牌库见底后弃牌区会按使用顺序接回，因此两区直接拼接就是当前可预见顺序。
 */
export function exDrawQueueOf(state, sideIndex) {
  const copy = structuredClone(state)
  const side = syncExWindow(copy, sideIndex)
  return [...side.exDeck, ...side.exDiscard]
}

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
    // 角色表中的生命就是战斗实际最大生命，不再经过隐藏倍率换算。
    maxhp: tmpl.hp,
    hp: tmpl.hp,
    shield: 0, shieldMax: 0, shieldTurns: 0, shieldTickSide: 1 - side, shieldSt: -1,
    buffs: [], dots: [],
    stun: 0, stunSt: -1,
    taunt: 0, tauntSt: -1,
    reflect: 0, reflectTurns: 0, reflectSt: -1,
    skillCd: tmpl.skill?.cd ?? 99,
    alive: true,
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
    seed,
    rng: seed,
    round: 1,
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
  initializeExWindows(state)
  // 后手方开局补偿：技能牌窗口版扫描 0~3 后，3 点最接近五五开。
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

/** 角色统一命中对当前目标的命中率。 */
function hitRate(src, tgt) {
  const dr = Math.min(
    CFG.DODGE_CAP,
    Math.max(0, (tmplOf(tgt).dodge - tmplOf(src).acc) / CFG.DODGE_K)
  )
  return 1 - dr
}

function estDamage(src, tgt, mult) {
  const raw = (
    atkOf(src) * mult *
    affinity(tmplOf(src).atkType, tmplOf(tgt).defType) *
    (CFG.DEF_K / (CFG.DEF_K + dfsOf(tgt)))
  )
  return raw * hitRate(src, tgt)
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

function applyDamage(ctx, src, tgt, dmg, crit = false, aff = 1.0, eventMeta = {}) {
  let absorbed = 0
  if (tgt.shield > 0) {
    absorbed = Math.min(tgt.shield, dmg)
    tgt.shield -= absorbed
    dmg -= absorbed
    if (tgt.shield <= 0) {
      tgt.shield = 0
      tgt.shieldMax = 0
      tgt.shieldTurns = 0
    }
  }
  tgt.hp -= dmg

  emitEvent(ctx, {
    type: "damage",
    source: unitRef(eventMeta.sourceUnit || src),
    target: unitRef(tgt),
    amount: Math.round(dmg),
    absorbed: Math.round(absorbed),
    crit,
    affinity: affinityMark(aff),
    attackType: eventMeta.attackType || (src ? tmplOf(src).atkType : "持续"),
    reflected: Boolean(eventMeta.reflected),
    burn: Boolean(eventMeta.burn),
  })

  const tag =
    (crit ? "暴击" : "") +
    (aff > 1.01 ? "·克制" : aff < 0.99 ? "·抵抗" : "") +
    (eventMeta.burn ? "·灼烧" : "")
  const ab = absorbed > 0 ? `（护盾吸收 ${Math.round(absorbed)}）` : ""
  ctx.log(`  ${src ? nameOf(src) : "持续伤害"} → ${nameOf(tgt)} ${Math.round(dmg)}${ab} ${tag}`.trimEnd())

  if (tgt.hp <= 0) {
    tgt.hp = 0
    tgt.alive = false
    tgt.taunt = 0
    ctx.log(`  ✝ ${nameOf(tgt)} 倒下`)
  }
}

/**
 * 灼烧不再在目标回合末独立跳伤害，而是在施加者后续行动时点各触发一次。
 * 若施加者正常攻击则并入该行动；若眩晕、阵亡或没有伤害行动则建立灼烧专用事件组。
 * 灼烧直接调用 applyDamage，不经过 deal 的命中判定，因此固定命中。
 */
function triggerBurns(ctx, src, standalone = false) {
  const { state } = ctx
  const T = state.turnId
  const foes = state.sides[1 - src.side]
  const pending = []
  for (const tgt of foes.units) {
    if (!tgt.alive) continue
    for (const dot of [...tgt.dots]) {
      if (dot.srcSide !== src.side || dot.srcPos !== src.idx) continue
      if (dot.st === T || dot.lastProcTurn === T) continue
      pending.push([tgt, dot])
    }
  }
  if (!pending.length) return false

  if (standalone) {
    ctx.log(`[${src.side === 0 ? "蓝" : "红"}] ${nameOf(src)} 灼烧结算`)
    const targets = [...new Map(pending.map(([tgt]) => [`${tgt.side}:${tgt.idx}`, unitRef(tgt)])).values()]
    emitEvent(ctx, {
      type: "action",
      source: unitRef(src),
      action: "burn",
      kind: "damage",
      targetType: "burn",
      targets,
    })
  }

  for (const [tgt, dot] of pending) {
    if (!tgt.alive || !tgt.dots.includes(dot)) continue
    dot.lastProcTurn = T
    applyDamage(
      ctx,
      src,
      tgt,
      dot.srcAtk * dot.value * (1 + sdDmg(state)),
      false,
      1.0,
      { attackType: "持续", burn: true }
    )
    dot.turns -= 1
    if (dot.turns <= 0) tgt.dots.splice(tgt.dots.indexOf(dot), 1)
    if (!tgt.alive) tgt.dots.length = 0
  }
  return true
}

function deal(ctx, src, tgt, mult, eff, mod = 1.0) {
  const { state } = ctx
  if (!tgt.alive || !src.alive) return 0

  // 每名角色只有一个统一命中值，普攻、普通技能与 EX 全部读取它。
  const dr = 1 - hitRate(src, tgt)
  if (dr > 0 && nextRandom(state) < dr) {
    ctx.log(`  ${nameOf(tgt)} 闪避了 ${nameOf(src)}`)
    emitEvent(ctx, {
      type: "miss",
      source: unitRef(src),
      target: unitRef(tgt),
      attackType: tmplOf(src).atkType,
    })
    return 0
  }

  const cr = Math.min(CFG.CRIT_CAP, Math.max(0, tmplOf(src).crit * factorOf(src, "crit")))
  const crit = eff.forceCrit ? true : nextRandom(state) < cr

  const aff = affinity(tmplOf(src).atkType, tmplOf(tgt).defType)
  let dmg = atkOf(src) * mult * mod * aff * (CFG.DEF_K / (CFG.DEF_K + dfsOf(tgt)))

  const eb = eff.execBonus
  if (eb && tgt.hp / tgt.maxhp <= eb[0]) dmg *= eb[1]

  dmg *= Math.max(0.1, factorOf(src, "dmg_deal"))
  dmg *= Math.max(0.1, factorOf(tgt, "dmg_take"))
  dmg *= 1 + sdDmg(state)
  if (crit) dmg *= CFG.CRIT_DMG * Math.max(0.1, factorOf(src, "crit_dmg"))
  if (CFG.DMG_JITTER) dmg *= 1 + randRange(state, -CFG.DMG_JITTER, CFG.DMG_JITTER)
  dmg = Math.max(1, dmg)

  applyDamage(ctx, src, tgt, dmg, crit, aff)

  if (tgt.reflect > 0 && tgt.alive && src.alive) {
    const r = dmg * tgt.reflect
    ctx.log(`  ⟲ ${nameOf(tgt)} 反伤 ${Math.round(r)}`)
    applyDamage(ctx, null, src, r, false, 1.0, {
      sourceUnit: tgt,
      attackType: tmplOf(tgt).atkType,
      reflected: true,
    })
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
    emitEvent(ctx, {
      type: "heal",
      source: unitRef(src),
      target: unitRef(tgt),
      amount: Math.round(h),
    })
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
  emitEvent(ctx, {
    type: "action",
    source: unitRef(u),
    action: label.startsWith("EX") ? "ex" : label === "普通技能" ? "skill" : "normal",
    kind: eff.kind || "damage",
    targetType: eff.target || "lane",
    targets: tgs.map((target) => unitRef(Array.isArray(target) ? target[0] : target)),
  })
  const T = state.turnId

  if ((eff.kind || "damage") === "damage") {
    const mult = eff.mult
    const dotsToApply = []
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
          const hit = deal(ctx, u, tgt, mult + eff.detonate, eff) > 0
          if (hit) tgt.dots.length = 0
        } else {
          deal(ctx, u, tgt, mult, eff)
        }
        if (!tgt.alive) continue
        // 附加 debuff 是技能效果而非弹体伤害：伤害未命中时仍然施加。
        // 降防、易伤等属性减益立刻影响本回合后续攻击；MISS 也不阻止附加效果。
        for (const db of eff.debuffs || []) {
          upsertStatusLayer(tgt.buffs, timedEnemyDebuff(db, T, u, tgt.side))
        }
        if (eff.dot) {
          dotsToApply.push([tgt, {
            value: eff.dot.value,
            turns: eff.dot.turns,
            srcAtk: atkOf(u),
            srcSide: u.side,
            srcPos: u.idx,
            sourceKey: sourceKeyOf(u.side, u.idx),
            effectKind: "dot",
            st: T,
          }])
        }
        if (eff.stun) { tgt.stun = Math.max(tgt.stun, eff.stun); tgt.stunSt = T }
        if (eff.debuffs?.length || eff.dot || eff.stun) {
          emitEvent(ctx, {
            type: "debuff",
            source: unitRef(u),
            target: unitRef(tgt),
            effects: [
              ...(eff.debuffs || []).map((debuff) => debuff.stat),
              ...(eff.dot ? ["dot"] : []),
              ...(eff.stun ? ["stun"] : []),
            ],
          })
        }
      }
    }
    // 先结算同一施加者已有的灼烧，再用本次新灼烧刷新该来源的层；这样刷新
    // 不会吞掉原本应在本次攻击中触发的最后一跳。
    // 命中的引爆会先清除灼烧；未命中的目标仍照常受到本回合的必中灼烧。
    triggerBurns(ctx, u)
    for (const [target, dot] of dotsToApply) {
      if (target.alive) upsertDotLayer(target.dots, dot)
    }
  } else {
    for (const tgt of tgs) {
      if (eff.heal) heal(ctx, u, tgt, atkOf(u) * eff.heal)
      if (eff.shield) {
        // 重复施加只把护盾恢复为本次的新容量并刷新时长，不与旧护盾叠加。
        const amount = Math.max(0, atkOf(u) * eff.shield * sdHeal(state))
        tgt.shield = amount
        tgt.shieldMax = amount
        tgt.shieldTurns = eff.shieldTurns ?? 2
        tgt.shieldTickSide = 1 - tgt.side
        tgt.shieldSt = T
        ctx.log(`  ${nameOf(tgt)} 获得护盾 ${Math.round(amount)}（${tgt.shieldTurns}回合）`)
        emitEvent(ctx, {
          type: "shield",
          source: unitRef(u),
          target: unitRef(tgt),
          amount: Math.round(amount),
          turns: tgt.shieldTurns,
        })
      }
      if (eff.cleanse) {
        tgt.buffs = tgt.buffs.filter((status) => status.effectKind !== "debuff")
        tgt.dots.length = 0
      }
      if (eff.taunt) { tgt.taunt = eff.taunt; tgt.tauntSt = T }
      if (eff.reflect) {
        tgt.reflect = eff.reflect
        tgt.reflectTurns = eff.reflectTurns ?? 1
        tgt.reflectSt = T
      }
      for (const b of eff.buffs || []) {
        upsertStatusLayer(tgt.buffs, timedFriendlyBuff(b, T, u))
      }
      if (eff.cleanse || eff.taunt || eff.reflect || eff.buffs?.length) {
        emitEvent(ctx, {
          type: "buff",
          source: unitRef(u),
          target: unitRef(tgt),
          effects: [
            ...(eff.cleanse ? ["cleanse"] : []),
            ...(eff.taunt ? ["taunt"] : []),
            ...(eff.reflect ? ["reflect"] : []),
            ...(eff.buffs || []).map((buff) => buff.stat),
          ],
        })
      }
    }
  }

  // 回费是技能自身效果，不依赖伤害是否命中；自动行动阶段获得的 Cost 留到后续回合使用。
  if (eff.costGain) {
    const before = me.cost
    me.cost = Math.min(CFG.COST_MAX, me.cost + eff.costGain)
    const recovered = me.cost - before
    ctx.skillCostGained = (ctx.skillCostGained || 0) + recovered
    ctx.log(`  ${nameOf(u)} 回复 Cost ${recovered}${recovered < eff.costGain ? `（溢出 ${eff.costGain - recovered}）` : ""}`)
    if (recovered > 0) {
      emitEvent(ctx, {
        type: "cost",
        source: unitRef(u),
        target: unitRef(u),
        amount: recovered,
      })
    }
  }
  for (const b of eff.selfBuffs || []) {
    upsertStatusLayer(u.buffs, timedFriendlyBuff(b, T, u))
  }
  if (eff.selfBuffs?.length) {
    emitEvent(ctx, {
      type: "buff",
      source: unitRef(u),
      target: unitRef(u),
      effects: eff.selfBuffs.map((buff) => buff.stat),
    })
  }
  if (eff.selfHeal) heal(ctx, u, u, atkOf(u) * eff.selfHeal)
}

// ---------------- 回合结算 ----------------

/**
 * 状态都从施放瞬间写入。友方进攻 Buff 与降防/易伤跟随施放方的攻击窗口计时，
 * 当前回合算第 1 回合；护盾按敌方实际攻击窗口计时，其余控制与防御状态跟随目标
 * 实际行动窗口计时。灼烧在攻击内结算。
 */
function endTurn(ctx, side) {
  const { state } = ctx
  const T = state.turnId
  const tickingSide = side.units[0]?.side ?? state.activeSide

  // Buff 可能挂在敌方身上却跟随施放方的攻击窗口倒计时，因此单独扫描双方。
  for (const affectedSide of state.sides) {
    for (const u of affectedSide.units) {
      if (!u.alive) continue
      for (const b of [...u.buffs]) {
        const tickSide = Number.isInteger(b.tickSide) ? b.tickSide : u.side
        if (tickSide !== tickingSide || b.turns >= 9999) continue
        if (b.st === T && !b.countCurrent) continue
        b.turns -= 1
        if (b.turns <= 0) u.buffs.splice(u.buffs.indexOf(b), 1)
      }

      const shieldTickSide = Number.isInteger(u.shieldTickSide) ? u.shieldTickSide : 1 - u.side
      if (u.shieldTurns > 0 && shieldTickSide === tickingSide && u.shieldSt !== T) {
        u.shieldTurns -= 1
        if (u.shieldTurns <= 0) {
          u.shield = 0
          u.shieldMax = 0
          u.shieldTurns = 0
        }
      }
    }
  }

  for (const u of side.units) {
    if (!u.alive) continue

    if (u.stun > 0 && u.stunSt !== T) u.stun -= 1
    if (u.taunt > 0 && u.tauntSt !== T) u.taunt -= 1
    if (u.reflectTurns > 0 && u.reflectSt !== T) {
      u.reflectTurns -= 1
      if (u.reflectTurns === 0) u.reflect = 0
    }
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
  return CFG.COST_REGEN + CFG.COST_REGEN_PER_UNIT * n
}

/** 当前行动方在本回合完成自动回复后，实际可用的 Cost。 */
export function turnCostOf(side) {
  const gain = Math.floor((Number(side.regenAcc) || 0) + regenOf(side))
  return Math.min(CFG.COST_MAX, side.cost + gain)
}

/** 校验一条指令能不能执行，返回错误文案或 null。不改动 state。 */
export function validateAction(state, action) {
  if (state.phase !== "command") return "这局已经结束了"
  if (action.type === "pass") return null

  const draft = structuredClone(state)
  syncAllExWindows(draft)
  const sideIndex = draft.activeSide
  const side = draft.sides[sideIndex]
  // 玩家指令触发结算后会先回复 Cost，校验必须使用同一个回合起始预算。
  let budget = turnCostOf(side)
  const exActors = new Set()

  for (const cast of action.casts) {
    const u = side.units[cast.pos]
    if (!u) return `没有 ${cast.pos + 1} 号位`
    if (!u.alive) return `${nameOf(u)} 已经倒下了`
    if (exActors.has(cast.pos)) return `${nameOf(u)} 本回合已经释放过 EX`
    if (!side.exHand.includes(cast.pos)) {
      const cards = side.exHand
        .map((pos) => `${pos + 1}.${nameOf(side.units[pos])}(${tmplOf(side.units[pos]).ex.cost}费)`)
        .join(" / ") || "无"
      return `${nameOf(u)} 当前不在 EX 窗口；现在可用：${cards}`
    }
    if (u.stun > 0) return `${nameOf(u)} 被眩晕，放不出 EX`
    const cost = tmplOf(u).ex.cost
    if (budget < cost) {
      return `Cost 不够：${nameOf(u)} 要 ${cost} 点，你还剩 ${budget} 点`
    }
    budget -= cost
    side.cost = budget
    exActors.add(cast.pos)
    cycleExCard(draft, sideIndex, cast.pos)
  }
  return null
}

/**
 * 打完当前行动方的一个回合。
 * @param {object} prev 战斗状态（不会被修改）
 * @param {{type:'pass'}|{type:'ex', casts:Array<{pos:number, target?:object}>}} action
 * @returns {{state:object, log:string[], events:object[], round?:number, error?:string}} round 是刚结算回合所属轮数，events 保留逐段命中供 Canvas 绘制
 */
export function playerTurn(prev, action) {
  const err = validateAction(prev, action)
  if (err) return { state: prev, log: [], error: err }

  const state = structuredClone(prev)
  syncAllExWindows(state)
  const lines = []
  const events = []
  const ctx = { state, log: (s) => lines.push(s), emit: (event) => events.push(event) }

  const side = state.sides[state.activeSide]
  const tag = state.activeSide === 0 ? "蓝" : "红"

  const actionRound = state.round
  state.turnId += 1

  // ① Cost 回复；createBattle 保留开局 0/3，正式进入回合后才在这里结算。
  const costAtStart = side.cost
  side.regenAcc += regenOf(side)
  const gain = Math.floor(side.regenAcc)
  side.regenAcc -= gain
  side.cost = Math.min(CFG.COST_MAX, side.cost + gain)
  const gained = side.cost - costAtStart // 撞上限时实际到手会少于 gain
  let spent = 0

  const done = () => {
    syncAllExWindows(state)
    pruneInvalidDots(state)
    return {
      state,
      log: lines,
      events,
      costBefore: costAtStart,
      gained,
      skillGained: ctx.skillCostGained || 0,
      spent,
      round: actionRound,
    }
  }

  lines.push(`--- ${tag}方回合（Cost ${side.cost}）---`)

  // ② 玩家指令：EX
  let usedEx = false
  const exActors = new Set()
  if (action.type === "ex") {
    for (const cast of action.casts) {
      const u = side.units[cast.pos]
      if (!u.alive || u.stun > 0 || !side.exHand.includes(cast.pos)) continue
      const ex = tmplOf(u).ex
      if (side.cost < ex.cost) continue
      side.cost -= ex.cost
      spent += ex.cost
      cycleExCard(state, state.activeSide, cast.pos)
      usedEx = true
      exActors.add(cast.pos)
      execute(ctx, u, ex, `EX(-${ex.cost})`, cast.target)
      if (checkEnd(state)) { settle(state); return done() }
    }
  }
  if (!usedEx) lines.push(`[${tag}] 过`)

  // ③ 己方角色按位置 1→4 依次自动行动
  for (const u of side.units) {
    if (sideDead(state.sides[1 - state.activeSide])) break
    if (!u.alive) {
      triggerBurns(ctx, u, true)
      if (checkEnd(state)) { settle(state); return done() }
      continue
    }
    // 同一角色每回合只走一条行动分支：已经释放 EX，就不再自动放普技或普攻。
    if (exActors.has(u.idx)) {
      // 伤害 EX 已在 execute 内触发；无伤害 EX 则在原自动行动时点补做灼烧结算。
      triggerBurns(ctx, u, true)
      if (checkEnd(state)) { settle(state); return done() }
      continue
    }
    const tmpl = tmplOf(u)
    if (u.stun > 0) {
      if (u.skillCd <= 0) {
        // 小技能已经轮到就绪点：即使被眩晕打断，也视为本回合释放过并重新进入冷却。
        u.skillCd = tmpl.skill.cd
        lines.push(`[${tag}] ${nameOf(u)} 眩晕，普通技能被吞掉并进入冷却`)
      } else {
        lines.push(`[${tag}] ${nameOf(u)} 眩晕，无法行动`)
      }
      triggerBurns(ctx, u, true)
      if (checkEnd(state)) { settle(state); return done() }
      continue
    }
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
  if (state.activeSide === state.first) {
    if (state.round >= CFG.MAX_ROUND) settle(state)
    else state.round += 1
  }
  return done()
}

export { nameOf, tmplOf, aliveOf, sideDead }
