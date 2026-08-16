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
 * 四种组合都自然对齐：
 *   - 自身防御增益（椿的 +28% 防御）在自己回合上，那一回合 ticking 是自己方，天然不扣
 *   - 给敌人的减防（茜的 −29%）承受者是敌人，`1 - u.side` 正是自己方，当场扣一格 ——
 *     而本方这一回合的普攻正好吃得到，对齐
 *   - 自身进攻增益（野宫的 +22% 攻击）施放回合就得算，因为 ③-b 她马上要打
 *   - 给敌人的减命中承受者是敌人，跟着敌人的回合跳
 *
 * **还有第三类：`startNext`（从下个己方回合才开始跳）。** 它跟本表无关，是另一个维度——
 * 上面那条「③-b 她马上要打」只对**普通技能**成立；EX 给施放者自己上的进攻向增益，
 * 施放那一轮他 ③-a / ③-b 都不出手（带「立即换弹」的除外），那一轮压根不是攻击窗口。
 * 别把它理解成「跟椿对齐」——椿是防御向、跟敌方回合跳，本来就轮不到施放回合。
 *
 * 曾经这里叫 `CURRENT_TURN_STATS`（「进攻类」），却塞着 `dfs` / `dmg_take` 两个防御向属性，
 * 而且按**施加者**分side —— 对减防是对的，对自身防御增益就白扣一格（椿 6 回合只挡得住 5 次）。
 * 同时 `acc` 漏在集合外，野宫同一个技能里 4 回合的命中增益反而比攻击增益多管一轮。
 */
const DEFENSIVE_STATS = new Set([
  "dfs", "dfs_flat", "dmg_take", "dodge", "crit_res", "crit_dmg_res_flat",
  // 切里诺普技减的是系数档，跟爱用品那档 `_flat` 同一把防御向尺子
  "crit_dmg_res",
])

/** 控制类效果的中文名。原数据只给英文 Icon，写死一张表比逐个判断可靠 */
const CC_TEXT = {
  Stunned: "眩晕", Fear: "恐惧", Provoke: "嘲讽", Slow: "减速",
  Confuse: "混乱", Sleep: "睡眠", Silence: "沉默", Bind: "束缚",
}

/** 爱丽丝的能量充能三档，日志里印中文才读得懂 */
const ENERGY_TEXT = ["空", "半充", "满充"]

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
  crit_res: "暴击抵抗", crit_dmg_res_flat: "暴伤抵抗", crit_dmg_res: "暴伤抵抗",
  enh_Explosion: "爆发增伤", enh_Pierce: "贯通增伤", enh_Mystic: "神秘增伤", enh_Sonic: "振动增伤", enh_Chemical: "变化增伤",
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
/**
 * 「这一回合他开了几枪的份量」。攻速（`aa`）在本项目里的**唯一含义就是射速**，
 * 而射速有**三个出口**，少接一个，给队友加攻速的角色就会被系统性低估：
 *
 * | 出口 | 在哪 |
 * |---|---|
 * | 普攻伤害 ×aa | `strike` 的 `dealF *= factorOf(src,"aa")` |
 * | 射击计数攒得更快（泉奈的「每 6 枪」） | `tryAutoProc` 的 `autoCount += shotsOf(u)` |
 * | 命中触发的概率更高（泉 / 明里的「普攻时 N%」） | `autoProcChance` |
 *
 * 所以**攻速比等值的「普攻增伤」更值钱**，这是原作里就成立的关系，不是本项目的加成。
 * 真·「造成伤害增加」以后进池要用 `dmg_deal`，它只有第一个出口，别跟 `aa` 共用一层。
 *
 * 下限跟 `accOf` / `dodgeOf` 一个写法：再重的减速也不能让计数彻底停死。
 */
const shotsOf = (u) => Math.max(0.2, factorOf(u, "aa"))

/**
 * 「普攻时 N% 概率」在攻速加持下的实际触发率。
 *
 * 一回合开了 `shots` 枪的份量、每枪 `p` 概率，至少中一次 = `1 − (1−p)^shots`
 * ——「k 次独立试验至少成功一次」推广到小数枪数。`shots = 1` 时正好还原成 `p`。
 * 减攻速（爱理 −18.5% / 朱莉 −18.2%）走同一条式子，方向自然反过来。
 */
export function autoProcChance(u, chance) {
  const p = chance ?? 1
  if (p >= 1) return 1
  return 1 - (1 - p) ** shotsOf(u)
}

const critResOf = (u) => Math.max(0, tmplOf(u).critRes * Math.max(0, factorOf(u, "crit_res")))
// 暴伤抵抗有两档来源：爱用品给的是固定值（`_flat`），切里诺的普技减的是系数
const critDmgResOf = (u) =>
  Math.max(0, (tmplOf(u).critDmgRes + flatOf(u, "crit_dmg_res_flat")) * Math.max(0, factorOf(u, "crit_dmg_res")))

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
    // taunt = Provoke（椿 / 人偶）：这个单位吃掉对面的刀
    // focus = ConcentratedTarget（切里诺）：被点名的人吃己方的刀。两套独立，见 setTaunt
    taunt: 0, tauntSt: -1, tauntKind: null,
    focus: 0, focusSt: -1,
    // 普通技能：「每 X 秒」是周期，第一次落在 X 秒而不是开局，所以起始压满冷却；
    // 条件型（血量阈值）与战斗开始时都用 99 表示「不靠冷却解锁」；
    // 普攻触发（泉 / 明里）第一次就能 roll，起始 0
    // 「每 X 秒」是周期，第一次落在 X 秒而不是开局，所以起始压满；
    // 「(冷却 X 秒)」（`icd`）是**再次使用的间隔**，靠条件门控，起始给 0 才对，跟 on_auto 同理
    skillCd: tmpl.skill?.trigger?.type === "cooldown" ? (tmpl.skill.trigger.icd ? 0 : tmpl.skill.trigger.turns)
      : (tmpl.skill?.trigger?.type === "on_auto" || tmpl.skill?.trigger?.type === "on_kill") ? 0 : 99,
    skillUses: 0,
    // 「每进行 N 次普通攻击」（泉奈）已经打出去几枪。冷却型不用它，见 tryAutoProc
    autoCount: 0,
    // 强化形态：{hits, count, shots?|turns?, targeting?}
    // 鹤城按发数（EX 之后的两发普攻），瞬按轮数并改索敌
    charge: null,
    // 不死：血量掉不到 0，按**敌方**回合跳（跟护盾同口径，挡的是敌人的攻击窗口）
    immortal: 0, immortalSt: -1,
    // 自身状态，只供 altHits 换倍率，不改面板：
    //   fury（妮露）有时长，跟自己回合跳；energy（爱丽丝）是 0~2 档，没有时长
    fury: 0, furySt: -1,
    energy: tmpl.skill?.stateStart?.key === "energy" ? tmpl.skill.stateStart.value : 0,
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

/**
 * 交换两个己方单位的站位（泉奈的位移）。
 *
 * **必须同时换数组位置和 `idx`**，保持 `units[i].idx === i` 这条不变量 ——
 * `resolveCasts` / `resolveTargets` / `validateAction` 都直接拿号位当下标索引，
 * 战场图也是按数组顺序铺 grid 列的。两个一起换之后：
 *   - 图上小人直接走到新的一列，四格仍然一格一人，不会叠人
 *   - 战场分割、对位锁定、AoE 相邻窗口全部自动跟着走
 *   - 冷却 / 增益 / 血量都挂在单位对象上，跟着对象走，不用搬
 */
function swapPos(state, side, a, b) {
  const i = a.idx, j = b.idx
  side.units[i] = b
  side.units[j] = a
  a.idx = j
  b.idx = i
  // 本回合「谁已经放过 EX」是按号位记的，不跟着换的话 ③-a / ③-b 会把两个人搞反：
  // 换完位的泉奈会被当成没放过 EX 而多打一次普攻
  state.turnEx = (state.turnEx || []).map((p) => (p === i ? j : p === j ? i : p))
}

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
 * 上嘲讽 / 集火。原作是两套机制，必须分槽：
 *
 *   - `provoke`（椿、人偶）挂在 `u.taunt`：减益落在**被拉走的敌人**身上（紫底感叹号）
 *   - `focus`（集火 / `ConcentratedTarget`，切里诺）挂在 `u.focus`：减益落在**被点名的那个人**身上（蓝底靶心）
 *
 * **同 kind 只留一层**（后放的覆盖先放的），两种之间互不覆盖。
 * 开火时嘲讽优先于集火，见 `tauntTargetOf`。单位和召唤物共用各自那个槽：
 * 人偶入场 Provoke 和椿的 EX 会互相顶掉，但切里诺的集火不会把椿的嘲讽清掉。
 */
function setFocus(side, target, turns, turnId) {
  for (const u of side.units) {
    u.focus = 0
    u.focusSt = -1
    // 旧数据曾把集火写在 taunt + kind=focus 上，换槽时清掉以免双计
    if (u.tauntKind === "focus") { u.taunt = 0; u.tauntSt = -1; u.tauntKind = null }
  }
  for (const s of side.summons || []) {
    s.focus = 0
    if (s.tauntKind === "focus") { s.taunt = 0; s.tauntKind = null }
  }
  target.focus = turns
  target.focusSt = turnId
}

function setTaunt(side, target, turns, turnId, kind = "provoke") {
  if (kind === "focus") { setFocus(side, target, turns, turnId); return }
  for (const u of side.units) {
    if (u.tauntKind === "focus") continue
    u.taunt = 0; u.tauntSt = -1; u.tauntKind = null
  }
  for (const s of side.summons || []) {
    if (s.tauntKind === "focus") continue
    s.taunt = 0; s.tauntKind = null
  }
  target.taunt = turns
  target.tauntSt = turnId
  target.tauntKind = "provoke"
}

const isProvoke = (u) => u.alive && u.taunt > 0 && (u.tauntKind || "provoke") === "provoke"
const isFocus = (u) => u.alive && (u.focus > 0 || (u.taunt > 0 && u.tauntKind === "focus"))

/** 这一方当前把对面刀吸过来的目标。嘲讽优先于集火；召唤物也算 */
const tauntTargetOf = (side) => {
  const sm = side.summons || []
  return sm.find(isProvoke) || side.units.find(isProvoke)
    || side.units.find(isFocus) || sm.find(isFocus) || null
}

/** 这个单位现在是不是被集火（蓝底靶心画在他自己头上） */
export function focusedOf(u) {
  return Boolean(isFocus(u))
}

/**
 * 这个单位是不是正被对面 Provoke 住（刀只能往那边扔）。
 * **Provoke 的减益标记落在被拉走的人身上，不是施法者身上** —— 原作就是这么画的：
 * 中了嘲讽的人头上顶一个紫色感叹号，放嘲讽的那个反而什么都不多。
 * @returns {object|null} 把它拉住的那个单位/召唤物
 */
export function provokedBy(state, u) {
  if (!u?.alive) return null
  const foe = state.sides[1 - u.side]
  // 只认 Provoke。tauntTargetOf 还会返回集火目标，集火不封 EX
  return (foe.summons || []).find(isProvoke) || foe.units.find(isProvoke) || null
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
 * 「优先攻击攻击力最高的敌方单位」。两个来源，同一套规则：
 *   - 瞬的强化形态改写索敌（`u.charge.targeting`），管她接下来 6 轮的普攻
 *   - 柚子那种技能自带的「以 1 名攻击力最高的敌方单位为中心」（`skill.pick`）
 *
 * **这套索敌只有嘲讽拉得走**，别的一概不管 —— 战场分割、前/中/后排、人偶挡刀全部绕开，
 * 瞬站 4 号位照样一枪打到对面 1 号位的主 C 头上。那正是这个 EX 花 3 费买的东西：
 * 把「站位决定打谁」这条规则在 6 轮里关掉。
 *
 * 嘲讽在 laneTarget 更前面就返回了，所以这里不用再判一次。
 * 敌方活人打光时返回 null，落回通用逻辑去拆墙（人偶）。
 */
function maxAtkTarget(u, alive, forced = false) {
  if ((!forced && u.charge?.targeting !== "max_atk") || !alive.length) return null
  // 攻击力相同就取号位小的：reduce 只在严格大于时换人
  return alive.reduce((m, f) => (atkOf(f) > atkOf(m) ? f : m))
}

/**
 * 普攻 / 普通技能的对线锁定，按优先级：
 *   1. 嘲讽（Provoke）—— 最高，直接无视战场分割
 *   2. 集火（ConcentratedTarget，切里诺）—— 己方攻击锁在被点名的那个人
 *   3. 索敌改成「打攻击力最高的」（瞬的强化形态 / 柚子的技能自带），见 maxAtkTarget
 *   4. **同战场的佩洛洛**：挡在那半边最前面，嘲讽过期了也一样。本战场打空要越界时也先拆墙
 *   5. 同战场的前排 → 中排 → 后排。不是职业，是角色自己的 Front/Middle/Back
 *   6. 本战场空了才越界，跨过去还是前 → 中 → 后
 *   7. 同一层里：对位 → |位置差| 最小 → 编号小
 * @param {boolean} maxAtk 技能自带的「攻击力最高」索敌（skill.pick），与瞬的形态索敌同档
 * @param {{ignoreTaunt?: boolean}} [opts] 切里诺普技的集火是**选人条件**，嘲讽改不了落点
 */
function laneTarget(u, foes, maxAtk = false, opts = {}) {
  // 嘲讽 > 集火，无视一切 —— 战场分割、前排、挡刀、瞬的强化索敌统统让路。
  // 嘲讽同槽只留一个（人偶入场 Provoke 和椿的 EX 会互相顶掉）；集火另开一槽，见 setTaunt。
  const taunting = tauntTargetOf(foes)
  if (taunting && !opts.ignoreTaunt) return taunting

  const sm = summonsOf(foes)
  const alive = aliveOf(foes)
  const topAtk = maxAtkTarget(u, alive, maxAtk)
  if (topAtk) return topAtk
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
 * 己方就近：**同战场优先 → |号位差| 最小 → 编号小**。跟 laneTarget 的分层口径对称，
 * 但不含「自己」那一档 —— 由调用方决定要不要把自己放进 pool。
 */
function nearestAlly(u, pool) {
  const same = pool.filter((a) => zoneOf(a.idx) === zoneOf(u.idx))
  const list = same.length ? same : pool
  return list.reduce((best, a) => {
    const da = Math.abs(a.idx - u.idx), db = Math.abs(best.idx - u.idx)
    return da < db || (da === db && a.idx < best.idx) ? a : best
  })
}

/**
 * 己方目标未指定时的默认选择，规则与 laneTarget 对称：
 * 对位（对自己而言就是自己）→ 同战场最近 → 全场最近。
 */
function allyLaneTarget(u, allies) {
  if (u.alive) return u
  const alive = aliveOf(allies)
  return alive.length ? nearestAlly(u, alive) : null
}

/**
 * @param {object} pick 玩家指定的目标 {scope:'foe'|'ally', idx:0-3}，可为空
 * @returns {Array<object>} 命中的单位列表（AoE 无衰减，每个目标吃全额）
 */
function resolveTargets(state, u, skill, foes, allies, pick, actionKind) {
  let tg = skill.target || "enemy_single"
  const count = skill.count || 1
  /**
   * 「一个圈，砸哪边就只有那边生效」（小春的神圣手榴弹，全 272 人只有她）。
   * 原文是「对圆形范围内的**我方**单位回复 / 对上述范围内的**敌方**单位造成伤害」，
   * 但那个圈半径只有 200、投掷距离 950 —— 敌我两队隔着整个场地，
   * **圈里不可能同时站着两边的人**，所以这两半永远只成立一个。
   *
   * 指令层用中间那个动词选边：`小春ex打白子` 是伤害圈，`小春ex奶桃` 是治疗圈。
   * 选了己方就整发换成己方那一套 adjacent（同战场同身位 2 人），伤害在 `execute` 里跳过。
   */
  if (skill.circle && pick?.scope === "ally") tg = "ally_adjacent"

  if (tg === "self") return [u]
  if (tg === "ally_all") return aliveOf(allies)
  /**
   * 单体奶（绿 / 小春）：「对 1 名**除自身外**生命值（百分比最低 / 不高于 N%）的我方单位」。
   * 两个限定都只写在描述里，漏掉的话小春会自己奶自己、绿会奶满血的人。
   *
   * **两种选人规则分开**：
   *   `ally_lowest`（绿）原文写「生命值百分比**最低**」→ 按血量挑，并列时再按站位就近
   *   `ally_hurt`（小春）原文只写「不高于 50%」，**没说最低** → 够格的人里按站位就近喂
   *
   * 没人够格就返回空，`execute` 会当作没放 —— 既不进冷却，也不占掉她这一轮的普攻。
   */
  if (tg === "ally_lowest" || tg === "ally_hurt") {
    let al = aliveOf(allies)
    if (skill.exceptSelf) al = al.filter((a) => a !== u)
    if (skill.hpMax != null) al = al.filter((a) => a.hp / a.maxhp <= skill.hpMax)
    if (!al.length) return []
    if (tg === "ally_hurt") return [nearestAlly(u, al)]
    const min = Math.min(...al.map((a) => a.hp / a.maxhp))
    return [nearestAlly(u, al.filter((a) => a.hp / a.maxhp - min < 1e-9))]
  }
  if (tg === "enemy_all") return aliveOf(foes)
  // 循环点名（绿）：落点由**她自己的号位**定死，玩家指不了 —— 逐发在 execute 里算
  if (tg === "enemy_cycle") return aliveOf(foes)

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
  // `skill.pick === "max_atk"`（柚子）只在这里生效：玩家指了目标就以玩家为准。
  if (!primary) {
    // 切里诺普技的「攻击力最高」是选人条件，不是开火：嘲讽拉得走柚子那种带伤害的最高攻索敌，
    // 但改不了集火标记落在谁头上。过期之后火力还得锁回那个最高攻的人。
    const markFocus = skill.pick === "max_atk"
      && (skill.effects || []).some((e) => e.type === "taunt" && e.kind === "focus")
    primary = tg.startsWith("ally")
      ? allyLaneTarget(u, allies)
      : laneTarget(u, foes, skill.pick === "max_atk", { ignoreTaunt: markFocus })
  }
  if (!primary) return []
  // 召唤物不在 pool.units 里，扩散算不出邻居；打到它就只打它
  if (primary.summon) return [primary]

  // 范围技的落点只要碰到召唤物所在的**战场**，整发就被它接走 —— 它是挡在那半边前面的墙，
  // 跟 laneTarget 里的挡刀同一条口径（按战场，不按号位）。
  // 2 目标的覆盖面本来就是主目标那个战场；3 目标是中心窗口，跨到哪半边就被哪半边的墙接。
  // 只挡敌方那一侧：小春的治疗圈落在己方，自己家的墙没有理由吃掉自己的奶。
  if (tg.startsWith("enemy") && tg.endsWith("adjacent") && count > 1) {
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
    // 己方那一侧同理 —— 小春的治疗圈跟她的伤害圈是同一个圈，一样是同战场同身位 2 人。
    if (count > 1 && skill.depth !== "through") {
      return sameLineHits(hits, primary, count)
    }
    return hits
  }
  return [primary]
}

// ---------------- 伤害 ----------------

function applyDamage(ctx, src, tgt, dmg, meta = {}) {
  const total = dmg
  const wasAlive = tgt.alive
  let absorbed = 0
  if (tgt.shield > 0) {
    absorbed = Math.min(tgt.shield, dmg)
    tgt.shield -= absorbed
    dmg -= absorbed
    if (tgt.shield <= 0) { tgt.shield = 0; tgt.shieldMax = 0; tgt.shieldTurns = 0 }
  }
  tgt.hp -= dmg
  // 不死：伤害照吃、血条照掉，只是**掉不到 0**。护盾先扣完再轮到它兜底，两者不冲突
  const saved = tgt.hp <= 0 && tgt.immortal > 0 && wasAlive
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
    // 同时锁定的后手仍会打到这个人（伤害照记、图也照画），但击杀只认第一次掉到 0 的那个人
    if (wasAlive) {
      tgt.alive = false
      tgt.taunt = 0
      tgt.focus = 0
      tgt.regens.length = 0
      tgt.dots.length = 0
      ctx.log(`  ✝ ${nameOf(tgt)} ${tgt.summon ? "被打碎" : "倒下"}`)
      if (src && src !== tgt && src.alive) tryKillProc(ctx, src)
    }
  }
}

/**
 * 对单个目标打出一组分段攻击。每段独立判定命中与暴击（与原作一致），
 * 因此段数越多伤害方差越小；结算后合并成一条伤害事件，避免刷屏。
 */
/**
 * 按目标当前血量改这一发的倍率（`TargetHpRateModifier`）。
 * lo/hi 是血量百分比，atLo 对应最低血、atHi 对应最高血，中间线性。
 */
function hpRateMult(mod, tgt) {
  if (!mod || !tgt?.maxhp) return 1
  const hp = Math.max(0, Math.min(1, tgt.hp / tgt.maxhp))
  const span = (mod.hi ?? 1) - (mod.lo ?? 0)
  const t = span === 0 ? 0 : Math.max(0, Math.min(1, (hp - (mod.lo ?? 0)) / span))
  return mod.atLo + t * (mod.atHi - mod.atLo)
}

function strike(ctx, src, tgt, hits, actionKind, skill) {
  const { state } = ctx
  // 同时锁定的后手可以打在已经倒下的人身上（原作同一拍，伤害不丢）。
  // 击杀触发只在 applyDamage 里认「第一次掉到 0」。
  if (!src.alive || !tgt) return 0

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
  // 属性增伤（爱用品，桃给绿的 +13.2% 贯通）。按**攻击者自己的弹种**匹配，
  // 所以同一层给不同弹种的队友，效果不一样 —— 原作就是这么设计的
  dealF *= factorOf(src, `enh_${tmplOf(src).bullet}`)
  dealF *= hpRateMult(skill?.hpRate, tgt)
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

/**
 * 非伤害效果的作用域。默认（`enemy`）跟随伤害目标。
 *
 * - `ally_target` 单体奶选中的那一个人（绿 / 小春的普技）。跟默认分支同义，
 *   但名字不同才读得出「这是我方那一个」而不是「打到的敌人」
 * - `ally_named`  指名给某个队友，人不在场就整条不生效（绿 ⇄ 桃 的联动）
 * - `circle_ally` 圈里的我方单位（小春的神圣手榴弹）。圈砸在对面时这里**返回空** ——
 *   敌我隔着整个场地，一个圈装不下两边，「打」和「奶」永远只成立一个
 */
function scopeTargets(scope, u, allies, dmgTargets, eff) {
  if (scope === "self") return [u]
  if (scope === "ally_all") return aliveOf(allies)
  if (scope === "ally_named") {
    const t = allies.units.find((a) => a.id === eff?.ally && a.alive)
    return t ? [t] : []
  }
  if (scope === "circle_ally") {
    return dmgTargets.filter((t) => t.side === u.side && !t.summon && t.alive)
  }
  return dmgTargets.filter((t) => t.alive)
}

/**
 * 条件追伤：状态到了哪一档就换哪一组倍率。`altHits` 按档位从高到低排好，取第一个满足的。
 * 妮露的 `fury` 是「有没有」（0/1），爱丽丝的 `energy` 是 0/1/2 三档。
 */
function altHitsOf(u, skill) {
  for (const a of skill.altHits || []) {
    const cur = a.state === "fury" ? (u.fury > 0 ? 1 : 0) : (u.energy || 0)
    if (cur >= a.min) return a.hits
  }
  return null
}

/**
 * @param {object} [pick] 玩家指定的目标，位移要用它决定换到哪一格
 * @param {"ex"|"skill"|"normal"} [actionKind] 决定自身进攻向增益是不是「从下个己方回合才跳」
 */
function applyEffects(ctx, u, skill, dmgTargets, allies, pick, actionKind) {
  const { state } = ctx
  const T = state.turnId
  const me = state.sides[u.side]

  /**
   * 第三类时长口径：**EX 给施放者自己上的进攻向增益，从下个己方回合才开始跳**。
   *
   * 「施放回合就算第 1 轮」那条只对**普通技能**成立 —— ③-a 上完 ③-b 她马上就要打。
   * EX 不一样：放过 EX 的人 ③-a 一律跳过、③-b 默认也跳过，那一轮他**根本不出手**，
   * 不是这层增益的攻击窗口。带「立即换弹」的（菲娜 / 鹤城 / 芹香）那一轮真的普攻了，照扣。
   *
   * 只认「自己给自己」：EX 给**队友**的增益，队友那一轮照常在 ③-b 出手，扣得对。
   */
  const startNext = actionKind === "ex" && !skill.thenAutoAttack

  for (const eff of skill.effects || []) {
    if (eff.inactive) continue // 技能 1 级时数值为 0，别占一层 buff
    // 编队条件（绿 ⇄ 桃）：那位队友没同时上场，这条效果整条不生效
    if (eff.ifAlly && !me.units.some((a) => a.id === eff.ifAlly)) continue
    const targets = scopeTargets(eff.scope, u, allies, dmgTargets, eff)
    switch (eff.type) {
      case "buff": {
        // 暴击伤害系的固定值单位是万分比，印原始数字玩家读不懂
        const bp = eff.stat === "crit_dmg_flat" || eff.stat === "crit_dmg_res_flat"
        const shown = bp ? `${Math.round(eff.value / 100)}%`
          : /_flat$/.test(eff.stat) ? eff.value : `${Math.round(eff.value * 100)}%`
        for (const t of targets) {
          const st = makeStatus(eff, T, u, eff.value < 0 ? "debuff" : "buff")
          // 进攻向的层才有「攻击窗口」可言；防御向本来就跟敌方回合跳，轮不到施放回合
          if (startNext && t === u && !DEFENSIVE_STATS.has(eff.stat)) st.startNext = true
          upsertStatusLayer(t.buffs, st)
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
          // 按轮数存续的（瞬）跟自身进攻增益同一把尺子：施放那一轮她不普攻，
          // 从下个己方回合才开始跳，30 秒换来的就是 6 发强化普攻而不是 5 发。
          // 按发数的（鹤城）本来就是打一发扣一发，与回合无关。
          ...(eff.turns != null ? { turns: eff.turns, st: startNext ? T : -1 } : {}),
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
          taunt: 0, tauntKind: null, focus: 0, turns: eff.turns, turnsMax: eff.turns, st: T,
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
       * 位移（泉奈的「位移至指定位置」）：**与相邻号位的队友交换站位**。
       *
       * 回合制没有连续坐标，但**有站位** —— 战场分割（1·2 / 3·4）和对位锁定都由号位定，
       * 所以换一格是真正的博弈：站在 2 / 3 号位时那一跳才跨得过战场分界线，
       * 站在 1 / 4 号位只能在自己这半边挪，换的是对位不是战场。
       *
       * 换位而不是「挪过去」——四个格子仍然一格一人，战场图不会叠人（见 swapPos）。
       * **不指定就不动**：位移是玩家花 Cost 买的选择权，替他猜一个反而更难预测。
       * 位置永久生效，直到她再换一次（原作的位移也没有时长）。
       */
      case "reposition": {
        const dest = pick?.scope === "ally" && pick.idx != null && !pick.summon ? me.units[pick.idx] : null
        if (!dest || dest === u) { ctx.log(`  ${nameOf(u)} 没指定换到哪一格，留在原位`); break }
        if (Math.abs(dest.idx - u.idx) > (eff.range ?? 1)) {
          ctx.log(`  ${nameOf(dest)} 不在隔壁，${nameOf(u)} 留在原位`)
          break
        }
        const crossed = zoneOf(u.idx) !== zoneOf(dest.idx)
        swapPos(state, me, u, dest)
        ctx.log(`  ${nameOf(u)} 与 ${nameOf(dest)} 交换站位${crossed ? "（跨过战场分界）" : ""}`)
        break
      }

      /**
       * 嘲讽 / 集火。scope 决定谁来吃刀，kind 决定状态格画给谁看（见 setTaunt）：
       *   self  + provoke —— 椿：她把敌方全体拉过来打自己，紫色减益落在敌人头上
       *   enemy + focus   —— 切里诺：被点名的敌人吃我方的火力，蓝色减益落在它自己头上
       * 同 kind 只留最后放的那个；两种互不覆盖，开火时嘲讽优先。
       * Provoke 另封对面的 EX（exLockedOf），但不进 stun，普通技能和普攻照跑。
       * 集火不封 EX。
       */
      case "taunt":
        for (const t of targets) {
          if (!t.alive) continue
          const focus = (eff.kind || "provoke") === "focus"
          setTaunt(state.sides[t.side], t, eff.turns ?? 1, T, eff.kind || "provoke")
          ctx.log(focus
            ? `  ${nameOf(t)} 被集火 ${t.focus} 回合`
            : `  ${nameOf(t)} 嘲讽 ${t.taunt} 回合（敌方全体被拉过来）`)
          // Provoke 是加在敌人身上的减益，事件的目标写被拉走的那一方
          const marked = focus ? [t] : state.sides[1 - t.side].units.filter((x) => x.alive)
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

      /**
       * 自身状态：本身不改任何面板，只是「有没有 / 到第几档」，供 `altHits` 换倍率。
       *
       *   `fury`（妮露）  —— 有时长，跟自己回合跳，在期间 EX 倍率 ×2
       *   `energy`（爱丽丝）—— **没有时长**，一档一档攒，放完 EX 清零
       *
       * 两个都只对施放者自己有意义，所以不做叠层，直接写在单位上。
       */
      case "state":
        for (const t of targets) {
          if (!t.alive || t.summon) continue
          if (eff.key === "energy") {
            const before = t.energy || 0
            t.energy = eff.step != null
              ? Math.min(eff.max ?? 2, before + eff.step)
              : (eff.value ?? 0)
            if (t.energy === before) continue
            ctx.log(`  ${nameOf(t)} 能量充能 ${ENERGY_TEXT[before]} → ${ENERGY_TEXT[t.energy]}`)
          } else {
            t.fury = eff.turns ?? 4
            t.furySt = T
            ctx.log(`  ${nameOf(t)} 进入 Fury（${t.fury}回合，EX 威力翻倍）`)
          }
          emitEvent(ctx, { type: "buff", source: unitRef(u), target: unitRef(t), effects: [eff.key] })
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
 * @param {Array<object>} [lockedTargets] ③-a 同时锁定的目标，传入后不再重算、打死也不换人
 */
function execute(ctx, u, skill, label, actionKind, pick, lockedTargets) {
  const { state } = ctx
  const me = state.sides[u.side]
  const foes = state.sides[1 - u.side]
  const locked = Boolean(lockedTargets)
  const targets = lockedTargets || resolveTargets(state, u, skill, foes, me, pick, actionKind)
  // 一个合法目标都没有 = 这一发根本没出去。返回 false 让调用方决定要不要算「出手过」——
  // 小春的「我来治疗！」要求队友血量 ≤50%，全队满血时她不该白白扣掉冷却和普攻
  if (!targets.length && skill.target !== "self") return false

  /**
   * 圈砸在自己这半边（`小春ex奶桃`）：圈里没有敌人，那半个伤害就没有对象。
   * 反过来砸对面时 `circle_ally` 选不出人，治疗那半边自然落空 —— 两半互斥是几何决定的，
   * 不是这里额外加的规则。
   */
  const onAlly = Boolean(skill.circle) && targets[0]?.side === u.side

  ctx.log(`[${u.side === 0 ? "蓝" : "红"}] ${nameOf(u)} ${label}`)
  // 集火时第一个 EX 已经把指定目标打死，这一发按施法者对线重锁
  if (pick && pick.idx != null && !pick.summon && actionKind === "ex") {
    const intended = (pick.scope === "ally" ? me : foes).units[pick.idx]
    const got = targets[0]
    if (intended && !intended.alive && got && got !== intended) {
      ctx.log(`  ${nameOf(intended)} 已倒下，${onAlly ? "改落在" : "转打"} ${nameOf(got)}`)
    }
  }
  // action.targets 是「这一发实际打到谁」，战场图按它画连线。
  // 连发 / 弹射会在结算过程中换人，先占位再回填，否则图上只剩第一发那条线。
  const actionEv = {
    type: "action", source: unitRef(u),
    action: actionKind,
    skillName: skill.name || null,
    kind: skill.hits && !onAlly ? "damage" : "support",
    targetType: onAlly ? "ally_adjacent" : (skill.target || "enemy_single"),
    targets: targets.map(unitRef),
  }
  emitEvent(ctx, actionEv)

  const hit = []
  // 条件追伤：状态到了哪一档就换哪一组倍率（妮露的 Fury、爱丽丝的能量充能）
  const hits = onAlly ? null : (altHitsOf(u, skill) || skill.hits)
  if (hits?.length) {
    // ③-a 同时锁定后不再走连发/弹射的「打死换人」——那是单发技能内部的逐段重锁
    if (!locked && skill.target === "enemy_cycle") {
      /**
       * 绿：「对最多 5 名敌方单位**按顺序**造成…共计 5 次」——
       * 从**跟自己对位的号位**起，按号位在存活敌人里循环，一发一个。
       * 她站 1 号位就是 1→2→3→4→1，站 2 号位就是 2→3→4→1→2；
       * 只剩 1 个人时 5 发全落他身上。不随机、也不重新对线，玩家指不了目标。
       *
       * 每发结算完重新取存活名单，所以打死人会自动跳过他。
       */
      for (let i = 0; i < hits.length; i++) {
        const al = aliveOf(foes)
        if (!al.length) break
        // 从自己号位开始排一圈：idx 大于等于自己的排前面，小的接在后面
        const ring = [...al].sort((a, b) =>
          ((a.idx - u.idx + 4) % 4) - ((b.idx - u.idx + 4) % 4))
        const t = ring[i % ring.length]
        strike(ctx, u, t, [hits[i]], actionKind, skill)
        if (!hit.includes(t)) hit.push(t)
      }
    } else if (!locked && skill.target === "enemy_chain") {
      // 连发：**只有第一发听玩家的**，后面每一发都照普攻的规则重锁一次
      //（人偶 → 前排 → 中排 → 后排），不再有「不能和上一发相同」那条 ——
      // 有前排就后两发全打前排，有人偶就全打人偶，这才是「视作普攻索敌」。
      // 每发都在结算之后重算，所以打死人会自动换目标（本战场清空就越界）。
      const first = targets[0]
      for (const [i, pct] of hits.entries()) {
        const t = i === 0 && first?.alive ? first : laneTarget(u, foes)
        if (!t) break
        strike(ctx, u, t, [pct], actionKind, skill)
        if (!hit.includes(t)) hit.push(t)
      }
    } else if (!locked && skill.target === "enemy_random") {
      // 弹射：每一段单独抽目标
      for (const pct of hits) {
        const al = aliveOf(foes)
        if (!al.length) break
        const t = randPick(state, al)
        strike(ctx, u, t, [pct], actionKind, skill)
        if (!hit.includes(t)) hit.push(t)
      }
    } else {
      // AoE 默认无衰减，每个目标吃全额分段。两个例外，都靠「targets[0] 是主目标」成立
      // （由 expandAdjacent 保证，生成器也只在 adjacent/all 上给这两个字段）：
      //   splashHits —— 「单体 + 以其为中心的范围」，主目标吃直击＋爆风，扩散只吃爆风（爱露）
      //   falloff    —— 贯穿逐个递减，第 i 个目标 ×(1 − min(rate×i, max))（晴奈）
      for (const [i, t] of targets.entries()) {
        const base = i > 0 && skill.splashHits ? skill.splashHits : hits
        const cut = skill.falloff ? Math.min(skill.falloff.rate * i, skill.falloff.max) : 0
        strike(ctx, u, t, cut ? base.map((h) => h * (1 - cut)) : base, actionKind, skill)
        hit.push(t)
      }
    }
  }
  if (hit.length) actionEv.targets = hit.map(unitRef)

  applyEffects(ctx, u, skill, hit.length ? hit : targets, me, pick, actionKind)
  return true
}

/**
 * 这一发普攻用哪套参数。强化形态抄 `u.charge`（鹤城扇形 / 瞬改索敌），否则抄模板。
 * ③-b 同时锁定时先拿这个去 resolveTargets，再交给 autoAttack 结算。
 */
function autoSkillOf(u) {
  const tmpl = tmplOf(u)
  const c = u.charge
  if (c && (c.shots > 0 || c.turns > 0)) {
    return {
      target: c.count > 1 ? "enemy_adjacent" : "enemy_single",
      count: c.count, hits: c.hits, effects: [],
      charged: true,
    }
  }
  return {
    target: tmpl.autoAttack.target || "enemy_single",
    count: tmpl.autoAttack.count || 1,
    hits: tmpl.autoAttack.hits, effects: [],
  }
}

/**
 * 普攻：对线锁定，分段独立判定。
 *
 * 处于强化形态时改用 `u.charge.hits`（原作的 `Skills.Normal.FormChange`），可能还打成扇形。
 * 存续有两种口径：鹤城按**发数**，打完一发扣一发；瞬按**轮数**，在 endTurn 里跳。
 *
 * 主目标仍然走 `laneTarget` —— 强化的是威力和覆盖面。**索敌是不是也变了由 charge.targeting 决定**，
 * 那是瞬独有的，鹤城不带这个字段。
 *
 * `lockedTargets` 由 ③-b 同时锁定传入。不换人，伤害照算；普攻触发的技能（泉奈手里剑）
 * 在 tryAutoProc 里另走 execute，不带锁，目标死了会重锁。
 */
function autoAttack(ctx, u, lockedTargets) {
  const c = u.charge
  const sk = autoSkillOf(u)
  if (c && c.shots > 0) c.shots -= 1
  execute(ctx, u, {
    target: sk.target, count: sk.count, hits: sk.hits, effects: [],
  }, sk.charged ? "强化普攻" : "普攻", "normal", null, lockedTargets)
  // 打完最后一发才清：清早了这一发就读不到 charge.targeting，瞬的最后一枪会打回对位
  if (c && c.shots != null && c.shots <= 0) u.charge = null
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

/**
 * 被控时：按回合数转的周期技（「每 N 秒」）就绪就吞这一发。
 * 条件门控的不吞 —— 血量触发（椿 / 星野 / 纯子）和小春那种 ICD（冷却只是再用间隔）。
 */
function swallowOnCc(u) {
  const tr = tmplOf(u).skill?.trigger
  return tr?.type === "cooldown" && !tr.icd
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

/**
 * 泉 / 明里：普攻出手后按概率触发普通技能，只有触发成功才进冷却。
 *
 * 泉奈是另一种写法：「自身**每进行 6 次普通攻击**」——数的是枪数不是回合数，走 `trigger.every`。
 * 折成回合冷却会白送她一次：放 EX 的那个回合她不普攻，而回合冷却照跳。
 *
 * **计数按攻速走，不是一回合加 1。** 这是泉奈整套 kit 的联动：EX 加攻速 → 更快攒够 6 枪 →
 * 手里剑来得更勤。`aa` 的语义本来就是「这一回合她开了几枪的份量」——伤害那一头已经这么折了
 * （`strike` 里 `dealF *= factorOf(src,"aa")`），数枪的这一头认同一个数才自洽；
 * 两头不是重复计算，是同一个「射速」的两个后果（每秒伤害↑、每秒枪数↑）。
 *
 * 攒过头的零头留到下个循环，别清零。触发失败也不扣
 *（目前 `every` 与 `chance<1` 没有同时出现的角色）。
 */
function tryAutoProc(ctx, u) {
  const sk = tmplOf(u).skill
  const tr = sk?.trigger
  if (tr?.type !== "on_auto" || !u.alive) return
  if (tr.maxUses && u.skillUses >= tr.maxUses) return
  if (u.skillCd > 0) return
  const shots = shotsOf(u)
  if (tr.every) {
    u.autoCount = (u.autoCount || 0) + shots
    if (u.autoCount < tr.every) return
  }
  if (nextRandom(ctx.state) >= autoProcChance(u, tr.chance)) return
  if (tr.every) u.autoCount -= tr.every
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
        // 第三类：EX 给自己上的进攻向增益，施放那一轮他不出手，从下个己方回合才开始跳
        if (b.startNext && b.st === T) continue
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
      // 集火跟嘲讽同一把防御向尺子：换来的是敌人（其实是己方）的一次出手
      if (u.focus > 0 && 1 - u.side === ticking && u.focusSt !== T) u.focus -= 1
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
          u.hp = 0; u.alive = false; u.taunt = 0; u.focus = 0
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
    // Fury 是进攻向的自身状态，跟自己回合跳。它来自普通技能（③-a 上完 ③-b 就打），
    // 所以施放回合照算，不走 startNext；`furySt` 只是给日后可能出现的 EX 版兜底
    if (u.fury > 0 && u.furySt !== T) u.fury -= 1
    if (u.skillCd > 0 && u.skillCd < 99) u.skillCd -= 1

    // 按轮数存续的强化形态（瞬的 30 秒 = 6 轮）在自己的回合跳，跟随行的进攻向 Buff
    // （暴击 +26%）同一把尺子 —— 都是「从下个己方回合开始」的第三类，两者同轮到期。
    // 施放那一轮她忙着放 EX 没有普攻，所以那一轮不扣，6 轮换来 6 发强化普攻。
    if (u.charge?.turns > 0 && u.charge.st !== T && --u.charge.turns <= 0) u.charge = null
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
      // 没写「打/给」时按技能自己的目标类型猜边。猜出来的标记 `guessed`：
      // 对小春那种「砸哪边就只有那边生效」的圈，这个字决定的是打还是奶，不能靠猜
      const exTarget = String(tmplOf(mine[pos]).ex.target || "enemy_single")
      const scope = c.target.scope || (exTarget.startsWith("enemy") ? "foe" : "ally")
      const guessed = c.target.scope ? {} : { guessed: true }
      if (idx != null) out.target = { scope, idx, ...guessed }
      else {
        // 猜错了就翻到另一边找 —— 没写动词本来就是模糊的，别拿猜测去卡玩家
        let u = pick(scope === "ally" ? mine : foes, id)
        let side = scope
        if (!u && !c.target.scope) {
          side = scope === "ally" ? "foe" : "ally"
          u = pick(side === "ally" ? mine : foes, id)
        }
        if (!u) return { error: `${scope === "ally" ? "你的队伍" : "对方队伍"}里没有${label(id)}` }
        out.target = { scope: side, idx: u.idx, ...guessed }
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
  /**
   * 一个圈砸哪边（小春）：中间那个字在这儿不是可省的修饰，而是**技能的一半**——
   * 写「打」是 227% 的手榴弹，写「奶」是 101% 治愈力的回复，两者互斥。
   * 而双方可能选到同名角色，光按 `ex.target` 猜边就会把「奶桃」办成炸桃。
   * 跟位移一样在这儿拦下来，别等 Cost 扣完、图也发出去了才发现放反了。
   */
  if (tmplOf(u).ex?.circle && cast.target?.idx != null && cast.target.guessed) {
    return `${nameOf(u)} 的 EX 是一个圈，砸哪边就只有那边生效，中间要带上那个字：`
      + `${nameOf(u)}ex打<敌方角色> 是伤害，${nameOf(u)}ex奶<己方角色> 是治疗`
      + `（打/攻/揍… 都算敌方，给/帮/治/奶… 都算己方）`
  }
  // 位移（泉奈）：只能跟隔壁那一格的队友换。指错了在这儿就说清楚，
  // 别等 Cost 扣完、图也发出去了，才发现她压根没动
  const rep = tmplOf(u).ex?.effects?.find((e) => e.type === "reposition")
  if (rep && cast.target?.idx != null && !cast.target.summon) {
    if (cast.target.scope !== "ally") return `${nameOf(u)} 的 EX 是换站位，要写己方角色名，例：${nameOf(u)}ex换椿`
    const dest = side.units[cast.target.idx]
    if (!dest) return "没有那个号位"
    if (dest === u) return `${nameOf(u)} 不能跟自己换站位`
    if (Math.abs(dest.idx - u.idx) > (rep.range ?? 1)) {
      return `${nameOf(dest)} 不在 ${nameOf(u)} 隔壁，位移只能跟相邻的一格换`
    }
  }
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

  // ③-a 普通技能。原作同一拍触发：先按此刻的血量/站位把目标锁死，再一起结算。
  // 按人顺序打的话，第一个人把残血打死，第二个人会换目标；小春把椿奶满，绿就改奶别人。
  // 控制在这一阶段结算，被控的人后面也不普攻。
  const skillQueue = []
  for (const u of side.units) {
    if (!u.alive || usedEx.has(u.idx)) continue
    if (u.stun > 0) {
      const cc = CC_TEXT[u.stunIcon] || "控制"
      // 周期技就绪 = 这一拍本来就要放，被控等于抬手被打断，照样进冷却。
      // 条件技（hp_below / 小春 icd）只是放不出：没真正出手就不记账。
      if (skillReady(u) && swallowOnCc(u)) {
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
    // 先打出去再记账：没有合法目标（小春全队满血）就当这一轮没放 ——
    // 不进冷却、也不占掉 ③-b 的普攻
    const locked = resolveTargets(state, u, sk, foes(), side, null, "skill")
    if (!locked.length && sk.target !== "self") continue
    skillQueue.push({ u, sk, locked })
  }
  for (const { u, sk, locked } of skillQueue) {
    if (!u.alive) continue
    if (!execute(ctx, u, sk, `普通技能「${sk.name}」`, "skill", null, locked)) continue
    consumeSkill(u)
    acted.add(u.idx)
  }
  if (checkEnd(state)) {
    state.turnOpen = false
    state.turnEx = []
    settle(state)
    return done()
  }

  // ③-b 普攻。跟 ③-a 一样先锁目标再结算（原作同一拍），打死不换人。
  // 放过 EX 的人默认不打；立即换弹的（鹤城 / 芹香）在这里补，不跟 EX 画在同一张图里。
  // 普攻触发的技能（泉奈手里剑 / 泉 20%）在 tryAutoProc 里另算，不带这把锁，死了会换人。
  const autoQueue = []
  for (const u of side.units) {
    if (!u.alive || acted.has(u.idx)) continue
    if (usedEx.has(u.idx) && !tmplOf(u).ex?.thenAutoAttack) continue
    autoQueue.push({
      u,
      locked: resolveTargets(state, u, autoSkillOf(u), foes(), side, null, "normal"),
    })
  }
  for (const { u, locked } of autoQueue) {
    if (!u.alive) continue
    autoAttack(ctx, u, locked)
  }
  if (checkEnd(state)) {
    state.turnOpen = false
    state.turnEx = []
    settle(state)
    return done()
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
