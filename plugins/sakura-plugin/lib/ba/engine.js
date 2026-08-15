/**
 * 碧蓝档案 · 回合制群战 —— 战斗内核
 *
 * 纯函数模块：不碰 Redis、不碰 e.reply，只做 (state, action) => { state, log, events }。
 * 状态全部可 JSON 序列化，能直接存进 Redis 再取出来接着打。
 *
 * 伤害、命中、暴击、防御、稳定值五条公式全部照搬官方实现（见 roster.js 的 CFG 注释）。
 * 与原作的唯一结构性差异：原作是实时战斗，这里是回合制，因此
 *   - 秒 → 回合按 1 回合 = 5 秒折算（角色普攻循环实测 4~6.5 秒，与之吻合）
 *   - 射程/位置/移动/击退全部无对应物，已在生成阶段丢弃
 *   - 范围技能的几何形状塌缩成「打几个目标」，见 roster 里的 target/count
 */

import { CFG, BY_ID, SUMMONS, affinity } from "./roster.js"

// ---------------- 随机数 ----------------
// 种子存进 state，整场战斗可复现：群友吵「凭什么这刀没暴击」时用同一个种子重放即可

function nextRandom(state) {
  // mulberry32
  let t = (state.rng = (state.rng + 0x6d2b79f5) >>> 0)
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const randRange = (state, lo, hi) => lo + nextRandom(state) * (hi - lo)
const randPick = (state, arr) => arr[Math.floor(nextRandom(state) * arr.length)]

// ---------------- 单位读取 ----------------

// 召唤物走 SUMMONS 表，其余一切（面板、命中、克制）照常走 tmplOf，不用到处加分支
const tmplOf = (u) => (u.summon ? SUMMONS[u.id] : BY_ID[u.id])
const nameOf = (u) => tmplOf(u).name
/** 存活判定只看 units —— 召唤物不进这里，所以 sideDead / settle / EX 冷却天然不算它 */
const aliveOf = (side) => side.units.filter((u) => u.alive)
const sideDead = (side) => side.units.every((u) => !u.alive)
const summonsOf = (side) => (side.summons || []).filter((s) => s.alive)

const unitRef = (u) => (u ? { side: u.side, pos: u.idx, ...(u.summon ? { summon: true } : {}) } : null)

function affinityMark(value) {
  if (value > 1.01) return "weak"
  if (value < 0.99) return "resist"
  return "normal"
}

const emitEvent = (ctx, event) => ctx.emit?.(event)
const sourceKeyOf = (side, pos) => `${side}:${pos}`

// ---------------- 状态层 ----------------

/**
 * 两个状态是不是占同一个槽位。
 *
 * **优先按原作的 `Channel` 判**：它就是槽位号，同槽后来的顶掉先来的、不同槽才共存。
 * 一个 Channel 只装一种属性且正负不混（全 272 人零例外），所以 channel 本身就够唯一。
 * 真纪和茜的减防都是 Channel 603 —— 原作里它们**不叠**，后放的顶掉先放的。
 *
 * 没有 Channel 的退回「按施加者分层」：白热化的全局减益，以及原数据本来就不带
 * Channel 的 `DamageDebuff`（30 个）。
 */
function sameStatusLayer(a, b) {
  if (a.channel != null && b.channel != null) return a.channel === b.channel
  return Boolean(a.sourceKey && b.sourceKey) &&
    a.sourceKey === b.sourceKey && a.effectKind === b.effectKind && a.stat === b.stat
}

/**
 * 同槽只留一层（判据见 sameStatusLayer），**后放的直接覆盖先放的**，不比大小。
 *
 * 代价是队友会互相拆台：茜的 EX 先减 29%，真纪的普技随后减 18%，最终只剩 18%。
 * 这是槽位制的固有性质，不是 bug —— 同槽的两个减防角色本来就不该同队，
 * 站位和出手顺序（EX 永远先于普通技能结算）都会影响最后留下的是哪一层。
 */
function upsertStatusLayer(list, next) {
  const first = list.findIndex((cur) => sameStatusLayer(cur, next))
  if (first < 0) { list.push(next); return next }
  list[first] = next
  for (let i = list.length - 1; i > first; i--) if (sameStatusLayer(list[i], next)) list.splice(i, 1)
  return next
}

/** 不同施加者的同类百分比状态逐层乘算。 */
function factorOf(u, stat) {
  let f = 1
  for (const s of u.buffs) if (s.stat === stat) f *= 1 + s.value
  return f
}

/** 同名固定值加成逐层相加。 */
function flatOf(u, stat) {
  let v = 0
  for (const s of u.buffs) if (s.stat === stat) v += s.value
  return v
}

// 进攻类增益影响施放后的本回合行动，因此施放回合就算第 1 回合
const CURRENT_TURN_STATS = new Set(["atk", "dmg_deal", "crit", "crit_dmg", "dfs", "dmg_take"])

/** 控制类效果的中文名。原数据只给英文 Icon，写死一张表比逐个判断可靠 */
const CC_TEXT = {
  Stunned: "眩晕", Fear: "恐惧", Provoke: "嘲讽", Slow: "减速",
  Confuse: "混乱", Sleep: "睡眠", Silence: "沉默", Bind: "束缚",
}

/** 持续伤害的中文名。Zone 是「固定场地」，其余取自原数据的 Icon */
const DOT_TEXT = {
  Zone: "范围持续伤害", Burn: "灼烧", Poison: "中毒",
  Chill: "冰冻", ElectricShock: "感电",
}

const STAT_LABEL = {
  atk: "攻击力", atk_flat: "攻击力", dfs: "防御力", dfs_flat: "防御力",
  heal: "治疗力", heal_flat: "治疗力", maxhp: "生命上限", maxhp_flat: "生命上限",
  crit: "暴击值", crit_dmg: "暴击伤害", crit_dmg_flat: "暴击伤害",
  acc: "命中值", dodge: "闪避值", dmg_deal: "造成伤害", dmg_take: "受到伤害",
  heal_taken: "受治疗量",
  crit_res: "暴击抵抗", crit_dmg_res_flat: "暴伤抵抗",
}

function makeStatus(eff, turnId, source, kind) {
  return {
    stat: eff.stat, value: eff.value, turns: eff.turns ?? 2,
    effectKind: kind,
    sourceKey: sourceKeyOf(source.side, source.idx),
    srcSide: source.side, srcPos: source.idx,
    st: turnId,
    countCurrent: CURRENT_TURN_STATS.has(eff.stat),
    channel: eff.channel ?? null, // 原作的槽位号，见 sameStatusLayer
  }
}

// ---------------- 面板（基础值 × 各来源修正层）----------------

export const atkOf = (u) => tmplOf(u).atk * Math.max(0.2, factorOf(u, "atk")) + flatOf(u, "atk_flat")
export const dfsOf = (u) => Math.max(0, tmplOf(u).dfs * Math.max(0.2, factorOf(u, "dfs")) + flatOf(u, "dfs_flat"))
export const healOf = (u) => tmplOf(u).healPower * Math.max(0.2, factorOf(u, "heal")) + flatOf(u, "heal_flat")
const accOf = (u) => tmplOf(u).acc * Math.max(0.2, factorOf(u, "acc"))
const dodgeOf = (u) => tmplOf(u).dodge * Math.max(0.2, factorOf(u, "dodge"))
const critOf = (u) => tmplOf(u).crit * Math.max(0, factorOf(u, "crit"))
const critDmgOf = (u) => tmplOf(u).critDmg * Math.max(0, factorOf(u, "crit_dmg")) + flatOf(u, "crit_dmg_flat")

// ---------------- 官方战斗公式 ----------------

/** 防御系数（乘在伤害上，不是减伤率）：DEF_BASE / (防御 × DEF_C + DEF_BASE) */
const defModOf = (tgt) => CFG.DEF_BASE / (dfsOf(tgt) * CFG.DEF_C + CFG.DEF_BASE)

/** 命中率：命中值 ≥ 闪避值时必中，否则 HIT_BASE / (差值 × HIT_C + HIT_BASE) */
function hitChance(src, tgt) {
  const gap = Math.max(dodgeOf(tgt) - accOf(src), 0)
  return Math.min(1, Math.max(0, CFG.HIT_BASE / (gap * CFG.HIT_C + CFG.HIT_BASE)))
}

// 两项抵抗都要过 buff 层：爱用品强化后的普通技能会给它们上增益
// （星野的急救治疗+ 加暴伤抵抗，绫音的加暴击抵抗），直接读模板常量就吃不到
const critResOf = (u) => Math.max(0, tmplOf(u).critRes * Math.max(0, factorOf(u, "crit_res")))
const critDmgResOf = (u) => Math.max(0, tmplOf(u).critDmgRes + flatOf(u, "crit_dmg_res_flat"))

/** 暴击率：1 − CRIT_BASE / ((暴击值 − 目标暴击抵抗) × CRIT_C + CRIT_BASE)，取不到 100% */
function critChance(src, tgt) {
  const gap = Math.max(critOf(src) - critResOf(tgt), 0)
  return Math.min(1, Math.max(0, 1 - CFG.CRIT_BASE / (gap * CFG.CRIT_C + CFG.CRIT_BASE)))
}

/** 暴击倍率：(暴击伤害 − 目标暴伤抵抗) / 10000 */
const critMultOf = (src, tgt) => Math.max(1, (critDmgOf(src) - critDmgResOf(tgt)) / 10000)

/** 伤害浮动下限：稳定值/(稳定值+STAB_BASE) + 稳定率/10000，实际伤害在 [下限, 1] 均匀分布 */
function stabilityFloor(src) {
  const sp = tmplOf(src).stability
  return Math.min(1, Math.max(0, sp / (sp + CFG.STAB_BASE) + CFG.DEFAULT_STAB_RATE / 10000))
}

// ---------------- EX 冷却 ----------------

/**
 * 四个角色的 EX 随时可选，但放完要压一段冷却，冷却按「本方之后又放了几个 EX」计，
 * 不按回合计：长度 = 存活人数 − 2。
 *
 * 满编 4 人时放完要等另外 2 个 EX 才轮回来，等价于同一个人最快隔 2 次 EX；
 * 死到只剩 2 人时长度归零，剩下的人可以连放 —— 人越少越不该被冷却锁死。
 */
export const exLockLenOf = (side) => Math.max(0, aliveOf(side).length - CFG.EX_COOLDOWN_SLACK)

/** 距离解锁还差几个 EX，0 表示现在就能放 */
export function exWaitOf(side, u) {
  if (!u.exCastNo) return 0
  return Math.max(0, exLockLenOf(side) - (side.exCasts - u.exCastNo))
}

export const exReadyOf = (side, u) => u.alive && exWaitOf(side, u) === 0

/** 不修改传入状态，返回一侧当前能放 EX 的 0-based 角色位置（只看冷却，不含本回合已放 / Cost）。 */
export function exAvailableOf(state, sideIndex) {
  const side = state.sides[sideIndex]
  return side.units.filter((u) => exReadyOf(side, u)).map((u) => u.idx)
}

/**
 * 这一步真正能出手的 EX：冷却好、没晕、本回合还没放过、Cost 也够。
 * 放完一发后用它决定要不要停下来等玩家再操作。
 */
export function exCastableOf(state, sideIndex) {
  const side = state.sides[sideIndex]
  const used = new Set(state.turnEx || [])
  const budget = turnCostOf(side)
  return side.units
    .filter((u) => exReadyOf(side, u) && u.stun <= 0 && !used.has(u.idx) && tmplOf(u).ex.cost <= budget)
    .map((u) => u.idx)
}

/** 记一次 EX 释放，把释放者压进冷却 */
function markExCast(side, u) {
  side.exCasts = (side.exCasts || 0) + 1
  u.exCastNo = side.exCasts
}

/**
 * 己方回合开始时若比上个回合少了人，直接清空全部冷却。
 *
 * 没有这一条的话，减员会让冷却长度缩短、却缩不掉已经欠下的等待，
 * 出现「全队都在冷却、这一回合谁都放不出 EX」的死局。
 * validateAction 与 playerTurn 都要先跑一遍，否则校验和结算会对不上。
 */
function refreshExOnCasualty(side, log) {
  const now = aliveOf(side).length
  const dropped = side.lastAlive != null && now < side.lastAlive
  side.lastAlive = now
  if (!dropped) return false
  side.exCasts = 0
  for (const u of side.units) u.exCastNo = 0
  log?.()
  return true
}

// ---------------- 白热化 / FEVER TIME ----------------

/**
 * 原作的白热化在「剩余时间不足 1 分钟」时进入，不是打满多少回合触发。
 *
 * 判定用**轮数**而不是 turnId：原作双方是同时打的，蓝回合与红回合是同一段 5 秒的
 * 两次呈现，所以流逝的秒数 = 轮数 × 5。按 1 轮 = 5 秒折算，总时长 4 分钟 = 48 轮，
 * 白热化从第 36 轮起。冷却与状态时长走的也是这把尺子（只在自己方回合跳，一轮正好
 * 跳一次），两边口径必须一致，改成 turnId 就又差了 2 倍。
 *
 * 原作的**基础效果只有一条**：EX Cost 攒得明显更快。
 * 防御 / 闪避 / 受治疗下降是赛季附加规则（S10、S11 都带），一并抄了，
 * 不想要把 CFG.FEVER_DEBUFF 设成 0 即可。
 */
const feverOn = (state) => state.round >= CFG.FEVER_ROUND

/**
 * 进入白热化时给全场挂一次永久减益。
 * 走 buff 系统而不是在伤害公式里加系数：状态格会自动画出来，玩家能看见发生了什么。
 */
function enterFever(ctx) {
  const { state } = ctx
  if (state.fever || !feverOn(state)) return
  state.fever = true
  if (CFG.FEVER_DEBUFF > 0) {
    for (const s of state.sides) {
      for (const u of s.units) {
        for (const stat of ["dfs", "dodge", "heal_taken"]) {
          u.buffs.push({
            stat, value: -CFG.FEVER_DEBUFF, turns: 9999, st: -1,
            srcSide: u.side, effectKind: "fever", sourceKey: "fever",
          })
        }
      }
    }
  }
  ctx.log(`🔥 白热化：Cost 回复 ×${CFG.FEVER_COST_MULT}` +
    (CFG.FEVER_DEBUFF > 0 ? `，全场防御 / 闪避 / 受治疗 −${Math.round(CFG.FEVER_DEBUFF * 100)}%` : ""))
}

// ---------------- 建局 ----------------

function makeUnit(tmpl, idx, side) {
  return {
    id: tmpl.id, idx, side,
    maxhp: tmpl.hp, hp: tmpl.hp,
    shield: 0, shieldMax: 0, shieldTurns: 0, shieldTickSide: 1 - side, shieldSt: -1,
    buffs: [], regens: [],
    // 持续伤害（场地/灼烧）。跟施加者解绑：他阵亡、被控都照跳，所以只存算好的数值
    dots: [],
    stun: 0, stunSt: -1, stunIcon: null,
    taunt: 0, tauntSt: -1,
    // 普通技能：「每 X 秒」是周期，第一次落在 X 秒而不是开局，所以起始压满冷却；
    // 条件型（血量阈值）等条件满足，用 99 表示「不靠冷却解锁」
    skillCd: tmpl.skill?.trigger?.type === "cooldown" ? tmpl.skill.trigger.turns : 99,
    skillUses: 0,
    // 换弹强化：{shots, mult, count}，鹤城 EX 之后的两发普攻走这个
    charge: null,
    // 本方第几个 EX 是这个人放的；0 表示还没放过，开局全员可放
    exCastNo: 0,
    alive: true,
  }
}

/**
 * @param {{uid, name, picks: string[]}} a 蓝方（picks 是 4 个角色 id，顺序即 1~4 号位）
 * @param {{uid, name, picks: string[]}} b 红方
 * @param {{first?: 0|1, seed?: number}} opts
 */
export function createBattle(a, b, opts = {}) {
  const seed = opts.seed ?? (Math.random() * 0xffffffff) >>> 0
  const state = {
    seed, rng: seed, round: 1, turnId: 0,
    first: opts.first ?? 0, activeSide: opts.first ?? 0,
    phase: "command", winner: null, fever: false,
    // 本回合已开但还没「过」：已经放过的 EX 记在 turnEx 里，技能和普攻等过了再跑
    turnOpen: false, turnEx: [],
    sides: [a, b].map((s, side) => ({
      side, uid: String(s.uid), name: s.name || String(s.uid),
      cost: CFG.COST_START, regenAcc: 0,
      exCasts: 0, lastAlive: s.picks.length,
      summons: [],
      // 场地是留在地上的区域，不是贴在人身上的状态。覆盖范围按技能规则算，
      // 人死了圈也不跟着缩、更不会换人（回合制没有「走进场地」）。
      fields: [],
      units: s.picks.map((id, i) => makeUnit(BY_ID[id], i, side)),
    })),
  }
  state.sides[1 - state.first].cost += CFG.SECOND_BONUS
  return state
}

// ---------------- 目标选择 ----------------

/**
 * 战场分割：1·2 号位是一个战场，3·4 号位是另一个，两边各打各的。
 * 这是原作的机制，直接决定了站位是有讲究的 —— 把坦克放 1 位只保护得了 1·2。
 */
const zoneOf = (idx) => (idx < 2 ? 0 : 1)
const isTank = (u) => tmplOf(u).role === "坦克"

/**
 * 普攻 / 普通技能的对线锁定，按优先级：
 *   1. 嘲讽 —— 最高，直接无视战场分割
 *   2. 同战场：只打 1·2 或只打 3·4；本战场敌人全灭了才越界
 *   3. 战场内优先坦克 —— 坦克相当于站前一格，替同战场的队友挡刀
 *   4. 同号位 → |位置差| 最小 → 编号小
 */
/**
 * @param {object} exclude 上一发打过的目标。伊织的连发要求「不能和上次相同」，
 *   但**同战场只剩它一个时还是打它**——所以是「有别人才换」而不是硬排除。
 * @param {boolean} wallZone 召唤物按**战场**拦而不是按号位拦。只有连发用：
 *   普攻和普通技能仍是「扔哪一路挡哪一路」，放宽了那条规则就废了。
 */
function laneTarget(u, foes, exclude = null, wallZone = false) {
  // 召唤物挡在最前面：入场那一轮的 Provoke 无视一切分割，之后只挡它扔向的那个号位。
  // 「扔对面 1 号位就只挡 1 号的刀」—— 所以 EX 指哪扔，决定了它替谁挨打。
  const sm = summonsOf(foes)
  const provoking = sm.find((s) => s.taunt > 0)
  if (provoking) return provoking

  const alive = aliveOf(foes)
  const zoneAlive = alive.filter((f) => zoneOf(f.idx) === zoneOf(u.idx))
  const inMyZone = (s) => zoneOf(s.blockIdx) === zoneOf(u.idx)
  const blocking = sm.find((s) => (wallZone ? inMyZone(s) : s.blockIdx === u.idx))
    // 本战场的活人打光了，**任何**召唤物都比越界打人优先 —— 越界之前先拆墙
    || (zoneAlive.length === 0 ? sm.find(inMyZone) || sm[0] : null)
  if (blocking) {
    // 「不能和上次相同」的例外是「同战场只剩它一个」：人偶就在本战场且这边没活人了，
    // 那连发的后几枪全砸它身上；人偶在另一边的话，下一发照常换人。
    const onlyOneHere = zoneAlive.length === 0 && inMyZone(blocking)
    if (!(exclude === blocking && !onlyOneHere)) return blocking
  }

  const taunts = foes.units.filter((f) => f.alive && f.taunt > 0)
  if (taunts.length) return taunts[0]

  if (!alive.length) return null
  let pool = zoneAlive.length ? zoneAlive : alive
  if (exclude) {
    const others = pool.filter((f) => f !== exclude)
    if (others.length) pool = others
  }
  const tanks = pool.filter(isTank)
  const cands = tanks.length ? tanks : pool

  const direct = cands.find((f) => f.idx === u.idx)
  if (direct) return direct
  return cands.reduce((best, f) => {
    const d = Math.abs(f.idx - u.idx), bd = Math.abs(best.idx - u.idx)
    if (d < bd) return f
    if (d === bd && f.idx < best.idx) return f
    return best
  })
}

/**
 * 从主目标向外扩散选人：反复从「与已选集合相邻的存活单位」里挑百分比血量最低的。
 *
 * **扩散不跨战场**：主目标在 3 位，就只可能波及 4 位；同战场只剩一个人时，
 * 范围技当场退化成单体。主目标本身不受限制 —— EX 想指哪打哪，
 * 指了 3 位就打 3·4，这是玩家用 EX 换来的选择权。
 */
function expandAdjacent(pool, primary, count) {
  // count≥3 是「以主目标为中心向两边炸开」（睦月的三连雷、日富美的圆），
  // 走**固定窗口** [idx−half, idx+half] 而不是贪心找邻居：越界的那一发就是浪费掉，
  // 不能往另一边多抓一个来凑满。指定 1 号位只炸 {1,2}，指定 2 号位才炸满 {1,2,3}。
  //
  // 战场分割也在这里放开 —— 一个战场只有 2 个人，不跨就永远达不到设计的目标数。
  // 那条限制的本意是「别为了凑人数跑到另一边」，而固定窗口根本不凑人数。
  if (count >= 3) {
    const half = Math.floor((count - 1) / 2)
    const hit = pool.filter((u) => u.alive && Math.abs(u.idx - primary.idx) <= half)
    // 主目标必须排第一：splashHits / falloff 都靠 targets[0] 认主目标
    return [primary, ...hit.filter((u) => u !== primary)]
  }
  const seq = pool
    .filter((u) => u.alive && zoneOf(u.idx) === zoneOf(primary.idx))
    .sort((a, b) => a.idx - b.idx)
  const chosen = [primary]
  while (chosen.length < count) {
    const idxs = chosen.map((c) => seq.indexOf(c)).filter((i) => i >= 0)
    const cands = seq.filter((u, i) => !chosen.includes(u) && idxs.some((j) => Math.abs(j - i) === 1))
    if (!cands.length) break
    chosen.push(cands.reduce((m, u) => (u.hp / u.maxhp < m.hp / m.maxhp ? u : m)))
  }
  return chosen
}

/**
 * 场地技的覆盖范围：按技能自己的规则算，不是按「当时打中了谁」。
 *
 * 千世是 2 目标圆，盖住主目标所在的整个战场；邻居空着或已经死了，圈也还是那两路。
 * 3 目标走固定窗口（跟 expandAdjacent 同一套）；全体就是 1~4。
 * 人偶把整发接走时退化成它挡的那一路。
 */
function fieldLanes(skill, targets) {
  const primary = targets.find((t) => !t.summon) || targets[0]
  if (!primary) return null
  if (primary.summon) return { lo: primary.idx, hi: primary.idx }
  const count = skill.count || 1
  const tg = skill.target || ""
  if (tg === "enemy_all" || tg === "ally_all" || count >= 4) return { lo: 0, hi: 3 }
  if (tg.endsWith("adjacent") && count >= 3) {
    const half = Math.floor((count - 1) / 2)
    return { lo: Math.max(0, primary.idx - half), hi: Math.min(3, primary.idx + half) }
  }
  if (tg.endsWith("adjacent") && count === 2) {
    return zoneOf(primary.idx) === 0 ? { lo: 0, hi: 1 } : { lo: 2, hi: 3 }
  }
  return { lo: primary.idx, hi: primary.idx }
}

/** 同一片地上只留一个场地，后放的刷新时长。 */
function upsertField(side, next) {
  if (!side.fields) side.fields = []
  const i = side.fields.findIndex((f) => f.lo === next.lo && f.hi === next.hi)
  if (i < 0) side.fields.push(next)
  else side.fields[i] = next
}

/**
 * 己方目标未指定时的默认选择，规则与 laneTarget 对称：
 * 对位（对自己而言就是自己）→ 同战场最近 → 全场最近。
 */
function allyLaneTarget(u, allies) {
  if (u.alive) return u
  const alive = aliveOf(allies)
  if (!alive.length) return null
  const sameZone = alive.filter((a) => zoneOf(a.idx) === zoneOf(u.idx))
  const pool = sameZone.length ? sameZone : alive
  return pool.reduce((best, a) => (Math.abs(a.idx - u.idx) < Math.abs(best.idx - u.idx) ? a : best))
}

/**
 * @param {object} pick 玩家指定的目标 {scope:'foe'|'ally', idx:0-3}，可为空
 * @returns {Array<object>} 命中的单位列表（AoE 无衰减，每个目标吃全额）
 */
function resolveTargets(state, u, skill, foes, allies, pick, actionKind) {
  const tg = skill.target || "enemy_single"
  const count = skill.count || 1

  if (tg === "self") return [u]
  if (tg === "ally_all") return aliveOf(allies)
  if (tg === "ally_lowest") {
    const al = aliveOf(allies)
    return al.length ? [al.reduce((m, a) => (a.hp / a.maxhp < m.hp / m.maxhp ? a : m))] : []
  }
  if (tg === "enemy_all") return aliveOf(foes)

  // 玩家指定主目标；EX 是唯一能打破对线格局的手段
  const pool = tg.startsWith("ally") ? allies : foes
  let primary = null
  if (pick?.summon) {
    const sm = summonsOf(pick.scope === "ally" ? allies : foes).find((s) => s.idx === pick.idx)
    if (sm) return [sm] // 指名打召唤物就只打它，不扩散
  } else if (pick) {
    const p = (pick.scope === "ally" ? allies : foes).units[pick.idx]
    if (p?.alive && (pick.scope === "ally") === tg.startsWith("ally")) primary = p
    // 指定的人已经倒下：不当成「还打他那一片」。下面走施法者自己的对线 ——
    // 先打施法者同战场，那一边空了再越界打最近的。
  }

  if (tg === "enemy_random") return aliveOf(foes) // 逐段随机，在 strike 里再抽
  // 连发第一发也要有人：指定的死了走上面的同战场溢出，再空就对线（会越界）
  if (tg === "enemy_chain") {
    if (!primary) primary = laneTarget(u, foes)
    return primary ? [primary] : []
  }

  // 不指定目标就一律走对线锁定：对位 → 同战场 → 最近。
  // EX 也一样 —— 「挑全场最肥的」那种启发式看着聪明，实际让玩家猜不到刀会落在谁头上。
  if (!primary) primary = tg.startsWith("ally") ? allyLaneTarget(u, allies) : laneTarget(u, foes)
  if (!primary) return []
  // 召唤物不在 pool.units 里，扩散算不出邻居；打到它就只打它
  if (primary.summon) return [primary]

  // 范围技的落点里只要站着召唤物，整发就被它接走 —— 它是挡在那一片前面的墙。
  // 覆盖面按技能自己的规则算：3 目标看中心窗口（睦月隔一位也拦得住），
  // 2 目标看战场分割（白子要人偶跟她同战场才拦）。
  if (tg.endsWith("adjacent") && count > 1) {
    const half = Math.floor((count - 1) / 2)
    const wall = summonsOf(pool).find((s) => (count >= 3
      ? Math.abs(s.blockIdx - primary.idx) <= half
      : zoneOf(s.blockIdx) === zoneOf(primary.idx)))
    if (wall) return [wall]
  }
  if (tg.endsWith("adjacent")) return expandAdjacent(pool.units, primary, count)
  return [primary]
}

// ---------------- 伤害 ----------------

function applyDamage(ctx, src, tgt, dmg, meta = {}) {
  const total = dmg
  let absorbed = 0
  if (tgt.shield > 0) {
    absorbed = Math.min(tgt.shield, dmg)
    tgt.shield -= absorbed
    dmg -= absorbed
    if (tgt.shield <= 0) { tgt.shield = 0; tgt.shieldMax = 0; tgt.shieldTurns = 0 }
  }
  tgt.hp -= dmg

  emitEvent(ctx, {
    type: "damage",
    source: unitRef(src), target: unitRef(tgt),
    amount: Math.round(dmg), absorbed: Math.round(absorbed), totalAmount: Math.round(total),
    crit: Boolean(meta.crit), critHits: meta.critHits ?? (meta.crit ? 1 : 0),
    affinity: affinityMark(meta.aff ?? 1),
    attackType: src ? tmplOf(src).atkType : "持续",
    hits: meta.hits, landed: meta.landed,
  })

  const tag = (meta.crit ? "暴击" : "") +
    (meta.aff > 1.01 ? "·克制" : meta.aff < 0.99 ? "·抵抗" : "")
  const ab = absorbed > 0 ? `（护盾吸收 ${Math.round(absorbed)}）` : ""
  const seg = meta.hits ? ` [${meta.landed}/${meta.hits}段]` : ""
  ctx.log(`  ${src ? nameOf(src) : "持续"} → ${nameOf(tgt)} ${Math.round(dmg)}${ab}${seg} ${tag}`.trimEnd())

  if (tgt.hp <= 0) {
    tgt.hp = 0
    tgt.alive = false
    tgt.taunt = 0
    tgt.regens.length = 0
    tgt.dots.length = 0
    ctx.log(`  ✝ ${nameOf(tgt)} ${tgt.summon ? "被打碎" : "倒下"}`)
  }
}

/**
 * 对单个目标打出一组分段攻击。每段独立判定命中与暴击（与原作一致），
 * 因此段数越多伤害方差越小；结算后合并成一条伤害事件，避免刷屏。
 */
function strike(ctx, src, tgt, hits) {
  const { state } = ctx
  if (!tgt.alive || !src.alive) return 0

  const aff = affinity(tmplOf(src).atkType, tmplOf(tgt).defType)
  const hr = hitChance(src, tgt)
  const cr = critChance(src, tgt)
  const critMul = critMultOf(src, tgt)
  const dm = defModOf(tgt)
  const floor = stabilityFloor(src)
  const atk = atkOf(src)
  const dealF = Math.max(0.1, factorOf(src, "dmg_deal"))
  const takeF = Math.max(0.1, factorOf(tgt, "dmg_take"))

  let total = 0, landed = 0, critHits = 0
  for (const pct of hits) {
    if (nextRandom(state) >= hr) continue // 这一段被闪避
    landed++
    const crit = nextRandom(state) < cr
    if (crit) critHits++
    let d = atk * (pct / 100) * aff * dm * dealF * takeF
    d *= randRange(state, floor, 1)
    if (crit) d *= critMul
    total += Math.max(1, d)
  }

  if (!landed) {
    ctx.log(`  ${nameOf(tgt)} 闪避了 ${nameOf(src)}${hits.length > 1 ? `（${hits.length}段全空）` : ""}`)
    emitEvent(ctx, {
      type: "miss", source: unitRef(src), target: unitRef(tgt),
      attackType: tmplOf(src).atkType, hits: hits.length, landed: 0,
    })
    return 0
  }
  // crit 是「有没有暴击」（文字战报用），critHits 是「几段暴击」（战场图按占比缩放爆裂框）：
  // 单靠 crit 的话，段数越多越必然为真——芹香 11 段有 88% 概率亮框，那个通道就废了
  applyDamage(ctx, src, tgt, total, { crit: critHits > 0, critHits, aff, hits: hits.length, landed })
  return total
}

function heal(ctx, src, tgt, amount) {
  if (!tgt.alive) return
  // 受治疗量走 buff 系统（白热化的减益也在里面）
  amount *= Math.max(0.1, factorOf(tgt, "heal_taken"))
  const h = Math.min(amount, tgt.maxhp - tgt.hp)
  if (h <= 0) return
  tgt.hp += h
  ctx.log(`  ${nameOf(src)} 治疗 ${tgt === src ? "自身" : nameOf(tgt)} +${Math.round(h)}`)
  emitEvent(ctx, { type: "heal", source: unitRef(src), target: unitRef(tgt), amount: Math.round(h) })
}

// ---------------- 效果执行 ----------------

/** 非伤害效果的作用域：self / ally_all / enemy（跟随伤害目标） */
function scopeTargets(scope, u, allies, dmgTargets) {
  if (scope === "self") return [u]
  if (scope === "ally_all") return aliveOf(allies)
  return dmgTargets.filter((t) => t.alive)
}

function applyEffects(ctx, u, skill, dmgTargets, allies) {
  const { state } = ctx
  const T = state.turnId
  const me = state.sides[u.side]

  for (const eff of skill.effects || []) {
    if (eff.inactive) continue // 技能 1 级时数值为 0，别占一层 buff
    const targets = scopeTargets(eff.scope, u, allies, dmgTargets)
    switch (eff.type) {
      case "buff": {
        // 暴击伤害系的固定值单位是万分比，印原始数字玩家读不懂
        const bp = eff.stat === "crit_dmg_flat" || eff.stat === "crit_dmg_res_flat"
        const shown = bp ? `${Math.round(eff.value / 100)}%`
          : /_flat$/.test(eff.stat) ? eff.value : `${Math.round(eff.value * 100)}%`
        for (const t of targets) {
          upsertStatusLayer(t.buffs, makeStatus(eff, T, u, eff.value < 0 ? "debuff" : "buff"))
          ctx.log(`  ${nameOf(t)} ${STAT_LABEL[eff.stat] || eff.stat} ${eff.value > 0 ? "+" : ""}${shown}（${eff.turns ?? 2}回合）`)
        }
        if (targets.length) emitEvent(ctx, {
          type: eff.value < 0 ? "debuff" : "buff",
          source: unitRef(u), target: unitRef(targets[0]), effects: [eff.stat],
        })
        break
      }

      case "heal":
        for (const t of targets) heal(ctx, u, t, healOf(u) * eff.scale)
        break

      case "regen":
        for (const t of targets) {
          if (!t.alive) continue
          // 艾米的 EX 额外按「已损生命值」加成。与 healOf 一样在施放瞬间取快照，不逐跳重算
          const lost = eff.lostHpRate ? (t.maxhp - t.hp) * eff.lostHpRate : 0
          t.regens.push({
            amount: healOf(u) * eff.scale + lost, turns: eff.turns, period: eff.period || 1,
            tick: 0, sourceKey: sourceKeyOf(u.side, u.idx), srcSide: u.side, srcPos: u.idx, st: T,
          })
          ctx.log(`  ${nameOf(t)} 获得持续治疗（${eff.turns}回合，每${eff.period || 1}回合跳）`)
        }
        break

      case "shield":
        for (const t of targets) {
          // 重复施加只把护盾恢复为本次的新容量并刷新时长，不与旧护盾叠加
          const amount = Math.max(0, healOf(u) * eff.scale * Math.max(0.1, factorOf(t, "heal_taken")))
          t.shield = amount; t.shieldMax = amount
          t.shieldTurns = eff.turns ?? 2
          t.shieldTickSide = 1 - t.side; t.shieldSt = T
          ctx.log(`  ${nameOf(t)} 获得护盾 ${Math.round(amount)}（${t.shieldTurns}回合）`)
          emitEvent(ctx, { type: "shield", source: unitRef(u), target: unitRef(t), amount: Math.round(amount), turns: t.shieldTurns })
        }
        break

      // 持续伤害：伤害值在施放瞬间按施加者攻击力算死，之后跟他再无关系 ——
      // 场地是留在地上的，施加者阵亡、被控都不影响它继续跳。
      case "dot":
        // 固定场地先落在地上：圈按技能生效范围画，不按当时站了几个人。
        // 伤害仍然只打施放瞬间站在里面的人，之后谁死了都不换目标。
        if (eff.icon === "Zone") {
          const aimed = dmgTargets.length ? dmgTargets : targets
          const lanes = fieldLanes(skill, aimed)
          const ground = (aimed[0] || targets[0])
            ? state.sides[(aimed[0] || targets[0]).side]
            : null
          if (lanes && ground) {
            upsertField(ground, { lo: lanes.lo, hi: lanes.hi, turns: eff.turns, st: T })
          }
        }
        for (const t of targets) {
          if (!t.alive) continue
          t.dots.push({
            icon: eff.icon || "Burn", amount: atkOf(u) * eff.scale,
            turns: eff.turns, period: eff.period || 1, tick: 0,
            attackType: tmplOf(u).atkType, st: T,
          })
          ctx.log(`  ${nameOf(t)} 陷入${DOT_TEXT[eff.icon] || "持续伤害"}（${eff.turns}回合，每${eff.period || 1}回合跳）`)
          // 场地不是 debuff：它是留在地上的区域，状态格也不出图标。灼烧类才发 debuff 事件。
          if (eff.icon !== "Zone") {
            emitEvent(ctx, { type: "debuff", source: unitRef(u), target: unitRef(t), effects: ["dot"] })
          }
        }
        break

      case "charge":
        u.charge = { shots: eff.shots, mult: eff.mult, count: eff.count }
        ctx.log(`  ${nameOf(u)} 换弹强化（接下来 ${eff.shots} 发普攻 ×${eff.mult}` +
          (eff.count > 1 ? `，打 ${eff.count} 人` : "") + "）")
        emitEvent(ctx, { type: "buff", source: unitRef(u), target: unitRef(u), effects: ["charge"] })
        break

      case "summon": {
        const tpl = SUMMONS[eff.summonId]
        if (!tpl) break
        // 扔在哪＝伤害的主目标那一路。之后它只挡这个号位的刀
        const blockIdx = (dmgTargets.find((t) => !t.summon) || dmgTargets[0])?.idx ?? u.idx
        const key = sourceKeyOf(u.side, u.idx)
        // 「重复使用该技能时，清除先前召唤的该召唤物」——原作行为
        me.summons = summonsOf(me).filter((s) => s.sourceKey !== key)
        const hp = Math.round(tpl.hp + tmplOf(u).hp * (eff.hpRate || 0))
        me.summons.push({
          summon: true, id: eff.summonId, side: u.side, idx: blockIdx, blockIdx,
          hp, maxhp: hp, shield: 0, shieldMax: 0, shieldTurns: 0,
          // dots 不能漏：场地技打到人偶时会往这里 push，缺了直接崩
          buffs: [], regens: [], dots: [], stun: 0,
          taunt: eff.taunt || 0, turns: eff.turns, st: T,
          sourceKey: key, alive: true,
        })
        ctx.log(`  ${nameOf(u)} 召唤${tpl.name}（${hp} 生命，挡住 ${blockIdx + 1} 号位` +
          (eff.taunt ? `，嘲讽 ${eff.taunt} 回合` : "") + `，${eff.turns}回合）`)
        emitEvent(ctx, {
          type: "summon", source: unitRef(u), target: { side: u.side, pos: blockIdx, summon: true },
          name: tpl.name, hp, turns: eff.turns,
        })
        break
      }

      case "cc":
        if (eff.inactive || !eff.turns) break // 技能 1 级时控制时长为 0
        for (const t of targets) {
          if (nextRandom(state) >= (eff.chance ?? 1)) continue
          t.stun = Math.max(t.stun, eff.turns); t.stunSt = T; t.stunIcon = eff.icon
          ctx.log(`  ${nameOf(t)} 被${CC_TEXT[eff.icon] || "控制"} ${eff.turns} 回合`)
          emitEvent(ctx, { type: "debuff", source: unitRef(u), target: unitRef(t), effects: ["stun"] })
        }
        break

      case "cleanse":
        for (const t of targets) {
          t.buffs = t.buffs.filter((s) => s.effectKind !== "debuff")
          ctx.log(`  ${nameOf(t)} 减益被清除`)
        }
        break

      case "taunt":
        for (const t of targets) {
          t.taunt = eff.turns ?? 1; t.tauntSt = T
          ctx.log(`  ${nameOf(t)} 嘲讽 ${t.taunt} 回合`)
        }
        break

      case "cost": {
        const before = me.cost
        me.cost = Math.min(CFG.COST_MAX, Math.max(0, me.cost + eff.value))
        const got = me.cost - before
        if (got) {
          ctx.skillCostGained = (ctx.skillCostGained || 0) + got
          ctx.log(`  ${nameOf(u)} Cost ${got > 0 ? "+" : ""}${got}`)
          emitEvent(ctx, { type: "cost", source: unitRef(u), target: unitRef(u), amount: got })
        }
        break
      }
    }
  }
}

/**
 * 执行一个技能（EX / 普通技能 / 普攻）。
 * @param {string} label 日志抬头，含技能名
 * @param {"ex"|"skill"|"normal"} actionKind 供渲染层区分动作类型
 */
function execute(ctx, u, skill, label, actionKind, pick) {
  const { state } = ctx
  const me = state.sides[u.side]
  const foes = state.sides[1 - u.side]
  const targets = resolveTargets(state, u, skill, foes, me, pick, actionKind)
  if (!targets.length && skill.target !== "self") return

  ctx.log(`[${u.side === 0 ? "蓝" : "红"}] ${nameOf(u)} ${label}`)
  // 集火时第一个 EX 已经把指定目标打死，这一发按施法者对线重锁
  if (pick && pick.idx != null && !pick.summon && actionKind === "ex") {
    const intended = (pick.scope === "ally" ? me : foes).units[pick.idx]
    const got = targets[0]
    if (intended && !intended.alive && got && got !== intended) {
      ctx.log(`  ${nameOf(intended)} 已倒下，转打 ${nameOf(got)}`)
    }
  }
  emitEvent(ctx, {
    type: "action", source: unitRef(u),
    action: actionKind,
    skillName: skill.name || null,
    kind: skill.hits ? "damage" : "support",
    targetType: skill.target || "enemy_single",
    targets: targets.map(unitRef),
  })

  const hit = []
  if (skill.hits?.length) {
    if (skill.target === "enemy_chain") {
      // 连发：第一发打玩家指定的人，之后每一发重新锁定，且「不能和上一发相同」。
      // 每发都在结算后重算，所以打死人会自动换目标（本战场清空就越界）。
      let last = targets[0] || null
      for (const [i, pct] of skill.hits.entries()) {
        const t = i === 0 && last?.alive !== false ? last : laneTarget(u, foes, last, true)
        if (!t) break
        strike(ctx, u, t, [pct])
        last = t
        if (!hit.includes(t)) hit.push(t)
      }
    } else if (skill.target === "enemy_random") {
      // 弹射：每一段单独抽目标
      for (const pct of skill.hits) {
        const al = aliveOf(foes)
        if (!al.length) break
        const t = randPick(state, al)
        strike(ctx, u, t, [pct])
        if (!hit.includes(t)) hit.push(t)
      }
    } else {
      // AoE 默认无衰减，每个目标吃全额分段。两个例外，都靠「targets[0] 是主目标」成立
      // （由 expandAdjacent 保证，生成器也只在 adjacent/all 上给这两个字段）：
      //   splashHits —— 「单体 + 以其为中心的范围」，主目标吃直击＋爆风，扩散只吃爆风（爱露）
      //   falloff    —— 贯穿逐个递减，第 i 个目标 ×(1 − min(rate×i, max))（晴奈）
      for (const [i, t] of targets.entries()) {
        const base = i > 0 && skill.splashHits ? skill.splashHits : skill.hits
        const cut = skill.falloff ? Math.min(skill.falloff.rate * i, skill.falloff.max) : 0
        strike(ctx, u, t, cut ? base.map((h) => h * (1 - cut)) : base)
        hit.push(t)
      }
    }
  }

  applyEffects(ctx, u, skill, hit.length ? hit : targets, me)
}

/**
 * 普攻：对线锁定，分段独立判定。
 *
 * 处于换弹强化（鹤城的 EX）时，接下来 `shots` 发普攻倍率提高、打成扇形（多目标），
 * 打完一发扣一发。仍然走 `laneTarget` 选主目标 —— 强化的是威力和覆盖面，不是选择权。
 */
function autoAttack(ctx, u) {
  const tmpl = tmplOf(u)
  const c = u.charge
  if (c?.shots > 0) {
    c.shots -= 1
    if (c.shots <= 0) u.charge = null
    execute(ctx, u, {
      target: c.count > 1 ? "enemy_adjacent" : "enemy_single", count: c.count,
      hits: tmpl.autoAttack.hits.map((h) => Number((h * c.mult).toFixed(4))), effects: [],
    }, "强化普攻", "normal")
    return
  }
  // 普攻本身也可能是范围的（千世的圆形普攻），照模板里的 target/count 走
  execute(ctx, u, {
    target: tmpl.autoAttack.target || "enemy_single",
    count: tmpl.autoAttack.count || 1,
    hits: tmpl.autoAttack.hits, effects: [],
  }, "普攻", "normal")
}

// ---------------- 普通技能触发 ----------------

/** 普通技能是否就绪。冷却型看 skillCd，条件型看血量阈值，两者都受 maxUses 限制。 */
function skillReady(u) {
  const sk = tmplOf(u).skill
  const tr = sk?.trigger
  if (!sk || !tr) return false
  if (tr.maxUses && u.skillUses >= tr.maxUses) return false
  if (tr.type === "hp_below") return u.hp / u.maxhp <= tr.value
  return u.skillCd <= 0
}

function consumeSkill(u) {
  const tr = tmplOf(u).skill.trigger
  u.skillUses += 1
  u.skillCd = tr.type === "cooldown" ? tr.turns : 99
}

// ---------------- 回合结算 ----------------

/**
 * 状态都从施放瞬间写入。进攻类 Buff 跟随施放方的攻击窗口计时（施放回合算第 1 回合），
 * 护盾按敌方实际攻击窗口计时，控制与持续治疗跟随目标自己的行动窗口。
 */
function endTurn(ctx, side) {
  const { state } = ctx
  const T = state.turnId
  const ticking = side.side

  for (const s of state.sides) {
    for (const u of s.units) {
      if (!u.alive) continue
      for (const b of [...u.buffs]) {
        const tickSide = b.countCurrent ? b.srcSide : u.side
        if (tickSide !== ticking || b.turns >= 9999) continue
        if (b.st === T && !b.countCurrent) continue
        b.turns -= 1
        if (b.turns <= 0) u.buffs.splice(u.buffs.indexOf(b), 1)
      }
      const shieldTick = Number.isInteger(u.shieldTickSide) ? u.shieldTickSide : 1 - u.side
      if (u.shieldTurns > 0 && shieldTick === ticking && u.shieldSt !== T) {
        u.shieldTurns -= 1
        if (u.shieldTurns <= 0) { u.shield = 0; u.shieldMax = 0; u.shieldTurns = 0 }
      }
    }
  }

  // 召唤物按**敌方**回合跳：它挡的是敌人的攻击窗口，跟护盾同一套口径。
  // 6 轮 = 撑过敌人 6 次出手；施放当回合不扣（st !== T）。
  for (const s of state.sides) {
    if (s.side === ticking) continue
    for (const sm of [...(s.summons || [])]) {
      if (!sm.alive || sm.st === T) continue
      if (sm.taunt > 0) sm.taunt -= 1
      sm.turns -= 1
      if (sm.turns <= 0) {
        sm.alive = false
        ctx.log(`  ${tmplOf(sm).name} 消失了`)
      }
    }
    s.summons = (s.summons || []).filter((x) => x.alive)
  }

  /**
   * 持续伤害（场地/灼烧）在承受者自己的回合跳。三条性质都是有意的：
   *
   * - **不发 `action` 事件**，战场图上就不会画连线 —— 施加者可能已经阵亡，
   *   从他身上拉一根线出来是错的；伤害直接记在承受者头上，靠橙色区分来源。
   * - **不转移目标**：场地在施放瞬间就贴到当时站在里面的人身上，其中一个死了，
   *   剩下的照跳，但不会跑去烧别人。
   * - **召唤物也在列**：人偶站在场地里一样挨烧，所以这里要连 summons 一起遍历。
   */
  for (const u of [...side.units, ...summonsOf(side)]) {
    for (const d of [...(u.dots || [])]) {
      if (d.st === T) continue
      d.tick += 1
      if (d.tick % d.period === 0 && u.alive) {
        const hurt = Math.max(1, d.amount)
        u.hp -= hurt
        ctx.log(`  ${nameOf(u)} ${DOT_TEXT[d.icon] || "持续伤害"} ${Math.round(hurt)}`)
        emitEvent(ctx, {
          type: "damage", source: null, target: unitRef(u), dot: true, dotIcon: d.icon,
          amount: Math.round(hurt), totalAmount: Math.round(hurt), absorbed: 0,
          crit: false, critHits: 0, affinity: "none", attackType: d.attackType || "持续",
        })
        if (u.hp <= 0) {
          u.hp = 0; u.alive = false; u.taunt = 0
          u.regens.length = 0; u.dots.length = 0
          ctx.log(`  ✝ ${nameOf(u)} ${u.summon ? "被烧毁" : "倒下"}`)
          break
        }
      }
      d.turns -= 1
      if (d.turns <= 0) u.dots.splice(u.dots.indexOf(d), 1)
    }
  }

  // 地上的圈跟身上的 DoT 分开计时：人死了 DoT 清掉，圈还在原处，直到自己的时长走完。
  for (const f of [...(side.fields || [])]) {
    if (f.st === T) continue
    f.turns -= 1
    if (f.turns <= 0) side.fields.splice(side.fields.indexOf(f), 1)
  }

  // 持续治疗按承受者自己的回合跳。
  //
  // 这里**不能**照抄 buff/护盾那套 `st === T 就跳过本回合` 的写法：持续治疗永远由己方
  // 施加，也就永远在自己的回合结算，跳过施放回合等于把第一跳推迟整整一轮。星野的急救
  // 治疗是「生命≤30% 触发、每场限 1 次」的救命技能，延后一轮基本等于没放。
  for (const u of side.units) {
    if (!u.alive) continue
    for (const r of [...u.regens]) {
      r.tick += 1
      if (r.tick % r.period === 0) {
        const h = Math.min(r.amount, u.maxhp - u.hp)
        if (h > 0) {
          u.hp += h
          ctx.log(`  ${nameOf(u)} 持续治疗 +${Math.round(h)}`)
          emitEvent(ctx, { type: "heal", source: unitRef(u), target: unitRef(u), amount: Math.round(h) })
        }
      }
      r.turns -= 1
      if (r.turns <= 0) u.regens.splice(u.regens.indexOf(r), 1)
    }

    if (u.stun > 0 && u.stunSt !== T) u.stun -= 1
    if (u.taunt > 0 && u.tauntSt !== T) u.taunt -= 1
    if (u.skillCd > 0 && u.skillCd < 99) u.skillCd -= 1
  }
}

const checkEnd = (state) => sideDead(state.sides[0]) || sideDead(state.sides[1])

function settle(state) {
  const a = sideDead(state.sides[0]), b = sideDead(state.sides[1])
  if (a && b) state.winner = -1
  else if (b) state.winner = 0
  else if (a) state.winner = 1
  else {
    const ratio = (s) => s.units.reduce((x, u) => x + u.hp, 0) / s.units.reduce((x, u) => x + u.maxhp, 0)
    const ra = ratio(state.sides[0]), rb = ratio(state.sides[1])
    state.winner = ra > rb ? 0 : rb > ra ? 1 : -1
  }
  state.phase = "done"
  return state.winner
}

// ---------------- 对外主接口 ----------------

/** Cost 回复只取决于存活人数；白热化期间翻倍（原作 FEVER 的核心效果就是这条） */
export const regenOf = (side, state) =>
  CFG.COST_REGEN_PER_UNIT * aliveOf(side).length * (state && feverOn(state) ? CFG.FEVER_COST_MULT : 1)

/**
 * 当前行动方本回合实际可用的 Cost。
 * 回复发生在每个回合「结束时」，所以进入回合时手上的就是全部预算，不再预支。
 */
export function turnCostOf(side) {
  return Math.min(CFG.COST_MAX, Math.floor(side.cost))
}

/**
 * 把指令里的角色名换算成号位。
 * 同队不允许重名，所以名字能唯一定位——战场图上也就不用再标号位了。
 * @returns {{casts:Array}|{error:string}}
 */
function resolveCasts(state, action) {
  if (action.type !== "ex") return { casts: [] }
  const mine = state.sides[state.activeSide].units
  const foes = state.sides[1 - state.activeSide].units
  const pick = (units, id) => units.find((u) => u.id === id)
  const label = (id) => BY_ID[id]?.name || id

  const casts = []
  for (const c of action.casts) {
    let pos = c.pos
    if (pos == null) {
      const u = pick(mine, c.id)
      if (!u) return { error: `你的队伍里没有${label(c.id)}` }
      pos = u.idx
    }
    const out = { pos }
    if (c.target?.summonId != null) {
      // 指名打召唤物：本方/敌方各找一遍，找不到就当没指定，退回技能默认规则
      const scope = c.target.scope === "ally" ? "ally" : "foe"
      const pool = scope === "ally" ? state.sides[state.activeSide] : state.sides[1 - state.activeSide]
      const sm = (pool.summons || []).find((s) => s.alive && s.id === c.target.summonId)
      if (!sm) return { error: `场上没有${SUMMONS[c.target.summonId]?.name || "那个召唤物"}` }
      out.target = { scope, idx: sm.idx, summon: true }
      casts.push(out)
      continue
    }
    if (c.target) {
      const { idx, id } = c.target
      // 没写「打/给」时按技能自己的目标类型猜边
      const exTarget = String(tmplOf(mine[pos]).ex.target || "enemy_single")
      const scope = c.target.scope || (exTarget.startsWith("enemy") ? "foe" : "ally")
      if (idx != null) out.target = { scope, idx }
      else {
        // 猜错了就翻到另一边找 —— 没写动词本来就是模糊的，别拿猜测去卡玩家
        let u = pick(scope === "ally" ? mine : foes, id)
        let side = scope
        if (!u && !c.target.scope) {
          side = scope === "ally" ? "foe" : "ally"
          u = pick(side === "ally" ? mine : foes, id)
        }
        if (!u) return { error: `${scope === "ally" ? "你的队伍" : "对方队伍"}里没有${label(id)}` }
        out.target = { scope: side, idx: u.idx }
      }
    }
    casts.push(out)
  }
  return { casts }
}

/** 校验一条指令能不能执行，返回错误文案或 null。不改动 state。 */
export function validateAction(state, action) {
  if (state.phase !== "command") return "这局已经结束了"
  if (action.type === "pass") return null

  const resolved = resolveCasts(state, action)
  if (resolved.error) return resolved.error
  if (resolved.casts.length > 1) return "一次只能放一个 EX，看完结果再决定下一发，或发「过」"
  if (!resolved.casts.length) return "要指定放哪个角色的 EX"

  const draft = structuredClone(state)
  const side = draft.sides[draft.activeSide]
  if (!draft.turnOpen) refreshExOnCasualty(side)
  const budget = turnCostOf(side)
  const used = new Set(draft.turnEx || [])
  const cast = resolved.casts[0]
  const u = side.units[cast.pos]
  if (!u) return `没有 ${cast.pos + 1} 号位`
  if (!u.alive) return `${nameOf(u)} 已经倒下了`
  if (used.has(cast.pos)) return `${nameOf(u)} 本回合已经释放过 EX`
  const wait = exWaitOf(side, u)
  if (wait > 0) return `${nameOf(u)} 的 EX 还在冷却，还需本方再放出 ${wait} 个 EX`
  if (u.stun > 0) return `${nameOf(u)} 被${CC_TEXT[u.stunIcon] || "控制"}，放不出 EX`
  const cost = tmplOf(u).ex.cost
  if (budget < cost) return `Cost 不够：${nameOf(u)} 要 ${cost} 点，你还剩 ${budget} 点`
  return null
}

/**
 * 结算当前行动方的一步。
 *
 * 一次只能放一个 EX。放完若还能再放，停住等玩家看图再决定；
 * 发「过」或放不出下一发时，才跑普通技能 → 普攻 → 收回合。
 *
 * @param {object} prev 战斗状态（不会被修改）
 * @param {{type:'pass'}|{type:'ex', casts:Array<{pos:number, target?:object}>}} action
 * @returns {{state, log, events, round, error?}}
 */
export function playerTurn(prev, action) {
  const err = validateAction(prev, action)
  if (err) return { state: prev, log: [], error: err }

  const state = structuredClone(prev)
  const lines = []
  const events = []
  const ctx = { state, log: (s) => lines.push(s), emit: (e) => events.push(e) }

  const side = state.sides[state.activeSide]
  const tag = state.activeSide === 0 ? "蓝" : "红"
  const actionRound = state.round
  const continuing = Boolean(state.turnOpen)

  if (!continuing) {
    state.turnOpen = true
    state.turnEx = []
    state.turnId += 1
    // ⓪ 白热化按轮数判定，只在回合开头跑一次
    enterFever(ctx)
    // ① 减员刷新要在指令之前跑：这一回合就该能放
    refreshExOnCasualty(side, () => lines.push(`[${tag}] 有人阵亡，全员 EX 冷却清空`))
    lines.push(`--- ${tag}方回合（Cost ${side.cost}）---`)
  }

  // Cost 在回合末才回复，因此进入回合时手上的就是本回合的全部预算
  const costAtStart = side.cost
  let gained = 0
  let spent = 0

  const applyRegen = () => {
    const before = side.cost
    side.regenAcc += regenOf(side, state)
    const g = Math.floor(side.regenAcc)
    side.regenAcc -= g
    side.cost = Math.min(CFG.COST_MAX, side.cost + g)
    gained = side.cost - before
  }

  const done = () => {
    return {
      state, log: lines, events,
      costBefore: costAtStart, gained, skillGained: ctx.skillCostGained || 0, spent,
      round: actionRound,
    }
  }

  const closeTurn = () => {
    state.turnOpen = false
    state.turnEx = []
    state.activeSide = 1 - state.activeSide
    if (state.activeSide === state.first) {
      if (state.round >= CFG.MAX_ROUND) settle(state)
      else state.round += 1
    }
  }

  // ② 玩家指令：最多一个 EX
  if (action.type === "ex") {
    const cast = resolveCasts(state, action).casts[0]
    const u = side.units[cast.pos]
    const used = new Set(state.turnEx || [])
    if (u?.alive && u.stun <= 0 && exWaitOf(side, u) <= 0 && !used.has(u.idx)) {
      const ex = tmplOf(u).ex
      if (side.cost >= ex.cost) {
        side.cost -= ex.cost
        spent += ex.cost
        markExCast(side, u)
        state.turnEx = [...used, u.idx]
        execute(ctx, u, ex, `EX「${ex.name}」(-${ex.cost})`, "ex", cast.target)
        if (ex.thenAutoAttack && u.alive && !checkEnd(state)) autoAttack(ctx, u)
        if (checkEnd(state)) {
          state.turnOpen = false
          state.turnEx = []
          settle(state)
          return done()
        }
        // 还能再放就停：技能和普攻等「过」或放不出时再跑
        if (exCastableOf(state, state.activeSide).length) return done()
      }
    }
  } else {
    lines.push(`[${tag}] 过`)
  }

  // ③ 己方自动行动，**分两阶段跑完**：先全体普通技能，再全体普攻。
  //
  // 不能按站位 1→4 逐个挑「技能或普攻」——那样真纪的减防放在 4 号位时，
  // 三个队友已经打完了，那一回合等于白放，站位反而成了隐藏的强度开关。
  // 加上 EX 就是攻略页承诺的 EX → 普通技能 → 普攻。
  const acted = new Set(state.turnEx || [])
  const foes = () => state.sides[1 - state.activeSide]

  // ③-a 普通技能。控制在这一阶段结算，被控的人后面也不普攻
  for (const u of side.units) {
    if (sideDead(foes())) break
    if (!u.alive || acted.has(u.idx)) continue
    if (u.stun > 0) {
      const cc = CC_TEXT[u.stunIcon] || "控制"
      // 被控时已经就绪的普通技能**当场被吞**，不是留到下回合：抬手被打断，照样进冷却。
      // 冷却型重新压满，条件型（星野）会消耗一次 maxUses —— 这是被控的真实代价。
      if (skillReady(u)) {
        const sk = tmplOf(u).skill
        consumeSkill(u)
        lines.push(`[${tag}] ${nameOf(u)} ${cc}，「${sk.name}」被打断`)
      } else {
        lines.push(`[${tag}] ${nameOf(u)} ${cc}，无法行动`)
      }
      acted.add(u.idx)
      continue
    }
    if (!skillReady(u)) continue
    const sk = tmplOf(u).skill
    consumeSkill(u)
    acted.add(u.idx)
    execute(ctx, u, sk, `普通技能「${sk.name}」`, "skill")
    if (checkEnd(state)) {
      state.turnOpen = false
      state.turnEx = []
      settle(state)
      return done()
    }
  }

  // ③-b 普攻
  for (const u of side.units) {
    if (sideDead(foes())) break
    if (!u.alive || acted.has(u.idx)) continue
    autoAttack(ctx, u)
    if (checkEnd(state)) {
      state.turnOpen = false
      state.turnEx = []
      settle(state)
      return done()
    }
  }

  // ④ 回合结束：先结算状态时长，再回复 Cost（所以首轮双方都不回）
  endTurn(ctx, side)
  applyRegen()
  if (checkEnd(state)) {
    state.turnOpen = false
    state.turnEx = []
    settle(state)
    return done()
  }

  closeTurn()
  return done()
}

export { nameOf, tmplOf, aliveOf, sideDead, hitChance, critChance, defModOf, stabilityFloor, CC_TEXT }
