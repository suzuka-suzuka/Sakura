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

/**
 * 挨打时才生效的属性。**判据是「这一层在谁的攻击窗口里起作用」，不是谁施加的、也不是增益还是减益。**
 *
 * 状态时长一律按「N 回合 = 它真正起作用的 N 个攻击窗口」计，由此推出跳动的回合：
 *
 * | 这一层 | 生效于 | 跟谁的回合跳 |
 * |---|---|---|
 * | 防御向（本表）| 承受者**挨打**时 | 承受者的敌方 `1 - u.side` |
 * | 进攻 / 治疗向 | 承受者**出手**时 | 承受者自己 `u.side` |
 *
 * 四种组合都自然对齐，**一个「跳过施放回合」的守卫都不需要**：
 *   - 自身防御增益（椿的 +28% 防御）在自己回合上，那一回合 ticking 是自己方，天然不扣
 *   - 给敌人的减防（茜的 −29%）承受者是敌人，`1 - u.side` 正是自己方，当场扣一格 ——
 *     而本方这一回合的普攻正好吃得到，对齐
 *   - 自身进攻增益（野宫的 +22% 攻击）施放回合就得算，因为 ③-b 她马上要打
 *   - 给敌人的减命中承受者是敌人，跟着敌人的回合跳
 *
 * 曾经这里叫 `CURRENT_TURN_STATS`（「进攻类」），却塞着 `dfs` / `dmg_take` 两个防御向属性，
 * 而且按**施加者**分side —— 对减防是对的，对自身防御增益就白扣一格（椿 6 回合只挡得住 5 次）。
 * 同时 `acc` 漏在集合外，野宫同一个技能里 4 回合的命中增益反而比攻击增益多管一轮。
 */
const DEFENSIVE_STATS = new Set([
  "dfs", "dfs_flat", "dmg_take", "dodge", "crit_res", "crit_dmg_res_flat",
])

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
  heal_taken: "受治疗量", aa: "攻速", cost_regen: "Cost回复",
  crit_res: "暴击抵抗", crit_dmg_res_flat: "暴伤抵抗",
}

function makeStatus(eff, turnId, source, kind) {
  return {
    stat: eff.stat, value: eff.value, turns: eff.turns ?? 2,
    effectKind: kind,
    sourceKey: sourceKeyOf(source.side, source.idx),
    srcSide: source.side, srcPos: source.idx,
    st: turnId, // 只用于排查存进 Redis 的对局，结算不读它
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
 * 满编 4 人时放完要等另外 2 个 EX 才轮回来（1→2→3→1）；
 * 剩 3 人隔 1 个就能轮回来（1→2→1）；
 * 剩 2 人及以下长度归零，Cost 够就能连放同一人 —— 人越少越不该被冷却锁死。
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
 * 这个人现在放 EX 要几费。基础值来自角色表，`u.exDiscount` 在上面打折。
 *
 * **一切读 EX 费用的地方都要走它** —— 校验、扣费、EX 卡上的数字和那圈 Cost 扇形，
 * 少一处就会出现「卡上写 1 费、放的时候说 Cost 不够」。
 *
 * 折扣按**次数**消耗，没有时长（原数据是 `Uses`，描述写「EX技能使用2次后失效」）。
 * 百分比档（忧、圣娅那种 −50%）向上取整保证 Cost 仍是整数；目前池里没有百分比角色。
 */
export function exCostOf(u) {
  const base = tmplOf(u).ex.cost
  const d = u.exDiscount
  if (!d?.uses) return base
  return Math.max(0, Math.ceil(d.mode === "pct" ? base * (1 - d.value) : base - d.value))
}

/** 放完一发 EX 就扣掉一次折扣额度，用完清掉 */
function consumeExDiscount(u) {
  if (!u.exDiscount?.uses) return
  u.exDiscount.uses -= 1
  if (u.exDiscount.uses <= 0) u.exDiscount = null
}

/**
 * 这一步真正能出手的 EX：冷却好、没被控封住、Cost 也够。
 * 冷却是人数锁：剩 3 人是 1→2→1，剩 2 人及以下同一人可以连放。
 * 嘲讽 / 恐惧 / 眩晕是另一把锁，见 exLockedOf —— 全员被封时名单会空，
 * 但回合不能因此自动过掉，还是要等人发「过」。
 * 放完一发后用它决定要不要停下来等玩家再操作。
 */
export function exCastableOf(state, sideIndex) {
  const side = state.sides[sideIndex]
  const budget = turnCostOf(side)
  return side.units
    .filter((u) => exReadyOf(side, u) && !exLockedOf(state, u) && exCostOf(u) <= budget)
    .map((u) => u.idx)
}

/** 记一次 EX 释放，把释放者压进冷却 */
function markExCast(side, u) {
  side.exCasts = (side.exCasts || 0) + 1
  u.exCastNo = side.exCasts
}

/**
 * 轮到这一方时若比上次少了人，直接清空全部冷却。
 *
 * 没有这一条的话，减员会让冷却长度缩短、却缩不掉已经欠下的等待
 * （4→3 时上回合放过的人 wait 从 2 变成 1，看起来还锁着）。
 *
 * 必须在把回合交出去时就跑（closeTurn），不能等下一位发出第一口指令：
 * 战场图是交回合时发出去的，那时候冷却还没清，卡面上仍是灰的。
 * validateAction / playerTurn 开头再跑一次，给「图已经发出、指令才进来」兜底。
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

/** 交回合之后、第一口指令进来之前：减员刷新还没落到 state 上 */
export function exRefreshPending(state, side) {
  const s = side ?? state.sides[state.activeSide]
  if (state.phase !== "command" || state.turnOpen) return false
  if (s !== state.sides[state.activeSide]) return false
  return s.lastAlive != null && aliveOf(s).length < s.lastAlive
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
 * 原作的**基础效果只有一条**：EX Cost 攒得明显更快（Cost Regen Up）。
 * 防御 / 闪避 / 受治疗下降是赛季附加规则（S10、S11 都带），一并抄了，
 * 不想要把 CFG.FEVER_DEBUFF 设成 0 即可。
 *
 * 数字仍走 `regenOf` 的 `FEVER_COST_MULT`（Cost 是按边回的，不是按人）；
 * 往每个人身上挂一层 `cost_regen` 只是让状态格画出那张红底 COST↑。
 */
const feverOn = (state) => state.round >= CFG.FEVER_ROUND

/**
 * 进入白热化时给全场挂一次永久状态。
 * 走 buff 系统而不是在伤害公式里加系数：状态格会自动画出来，玩家能看见发生了什么。
 */
function enterFever(ctx) {
  const { state } = ctx
  if (state.fever || !feverOn(state)) return
  state.fever = true
  const costUp = CFG.FEVER_COST_MULT - 1
  for (const s of state.sides) {
    for (const u of s.units) {
      if (costUp) {
        u.buffs.push({
          stat: "cost_regen", value: costUp, turns: 9999, st: -1,
          srcSide: u.side, effectKind: "fever", sourceKey: "fever-cost",
        })
      }
      if (CFG.FEVER_DEBUFF > 0) {
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
    // taunt = 「这个单位吃掉对面的刀」；tauntKind 决定状态格画给谁看，见 setTaunt
    taunt: 0, tauntSt: -1, tauntKind: null,
    // 普通技能：「每 X 秒」是周期，第一次落在 X 秒而不是开局，所以起始压满冷却；
    // 条件型（血量阈值）与战斗开始时都用 99 表示「不靠冷却解锁」；
    // 普攻触发（泉 / 明里）第一次就能 roll，起始 0
    skillCd: tmpl.skill?.trigger?.type === "cooldown" ? tmpl.skill.trigger.turns
      : (tmpl.skill?.trigger?.type === "on_auto" || tmpl.skill?.trigger?.type === "on_kill") ? 0 : 99,
    skillUses: 0,
    // 强化形态：{hits, count, shots?|turns?, targeting?}
    // 鹤城按发数（EX 之后的两发普攻），瞬按轮数并改索敌
    charge: null,
    // 不死：血量掉不到 0，按**敌方**回合跳（跟护盾同口径，挡的是敌人的攻击窗口）
    immortal: 0, immortalSt: -1,
    // EX 费用打折：{mode:"flat"|"pct", value, uses}。按**次数**失效，没有时长
    exDiscount: null,
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
  applyBattleStart(state)
  return state
}

/**
 * 「战斗开始时」的普通技能（瞬的开局回费）。**必须在建局时就落地** ——
 * 丢进 ③-a 技能阶段的话，Cost 会晚于玩家首轮的 EX 窗口，开局那 2 点等于白给。
 *
 * 走 applyEffects 而不是只认 cost 效果：日后再出「战斗开始时上个增益」的角色也不用改这里。
 * 施加者就是目标（这类技能全是对自身），`skillUses` 当场记满，之后 skillReady 也不会再放它。
 */
function applyBattleStart(state) {
  const ctx = { state, log: () => {}, emit: () => {} }
  for (const side of state.sides) {
    for (const u of side.units) {
      const sk = tmplOf(u).skill
      if (sk?.trigger?.type !== "battle_start") continue
      u.skillUses += 1
      applyEffects(ctx, u, sk, [u], side)
    }
  }
}

// ---------------- 目标选择 ----------------

/**
 * 战场分割：1·2 号位是一个战场，3·4 号位是另一个，两边各打各的。
 * 挡刀看的是角色自己的前/中/后排，不是职业，也不是 1~4 号位。
 */
const zoneOf = (idx) => (idx < 2 ? 0 : 1)
const LINE_RANK = { 前: 0, 中: 1, 后: 2 }
const lineOf = (u) => tmplOf(u).line || "后"
const lineRank = (u) => LINE_RANK[lineOf(u)] ?? 2

/** 同一层里：对位 → |位置差| 最小 → 编号小 */
function pickInLayer(cands, fromIdx) {
  if (!cands.length) return null
  const direct = cands.find((f) => f.idx === fromIdx)
  if (direct) return direct
  return cands.reduce((best, f) => {
    const d = Math.abs(f.idx - fromIdx), bd = Math.abs(best.idx - fromIdx)
    if (d < bd) return f
    if (d === bd && f.idx < best.idx) return f
    return best
  })
}

/**
 * 多目标只在主目标那一层横着铺。一层里凑不够人数就退化成单体。
 * 不指定时主目标已经是最前那层；指定 EX 落在被点名的那一层，可以越过前排打后排。
 */
function sameLineHits(cands, primary, count) {
  const layer = cands.filter((u) => lineOf(u) === lineOf(primary))
  if (!layer.includes(primary)) return layer.slice(0, count)
  return [primary, ...layer.filter((u) => u !== primary)].slice(0, count)
}

/**
 * 上嘲讽。**同一方同时只留一个嘲讽目标，后放的覆盖先放的** —— 两个人一起吸引火力
 * 只会让「刀落在谁头上」没法预测，也没法在图上表达。跟 Channel 分槽同一条思路：
 * 同槽只留一层，不比大小、不比剩余回合。
 *
 * 单位和召唤物**共用这一个位置**：日富美的人偶入场 Provoke 和椿的 EX 会互相顶掉，
 * 谁后放谁生效。跨方的互不干扰 —— 拉的是各自敌人的刀。
 *
 * 引擎里只存一个「这个单位吃掉对面的攻击」的标记，但**原作是两种不同的机制**，
 * 靠 `kind` 分开（决定状态格画在谁头上、什么颜色，见 battleHtml 的 statusMarks）：
 *
 *   - `provoke`（椿、人偶）：减益落在**被拉走的敌人**身上（紫底感叹号），施法者自己不带标
 *   - `focus`（集火 / `ConcentratedTarget`，池外）：减益落在**被点名的那个人**身上（蓝底靶心）
 */
function setTaunt(side, target, turns, turnId, kind = "provoke") {
  for (const u of side.units) { u.taunt = 0; u.tauntSt = -1; u.tauntKind = null }
  for (const s of side.summons || []) { s.taunt = 0; s.tauntKind = null }
  target.taunt = turns
  target.tauntSt = turnId
  target.tauntKind = kind
}

/** 这一方当前的嘲讽目标（至多一个，见 setTaunt）；召唤物也算 */
const tauntTargetOf = (side) =>
  (side.summons || []).find((s) => s.alive && s.taunt > 0) ||
  side.units.find((u) => u.alive && u.taunt > 0) || null

/**
 * 这个单位是不是正被对面 Provoke 住（刀只能往那边扔）。
 * **Provoke 的减益标记落在被拉走的人身上，不是施法者身上** —— 原作就是这么画的：
 * 中了嘲讽的人头上顶一个紫色感叹号，放嘲讽的那个反而什么都不多。
 * @returns {object|null} 把它拉住的那个单位/召唤物
 */
export function provokedBy(state, u) {
  if (!u?.alive) return null
  const t = tauntTargetOf(state.sides[1 - u.side])
  return t && (t.tauntKind || "provoke") === "provoke" ? t : null
}

/**
 * 这个人现在放不出 EX 的控制原因。冷却和 Cost 不走这里。
 *
 * 眩晕 / 恐惧整个人不能动；嘲讽按原作只封 EX（普通技能和普攻照常，刀全被拉走）。
 * 后排 Special 以后不站在场上，吃不到场地嘲讽，这里只看「这个单位自己」有没有被控。
 */
export function exLockedOf(state, u) {
  if (!u?.alive) return null
  if (u.stun > 0) return CC_TEXT[u.stunIcon] || "控制"
  if (provokedBy(state, u)) return "嘲讽"
  return null
}

/** 这一方活人是不是全被控住、一个 EX 都放不出。后排以后能破这个。 */
export function exSealedOf(state, sideIndex) {
  const alive = aliveOf(state.sides[sideIndex])
  return alive.length > 0 && alive.every((u) => exLockedOf(state, u))
}

/**
 * 瞬的强化形态：「索敌机制改为优先攻击攻击力最高的敌方单位」。
 *
 * **这套索敌只有嘲讽拉得走**，别的一概不管 —— 战场分割、前/中/后排、人偶挡刀全部绕开，
 * 她站 4 号位照样一枪打到对面 1 号位的主 C 头上。那正是这个 EX 花 3 费买的东西：
 * 把「站位决定打谁」这条规则在 6 轮里关掉。
 *
 * 嘲讽在 laneTarget 更前面就返回了，所以这里不用再判一次。
 * 敌方活人打光时返回 null，落回通用逻辑去拆墙（人偶）。
 */
function maxAtkTarget(u, alive) {
  if (u.charge?.targeting !== "max_atk" || !alive.length) return null
  // 攻击力相同就取号位小的：reduce 只在严格大于时换人
  return alive.reduce((m, f) => (atkOf(f) > atkOf(m) ? f : m))
}

/**
 * 普攻 / 普通技能的对线锁定，按优先级：
 *   1. 嘲讽 —— 最高，直接无视战场分割
 *   2. 强化形态改过索敌的（瞬）—— 打攻击力最高的，见 maxAtkTarget
 *   3. **同战场的佩洛洛**：挡在那半边最前面，嘲讽过期了也一样。本战场打空要越界时也先拆墙
 *   4. 同战场的前排 → 中排 → 后排。不是职业，是角色自己的 Front/Middle/Back
 *   5. 本战场空了才越界，跨过去还是前 → 中 → 后
 *   6. 同一层里：对位 → |位置差| 最小 → 编号小
 */
function laneTarget(u, foes) {
  // 嘲讽最高，无视一切 —— 战场分割、前排、挡刀、瞬的强化索敌统统让路。
  // 同一方至多一个嘲讽目标（后放的覆盖先放的，见 setTaunt），单位和召唤物共用这个位置：
  // 人偶入场那一轮的 Provoke 和椿的 EX 会互相顶掉。
  const taunting = tauntTargetOf(foes)
  if (taunting) return taunting

  const sm = summonsOf(foes)
  const alive = aliveOf(foes)
  const maxAtk = maxAtkTarget(u, alive)
  if (maxAtk) return maxAtk
  const zoneAlive = alive.filter((f) => zoneOf(f.idx) === zoneOf(u.idx))
  // 召唤物**按战场拦**，不是按号位：它挡在那半边最前面，比前排还靠前一格。
  // 所以「日富美ex打<某人>」选的其实是**把墙扔进哪个战场**，那一整边的刀都归它接。
  const blocking = sm.find((s) => zoneOf(s.blockIdx) === zoneOf(u.idx))
    // 本战场的活人打光了，**任何**召唤物都比越界打人优先 —— 越界之前先拆墙
    || (zoneAlive.length === 0 ? sm[0] : null)
  if (blocking) return blocking

  if (!alive.length) return null
  const pool = zoneAlive.length ? zoneAlive : alive
  const best = Math.min(...pool.map(lineRank))
  return pickInLayer(pool.filter((f) => lineRank(f) === best), u.idx)
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

  // 范围技的落点只要碰到召唤物所在的**战场**，整发就被它接走 —— 它是挡在那半边前面的墙，
  // 跟 laneTarget 里的挡刀同一条口径（按战场，不按号位）。
  // 2 目标的覆盖面本来就是主目标那个战场；3 目标是中心窗口，跨到哪半边就被哪半边的墙接。
  if (tg.endsWith("adjacent") && count > 1) {
    const half = count >= 3 ? Math.floor((count - 1) / 2) : 0
    const lanes = count >= 3
      ? [primary.idx - half, primary.idx + half]
      : (zoneOf(primary.idx) === 0 ? [0, 1] : [2, 3])
    const wall = summonsOf(pool).find((s) =>
      [0, 1, 2, 3].some((i) => i >= lanes[0] && i <= lanes[1] && zoneOf(i) === zoneOf(s.blockIdx)))
    if (wall) return [wall]
  }
  // 嘲讽把整发吸走，不往后排溅。跟人偶同一档。
  if (tg.startsWith("enemy") && count > 1 && primary === tauntTargetOf(foes) && !primary.summon) {
    return [primary]
  }
  if (tg.endsWith("adjacent")) {
    const hits = expandAdjacent(pool.units, primary, count)
    // 横向圆/扇锁同层（睦月、白子、千世普攻…）。直线贯穿（晴奈、纯子）圈到谁打谁。
    if (tg.startsWith("enemy") && count > 1 && skill.depth !== "through") {
      return sameLineHits(hits, primary, count)
    }
    return hits
  }
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
  // 不死：伤害照吃、血条照掉，只是**掉不到 0**。护盾先扣完再轮到它兜底，两者不冲突
  const saved = tgt.hp <= 0 && tgt.immortal > 0
  if (saved) tgt.hp = 1

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
  if (saved) ctx.log(`  ${nameOf(tgt)} 靠不死撑住了（剩 1 生命）`)

  if (tgt.hp <= 0) {
    tgt.hp = 0
    tgt.alive = false
    tgt.taunt = 0
    tgt.regens.length = 0
    tgt.dots.length = 0
    ctx.log(`  ✝ ${nameOf(tgt)} ${tgt.summon ? "被打碎" : "倒下"}`)
    if (src && src !== tgt && src.alive) tryKillProc(ctx, src)
  }
}

/**
 * 对单个目标打出一组分段攻击。每段独立判定命中与暴击（与原作一致），
 * 因此段数越多伤害方差越小；结算后合并成一条伤害事件，避免刷屏。
 */
function strike(ctx, src, tgt, hits, actionKind) {
  const { state } = ctx
  if (!tgt.alive || !src.alive) return 0

  const aff = affinity(tmplOf(src).atkType, tmplOf(tgt).defType)
  const hr = hitChance(src, tgt)
  const cr = critChance(src, tgt)
  const critMul = critMultOf(src, tgt)
  const dm = defModOf(tgt)
  const floor = stabilityFloor(src)
  const atk = atkOf(src)
  // 攻速折成的 aa 只乘普攻。EX / 普通技能走 dmg_deal，别把射速加成套到技能倍率上。
  // 鹤城 / 芹香 ③-b 的普攻、强化普攻都是 actionKind === "normal"，会吃到。
  let dealF = factorOf(src, "dmg_deal")
  if (actionKind === "normal") dealF *= factorOf(src, "aa")
  dealF = Math.max(0.1, dealF)
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
          const inField = []
          if (lanes && ground) {
            upsertField(ground, { lo: lanes.lo, hi: lanes.hi, turns: eff.turns, st: T })
            // 场地盖住同战场两路，不问前中后 —— 圈里站着谁就烧谁
            for (const x of ground.units || []) {
              if (x.alive && x.idx >= lanes.lo && x.idx <= lanes.hi) inField.push(x)
            }
            for (const s of summonsOf(ground)) {
              if (s.blockIdx >= lanes.lo && s.blockIdx <= lanes.hi) inField.push(s)
            }
          }
          for (const t of inField.length ? inField : targets) {
            if (!t.alive) continue
            t.dots.push({
              icon: "Zone", amount: atkOf(u) * eff.scale,
              turns: eff.turns, period: eff.period || 1, tick: 0,
              attackType: tmplOf(u).atkType, st: T,
            })
            ctx.log(`  ${nameOf(t)} 陷入${DOT_TEXT.Zone}（${eff.turns}回合，每${eff.period || 1}回合跳）`)
          }
          break
        }
        for (const t of targets) {
          if (!t.alive) continue
          t.dots.push({
            icon: eff.icon || "Burn", amount: atkOf(u) * eff.scale,
            turns: eff.turns, period: eff.period || 1, tick: 0,
            attackType: tmplOf(u).atkType, st: T,
          })
          ctx.log(`  ${nameOf(t)} 陷入${DOT_TEXT[eff.icon] || "持续伤害"}（${eff.turns}回合，每${eff.period || 1}回合跳）`)
          emitEvent(ctx, { type: "debuff", source: unitRef(u), target: unitRef(t), effects: ["dot"] })
        }
        break

      case "charge": {
        u.charge = {
          hits: eff.hits, count: eff.count,
          ...(eff.shots != null ? { shots: eff.shots } : {}),
          ...(eff.turns != null ? { turns: eff.turns } : {}),
          ...(eff.targeting ? { targeting: eff.targeting } : {}),
        }
        const total = eff.hits.reduce((a, b) => a + b, 0)
        ctx.log(`  ${nameOf(u)} ${eff.shots ? `换弹强化（接下来 ${eff.shots} 发` : `强化形态（${eff.turns}回合内`}` +
          `普攻 ${Math.round(total)}%攻击力` + (eff.count > 1 ? `，打 ${eff.count} 人` : "") +
          (eff.targeting === "max_atk" ? "，索敌改为攻击力最高的敌人" : "") + "）")
        emitEvent(ctx, { type: "buff", source: unitRef(u), target: unitRef(u), effects: ["charge"] })
        break
      }

      case "summon": {
        const tpl = SUMMONS[eff.summonId]
        if (!tpl) break
        // 扔在哪＝伤害的主目标那一路。之后它只挡这个号位的刀
        const blockIdx = (dmgTargets.find((t) => !t.summon) || dmgTargets[0])?.idx ?? u.idx
        const key = sourceKeyOf(u.side, u.idx)
        // 「重复使用该技能时，清除先前召唤的该召唤物」——原作行为
        me.summons = summonsOf(me).filter((s) => s.sourceKey !== key)
        const hp = Math.round(tpl.hp + tmplOf(u).hp * (eff.hpRate || 0))
        const doll = {
          summon: true, id: eff.summonId, side: u.side, idx: blockIdx, blockIdx,
          hp, maxhp: hp, shield: 0, shieldMax: 0, shieldTurns: 0,
          // dots 不能漏：场地技打到人偶时会往这里 push，缺了直接崩
          buffs: [], regens: [], dots: [], stun: 0,
          taunt: 0, tauntKind: null, turns: eff.turns, turnsMax: eff.turns, st: T,
          sourceKey: key, alive: true,
        }
        me.summons.push(doll)
        // 入场 Provoke 走跟椿同一个位置：同一方只留最后放的那个嘲讽目标
        if (eff.taunt) setTaunt(me, doll, eff.taunt, T, "provoke")
        ctx.log(`  ${nameOf(u)} 召唤${tpl.name}（${hp} 生命，扔到敌方 ${blockIdx + 1} 号位前` +
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

      /**
       * 嘲讽 / 集火。scope 决定谁来吃刀，kind 决定状态格画给谁看（见 setTaunt）：
       *   self  + provoke —— 椿：她把敌方全体拉过来打自己，紫色减益落在敌人头上
       *   enemy + focus   —— 集火（池外）：被点名的敌人吃我方的火力，蓝色减益落在它自己头上
       * 同一方只留最后放的那个。
       * Provoke 另封对面的 EX（exLockedOf），但不进 stun，普通技能和普攻照跑。
       */
      case "taunt":
        for (const t of targets) {
          if (!t.alive) continue
          setTaunt(state.sides[t.side], t, eff.turns ?? 1, T, eff.kind || "provoke")
          ctx.log(t.tauntKind === "provoke"
            ? `  ${nameOf(t)} 嘲讽 ${t.taunt} 回合（敌方全体被拉过来）`
            : `  ${nameOf(t)} 被集火 ${t.taunt} 回合`)
          // Provoke 是加在敌人身上的减益，事件的目标写被拉走的那一方
          const marked = t.tauntKind === "provoke" ? state.sides[1 - t.side].units.filter((x) => x.alive) : [t]
          for (const m of marked) {
            emitEvent(ctx, { type: "debuff", source: unitRef(t), target: unitRef(m), effects: ["taunt"] })
          }
        }
        break

      // 往 Cost 池里加点（瞬的开局回费）。跟下面的 ex_discount 是两回事，别合并
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

      // EX 费用打折（纯子残血时 5 费 → 1 费，管接下来 2 次 EX）。
      // 重复施加直接覆盖，次数重新给满 —— 跟原作一样不叠加。
      case "ex_discount":
        for (const t of targets) {
          if (t.summon) continue
          t.exDiscount = { mode: eff.mode, value: eff.value, uses: eff.uses }
          ctx.log(`  ${nameOf(t)} EX 费用 ${tmplOf(t).ex.cost} → ${exCostOf(t)}（接下来 ${eff.uses} 次 EX）`)
          emitEvent(ctx, { type: "buff", source: unitRef(u), target: unitRef(t), effects: ["ex_discount"] })
        }
        break

      // 不死：接下来几轮血量掉不到 0。时长按敌方回合跳，见 endTurn
      case "immortal":
        for (const t of targets) {
          if (!t.alive) continue
          t.immortal = Math.max(t.immortal || 0, eff.turns)
          t.immortalSt = T
          ctx.log(`  ${nameOf(t)} 进入不死状态（${eff.turns}回合）`)
          emitEvent(ctx, { type: "buff", source: unitRef(u), target: unitRef(t), effects: ["immortal"] })
        }
        break

      /**
       * 纯子 EX 的自伤：「失去当前生命值的 25.7%」。
       *
       * **这不是伤害** —— 不吃防御、不判命中暴击、不进护盾，也不触发击杀。按当前血量取比例，
       * 所以数学上永远剩 74.3%，自己打不死自己；不死状态在这儿也就用不上。
       *
       * 数字走跟持续伤害同一个视觉通道（`dot: true`，橙色 + 左侧竖条、不画连线）——
       * 它同样是「没有施法者连线的掉血」，再发明第四种颜色只会让战场图更难读。
       */
      case "hp_cost":
        for (const t of targets) {
          if (!t.alive) continue
          const lost = Math.max(1, Math.round(t.hp * eff.rate))
          t.hp = Math.max(1, t.hp - lost)
          ctx.log(`  ${nameOf(t)} 自伤 ${lost}（当前生命 ${Math.round(eff.rate * 100)}%）`)
          emitEvent(ctx, {
            type: "damage", source: null, target: unitRef(t), dot: true, dotIcon: "SelfCost",
            amount: lost, totalAmount: lost, absorbed: 0,
            crit: false, critHits: 0, affinity: "none", attackType: "自伤",
          })
        }
        break
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
  // action.targets 是「这一发实际打到谁」，战场图按它画连线。
  // 连发 / 弹射会在结算过程中换人，先占位再回填，否则图上只剩第一发那条线。
  const actionEv = {
    type: "action", source: unitRef(u),
    action: actionKind,
    skillName: skill.name || null,
    kind: skill.hits ? "damage" : "support",
    targetType: skill.target || "enemy_single",
    targets: targets.map(unitRef),
  }
  emitEvent(ctx, actionEv)

  const hit = []
  if (skill.hits?.length) {
    if (skill.target === "enemy_chain") {
      // 连发：**只有第一发听玩家的**，后面每一发都照普攻的规则重锁一次
      //（人偶 → 前排 → 中排 → 后排），不再有「不能和上一发相同」那条 ——
      // 有前排就后两发全打前排，有人偶就全打人偶，这才是「视作普攻索敌」。
      // 每发都在结算之后重算，所以打死人会自动换目标（本战场清空就越界）。
      const first = targets[0]
      for (const [i, pct] of skill.hits.entries()) {
        const t = i === 0 && first?.alive ? first : laneTarget(u, foes)
        if (!t) break
        strike(ctx, u, t, [pct], actionKind)
        if (!hit.includes(t)) hit.push(t)
      }
    } else if (skill.target === "enemy_random") {
      // 弹射：每一段单独抽目标
      for (const pct of skill.hits) {
        const al = aliveOf(foes)
        if (!al.length) break
        const t = randPick(state, al)
        strike(ctx, u, t, [pct], actionKind)
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
        strike(ctx, u, t, cut ? base.map((h) => h * (1 - cut)) : base, actionKind)
        hit.push(t)
      }
    }
  }
  if (hit.length) actionEv.targets = hit.map(unitRef)

  applyEffects(ctx, u, skill, hit.length ? hit : targets, me)
}

/**
 * 普攻：对线锁定，分段独立判定。
 *
 * 处于强化形态时改用 `u.charge.hits`（原作的 `Skills.Normal.FormChange`），可能还打成扇形。
 * 存续有两种口径：鹤城按**发数**，打完一发扣一发；瞬按**轮数**，在 endTurn 里跳。
 *
 * 主目标仍然走 `laneTarget` —— 强化的是威力和覆盖面。**索敌是不是也变了由 charge.targeting 决定**，
 * 那是瞬独有的，鹤城不带这个字段。
 */
function autoAttack(ctx, u) {
  const tmpl = tmplOf(u)
  const c = u.charge
  if (c && (c.shots > 0 || c.turns > 0)) {
    if (c.shots > 0) c.shots -= 1
    execute(ctx, u, {
      target: c.count > 1 ? "enemy_adjacent" : "enemy_single", count: c.count,
      hits: c.hits, effects: [],
    }, "强化普攻", "normal")
    // 打完最后一发才清：清早了这一发就读不到 charge.targeting，瞬的最后一枪会打回对位
    if (c.shots != null && c.shots <= 0) u.charge = null
    tryAutoProc(ctx, u)
    return
  }
  // 普攻本身也可能是范围的（千世的圆形普攻），照模板里的 target/count 走
  execute(ctx, u, {
    target: tmpl.autoAttack.target || "enemy_single",
    count: tmpl.autoAttack.count || 1,
    hits: tmpl.autoAttack.hits, effects: [],
  }, "普攻", "normal")
  tryAutoProc(ctx, u)
}

// ---------------- 普通技能触发 ----------------

/** 普通技能是否就绪。冷却型看 skillCd，条件型看血量阈值，两者都受 maxUses 限制。 */
function skillReady(u) {
  const sk = tmplOf(u).skill
  const tr = sk?.trigger
  if (!sk || !tr) return false
  // 普攻 / 击杀触发不进技能阶段，分别跟着普攻和击杀掉落走；
  // 战斗开始时（瞬的开局回费）在建局时就结算完了
  if (tr.type === "on_auto" || tr.type === "on_kill" || tr.type === "battle_start") return false
  if (tr.maxUses && u.skillUses >= tr.maxUses) return false
  if (tr.type === "hp_below") return u.hp / u.maxhp <= tr.value
  return u.skillCd <= 0
}

function consumeSkill(u) {
  const tr = tmplOf(u).skill.trigger
  u.skillUses += 1
  if (tr.type === "on_kill") u.skillCd = tr.turns || 0
  else u.skillCd = (tr.type === "cooldown" || tr.type === "on_auto") ? tr.turns : 99
}

/** 鹤城 / 莲见：自己击杀掉才触发。鹤城有 10 秒 CD，莲见每刀都能换弹补枪。 */
function tryKillProc(ctx, u) {
  const sk = tmplOf(u).skill
  const tr = sk?.trigger
  if (tr?.type !== "on_kill" || !u.alive) return
  if (tr.maxUses && u.skillUses >= tr.maxUses) return
  if (u.skillCd > 0) return
  consumeSkill(u)
  execute(ctx, u, sk, `普通技能「${sk.name}」`, "skill")
  if (sk.thenAutoAttack && u.alive && !checkEnd(ctx.state)) autoAttack(ctx, u)
}

/** 泉 / 明里：普攻出手后按概率触发普通技能，只有触发成功才进冷却。 */
function tryAutoProc(ctx, u) {
  const sk = tmplOf(u).skill
  const tr = sk?.trigger
  if (tr?.type !== "on_auto" || !u.alive) return
  if (tr.maxUses && u.skillUses >= tr.maxUses) return
  if (u.skillCd > 0) return
  if (nextRandom(ctx.state) >= (tr.chance ?? 1)) return
  consumeSkill(u)
  execute(ctx, u, sk, `普通技能「${sk.name}」`, "skill")
}

// ---------------- 回合结算 ----------------

/**
 * 状态都从施放瞬间写入，时长一律按「**它真正起作用的 N 个攻击窗口**」计：
 * 防御向（含护盾、不死、嘲讽）跟敌方回合跳，进攻向与控制、持续治疗跟自己方回合跳。
 * 判据见 `DEFENSIVE_STATS` 的注释。
 */
function endTurn(ctx, side) {
  const { state } = ctx
  const T = state.turnId
  const ticking = side.side

  for (const s of state.sides) {
    for (const u of s.units) {
      if (!u.alive) continue
      for (const b of [...u.buffs]) {
        // 防御向跟敌方回合跳，其余跟承受者自己跳；**不再需要「跳过施放回合」的守卫**，
        // 四种组合（自身/给敌人 × 进攻/防御）靠这一条就都对齐了。判据见 DEFENSIVE_STATS
        const tickSide = DEFENSIVE_STATS.has(b.stat) ? 1 - u.side : u.side
        if (tickSide !== ticking || b.turns >= 9999) continue
        b.turns -= 1
        if (b.turns <= 0) u.buffs.splice(u.buffs.indexOf(b), 1)
      }
      // 护盾、不死跟防御向属性同一把尺子：挡的都是敌人的攻击窗口。
      // `!== T` 那道守卫留着是兜底 —— 这两样只可能在自己回合上，按敌方回合跳时它永远不会触发
      const shieldTick = Number.isInteger(u.shieldTickSide) ? u.shieldTickSide : 1 - u.side
      if (u.shieldTurns > 0 && shieldTick === ticking && u.shieldSt !== T) {
        u.shieldTurns -= 1
        if (u.shieldTurns <= 0) { u.shield = 0; u.shieldMax = 0; u.shieldTurns = 0 }
      }
      if (u.immortal > 0 && 1 - u.side === ticking && u.immortalSt !== T) u.immortal -= 1
      // 嘲讽也是防御向：它换来的是敌人的一次出手。跟人偶的入场 Provoke 同一把尺子 ——
      // 两者共用一个嘲讽位（见 setTaunt），计时口径当然也得一样
      if (u.taunt > 0 && 1 - u.side === ticking && u.tauntSt !== T) u.taunt -= 1
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
        // 场地/灼烧也杀不死不死状态的人 —— 它拦的是「掉到 0」，不分伤害来源
        if (u.hp <= 0 && u.immortal > 0) u.hp = 1
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

    // 眩晕吃掉的是**自己**的一次出手，所以跟自己方的回合跳（嘲讽已经挪到上面的敌方回合了）
    if (u.stun > 0 && u.stunSt !== T) u.stun -= 1
    if (u.skillCd > 0 && u.skillCd < 99) u.skillCd -= 1

    // 按轮数存续的强化形态（瞬的 30 秒 = 6 轮）在自己的回合跳，**施放回合就算第 1 轮** ——
    // 跟随行的进攻向 Buff（暴击 +26%）同一把尺子 —— 都在她出手时生效，两者同轮到期。
    // 施放那一轮她忙着放 EX 没有普攻，所以 6 轮里实际打出 5 发强化普攻。
    if (u.charge?.turns > 0 && --u.charge.turns <= 0) u.charge = null
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
  const cast = resolved.casts[0]
  const u = side.units[cast.pos]
  if (!u) return `没有 ${cast.pos + 1} 号位`
  if (!u.alive) return `${nameOf(u)} 已经倒下了`
  const wait = exWaitOf(side, u)
  if (wait > 0) return `${nameOf(u)} 的 EX 还在冷却，还需本方再放出 ${wait} 个 EX`
  const lock = exLockedOf(draft, u)
  if (lock) return `${nameOf(u)} 被${lock}，放不出 EX`
  const cost = exCostOf(u)
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
    // 交出去就刷新：下一位看见的图必须已经是清过冷却的状态
    const next = state.sides[state.activeSide]
    const nextTag = state.activeSide === 0 ? "蓝" : "红"
    refreshExOnCasualty(next, () => lines.push(`[${nextTag}] 有人阵亡，全员 EX 冷却清空`))
    if (state.activeSide === state.first) {
      if (state.round >= CFG.MAX_ROUND) settle(state)
      else state.round += 1
    }
  }

  // ② 玩家指令：最多一个 EX
  if (action.type === "ex") {
    const cast = resolveCasts(state, action).casts[0]
    const u = side.units[cast.pos]
    if (u?.alive && !exLockedOf(state, u) && exWaitOf(side, u) <= 0) {
      const ex = tmplOf(u).ex
      // 打过折的按折后价扣，并消耗一次额度 —— 无论这一发是不是真省了钱
      const cost = exCostOf(u)
      if (side.cost >= cost) {
        side.cost -= cost
        spent += cost
        consumeExDiscount(u)
        markExCast(side, u)
        state.turnEx = [...(state.turnEx || []), u.idx]
        execute(ctx, u, ex, `EX「${ex.name}」(-${cost})`, "ex", cast.target)
        // 「立即换弹」不是把普攻塞进 EX 里：EX 只上形态 / 增益，普攻留到 ③-b。
        // 鹤城、芹香都是这种。瞬没有这条，施放回合就不普攻。
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
  // usedEx：放过 EX 的人。③-a 一律跳过（小技能留到下回合）。
  // ③-b 默认也跳，但 thenAutoAttack（立即换弹）的人本回合仍普攻，跟没放 EX 的人一起结算。
  // 立即换弹 ≠ 形态转换：芹香只有加攻，鹤城 / 瞬才有 u.charge。
  const usedEx = new Set(state.turnEx || [])
  const acted = new Set()
  const foes = () => state.sides[1 - state.activeSide]

  // ③-a 普通技能。控制在这一阶段结算，被控的人后面也不普攻
  for (const u of side.units) {
    if (sideDead(foes())) break
    if (!u.alive || usedEx.has(u.idx)) continue
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

  // ③-b 普攻。放过 EX 的人默认不打；立即换弹的（鹤城 / 芹香）在这里补，不跟 EX 画在同一张图里。
  for (const u of side.units) {
    if (sideDead(foes())) break
    if (!u.alive || acted.has(u.idx)) continue
    if (usedEx.has(u.idx) && !tmplOf(u).ex?.thenAutoAttack) continue
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
