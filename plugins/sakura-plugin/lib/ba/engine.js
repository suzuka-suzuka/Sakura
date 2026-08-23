/**
 * 碧蓝档案 · 回合制群战 —— 战斗内核
 *
 * 纯函数模块：不碰 Redis、不碰 e.reply，只做 (state, action) => { state, log, events }。
 * 状态全部可 JSON 序列化，能直接存进 Redis 再取出来接着打。
 *
 * 伤害、命中、暴击、防御、稳定值五条公式全部照搬官方实现（见 roster.js 的 CFG 注释）。
 * 与原作的唯一结构性差异：原作是实时战斗，这里是回合制，因此
 *   - 秒 → 回合按 1 回合 = 5 秒折算（角色普攻循环实测 4~6.5 秒，与之吻合）
 *   - 连续射程与击退无对应物；位置压缩为四个号位，少数自身位移按号位移动
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

/**
 * 支援位（`squad === "支援"`）**不进 `side.units`**，单独放 `side.supports`。
 *
 * 跟召唤物那条决定同一个论证，而且更强：进去就得改 `zoneOf`（1·2 / 3·4 的战场分割）、
 * `settle` 的血量比、战场图的 4 格 —— 全是核心假设。放独立数组之后，
 * `aliveOf` / `sideDead` / `settle` 读的都是 `units`，**一行都不用改**就天然不把支援算进去。
 *
 * 支援**打不到**：普攻 / 普通技能 / EX / `enemy_all` / 场地都够不到它们，
 * 所以 `alive` 恒为 true，5、6 号只是 ③-a 的**结算编号**，不是站位。
 * 要「谁能放 EX、谁在 ③-a 出手、Cost 按几个人回」的地方才走下面这几个。
 *
 * 另外它们把自己的基础生命/攻击 10%、防御/治疗力 5% 转给每个主力，见 applySupportGift。
 */
const supportsOf = (side) => side.supports || []
const castersOf = (side) => [...side.units, ...supportsOf(side)]
const aliveCastersOf = (side) => castersOf(side).filter((u) => u.alive)
/** 号位 → 人。0~3 是主力，4~5 是支援（对外的 5、6 号）。`units[i].idx === i` 那条不变量照旧 */
const casterAt = (side, pos) => (pos < 4 ? side.units[pos] : supportsOf(side)[pos - 4])

/**
 * 护着这个人的掩体。**掩体只管自己那一路**（`blockIdx === u.idx`），不是整个战场 ——
 * 那是人偶（`!s.cover`）的口径，两者别混。
 * 召唤物自己和支援位都不在掩护范围里：前者本身就是墙，后者不站在场上。
 */
const coverOf = (state, u) => (u && !u.summon && !u.support && u.alive
  ? summonsOf(state.sides[u.side]).find((s) => s.cover && s.blockIdx === u.idx) || null
  : null)
const summonsOf = (side) => (side.summons || []).filter((s) => s.alive)
/** 佩洛洛是可受治疗和生命值条件判定的友军；掩体仍只是场地物件，不进友军目标池。 */
const perorosOf = (side) => summonsOf(side).filter((s) => !s.cover)
const healthAlliesOf = (side) => [...aliveOf(side), ...perorosOf(side)]

const unitRef = (u) => (u
  ? {
      side: u.side, pos: u.idx,
      ...(u.summon ? {
        summon: true,
        ...(u.cover ? { cover: true } : {}),
        ...(u.sourceKey ? { summonKey: u.sourceKey } : {}),
      } : {}),
      ...(u.support ? { support: true } : {}),
    }
  : null)

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

/**
 * 支援位给己方自动选目标时，只有明确提升输出的 Buff 才算「进攻拐」并优先后排。
 * 奶、盾、加防 / 闪避 / 减伤，以及尚未明确归为进攻的功能性效果，都继续优先前排。
 */
const OFFENSIVE_BUFF_STATS = new Set([
  "atk", "atk_flat", "aa", "acc", "crit", "crit_dmg", "crit_dmg_flat", "dmg_deal",
])
const isOffensiveBuffStat = (stat) => OFFENSIVE_BUFF_STATS.has(stat) || String(stat || "").startsWith("enh_")

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

export const atkOf = (u) => ((tmplOf(u).atk || 0) + (u.gift?.atk || 0)) * Math.max(0.2, factorOf(u, "atk")) + flatOf(u, "atk_flat")
export const dfsOf = (u) => Math.max(0, ((tmplOf(u).dfs || 0) + (u.gift?.dfs || 0)) * Math.max(0.2, factorOf(u, "dfs")) + flatOf(u, "dfs_flat"))
export const healOf = (u) => ((tmplOf(u).healPower || 0) + (u.gift?.heal || 0)) * Math.max(0.2, factorOf(u, "heal")) + flatOf(u, "heal_flat")
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
 * 六个角色（4 主力 + 2 支援）的 EX 随时可选，但放完要压一段冷却，
 * 冷却按「本方之后又放了几个 EX」计，不按回合计：长度 = **存活总人数 − 3**。
 *
 * 满编 6 人时放完要等另外 3 个 EX 才轮回来；主力死到只剩 1 个时（1 主力 + 2 支援 = 3 人）
 * 长度归零，Cost 够就能连放同一人 —— 人越少越不该被冷却锁死。
 *
 * 支援永远不死，所以这个数的下限就是 3（=0 锁），可放的人恒 ≥ 3，不会出现「全队卡冷却」。
 */
export const exLockLenOf = (side) => Math.max(0, aliveCastersOf(side).length - CFG.EX_COOLDOWN_SLACK)

/** 距离解锁还差几个 EX，0 表示现在就能放 */
export function exWaitOf(side, u) {
  if (!u.exCastNo) return 0
  return Math.max(0, exLockLenOf(side) - (side.exCasts - u.exCastNo))
}

export const exReadyOf = (side, u) => u.alive && exWaitOf(side, u) === 0

/** 不修改传入状态，返回一侧当前能放 EX 的 0-based 角色位置（只看冷却，不含本回合已放 / Cost）。 */
export function exAvailableOf(state, sideIndex) {
  const side = state.sides[sideIndex]
  return castersOf(side).filter((u) => exReadyOf(side, u)).map((u) => u.idx)
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
  return castersOf(side)
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
  // 只有主力会死，所以水位线看的就是 aliveOf；支援也要一起清冷却（它们共用 side.exCasts）
  const now = aliveOf(side).length
  const dropped = side.lastAlive != null && now < side.lastAlive
  side.lastAlive = now
  if (!dropped) return false
  side.exCasts = 0
  for (const u of castersOf(side)) u.exCastNo = 0
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
 * 原作的**基础效果只有一条**：EX Cost 攒得更快（Cost Regen Up）。
 * 那张红底 COST↑ 会出现在全部场上主力头上，所以每个还活着的场上主力都将自身回复
 * 乘以 `FEVER_COST_MULT`（默认 2）；不在场上的支援仍按每人 `COST_REGEN_PER_UNIT` 回复。
 * 防御 / 闪避 / 受治疗下降是赛季附加规则（S10、S11 都带），一并抄了，
 * 不想要把 CFG.FEVER_DEBUFF 设成 0 即可。
 *
 * 数字走 `regenOf`（按边回）；`cost_regen` 层挂给所有场上主力，让状态格画对。
 */
const feverFieldUnitOf = (u) => Boolean(u?.alive && !u.support && !u.summon)
const feverOn = (state) => state.round >= CFG.FEVER_ROUND

/**
 * 进入白热化时给全场挂一次永久状态。
 * 走 buff 系统而不是在伤害公式里加系数：状态格会自动画出来，玩家能看见发生了什么。
 */
function enterFever(ctx) {
  const { state } = ctx
  if (state.fever || !feverOn(state)) return
  state.fever = true
  const costMult = Math.max(1, CFG.FEVER_COST_MULT || 1)
  const costUp = costMult - 1
  for (const s of state.sides) {
    for (const u of s.units) {
      if (costUp && feverFieldUnitOf(u)) {
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
  ctx.log(`🔥 白热化：场上主力 Cost 回复 ×${costMult}，支援仍为 ${CFG.COST_REGEN_PER_UNIT}` +
    (CFG.FEVER_DEBUFF > 0 ? `，全场防御 / 闪避 / 受治疗 −${Math.round(CFG.FEVER_DEBUFF * 100)}%` : ""))
}

// ---------------- 建局 ----------------

function makeUnit(tmpl, idx, side) {
  return {
    id: tmpl.id, idx, side,
    // 支援位：idx 是 4/5（对外的 5、6 号），只用于 ③-a 的结算顺序，不参与战场分割
    ...(tmpl.squad === "支援" ? { support: true } : {}),
    maxhp: tmpl.hp, hp: tmpl.hp,
    shield: 0, shieldMax: 0, shieldTurns: 0, shieldTickSide: 1 - side, shieldSt: -1,
    buffs: [], regens: [],
    // 周期伤害。场地保留来源与分段、每跳读当前面板；来源阵亡后退回施放快照继续存在。
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
    // 真白：普通技能给「下 1 次 EX 的追伤概率」加算，攒到下一发 EX 用掉就清零
    bonusChance: 0,
    // 急救状态（绫音爱用品）：生命掉到 hpMax 以下时消耗并回血。once 的赋予全场一次
    ward: null, wardUsed: false,
    // EX 费用打折：{mode:"flat"|"pct", value, uses}。按**次数**失效，没有时长
    exDiscount: null,
    // 本方第几个 EX 是这个人放的；0 表示还没放过，开局全员可放
    exCastNo: 0,
    alive: true,
  }
}

/**
 * 开局固定在 1、4 号位的场地掩体。它与技能部署的掩体使用同一个召唤物模板和伤害结算，
 * 只多一个 `fieldCover` 标记，供同路技能掩体替换时区分来源。
 */
function makeFieldCover(side, idx) {
  const hp = CFG.FIELD_COVER_HP
  return {
    summon: true, id: 99999, side, idx, blockIdx: idx,
    hp, maxhp: hp, shield: 0, shieldMax: 0, shieldTurns: 0,
    cover: true, fieldCover: true, onAlly: true,
    buffs: [], regens: [], dots: [], stun: 0,
    taunt: 0, tauntKind: null, focus: 0,
    turns: null, turnsMax: null, st: -1,
    sourceKey: `field:${side}:${idx}`, alive: true,
  }
}

/**
 * 官方编成加成：每个支援把自己**基础**面板按比例交给每个主力。
 * 生命直接写进 hp / maxhp；攻防治挂在 `u.gift` 上，进 atkOf / dfsOf / healOf 当基础值。
 * 不是 buff —— 头上不出状态格。支援和召唤物自己拿不到。
 */
function applySupportGift(side) {
  const g = { hp: 0, atk: 0, dfs: 0, heal: 0 }
  for (const s of supportsOf(side)) {
    const t = tmplOf(s)
    g.hp += t.hp * CFG.SUPPORT_GIFT_HP
    g.atk += t.atk * CFG.SUPPORT_GIFT_ATK
    g.dfs += t.dfs * CFG.SUPPORT_GIFT_DFS
    g.heal += (t.healPower || 0) * CFG.SUPPORT_GIFT_HEAL
  }
  if (!g.hp && !g.atk && !g.dfs && !g.heal) return
  // 生命取整：0.1 在二进制里除不尽，不收的话治疗一加就会 hp > maxhp
  const hp = Math.round(g.hp)
  for (const u of side.units) {
    u.maxhp += hp
    u.hp += hp
    u.gift = { atk: g.atk, dfs: g.dfs, heal: g.heal }
  }
}

/**
 * @param {{uid, name, picks: string[]}} a 蓝方（picks 前 4 个是主力，后 2 个是支援）
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
      // 水位线只数主力 —— 支援不会死，拿 picks.length（6）当初值会让第一次减员判不出来
      exCasts: 0, lastAlive: s.picks.slice(0, 4).length,
      // 每个战场靠外侧各放一个固定掩体：对外即 1、4 号位。技能掩体可以替换同路这一座。
      summons: CFG.FIELD_COVER_POSITIONS.map((idx) => makeFieldCover(side, idx)),
      // 场地是留在地上的区域，不是贴在人身上的状态。覆盖范围按技能规则算，
      // 每次跳伤害都扫描当前号位：进入就吃伤害，离开就不再吃；人死了圈也不会缩。
      fields: [],
      // 编成是 4 主力 + 2 支援，顺序即左起 1~4 号位 + 5/6 号支援
      units: s.picks.slice(0, 4).map((id, i) => makeUnit(BY_ID[id], i, side)),
      supports: s.picks.slice(4).map((id, i) => makeUnit(BY_ID[id], 4 + i, side)),
    })),
  }
  for (const side of state.sides) applySupportGift(side)
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
    for (const u of castersOf(side)) {
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
 * 多目标只在自动主目标那一层横着铺。一层里凑不够人数就退化成单体。
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

/**
 * 这一方当前把对面刀吸过来的目标。嘲讽优先于集火；召唤物也算。
 *
 * `noProvoke` = **开火的是支援位**，这时只认集火。两套机制在这一点上正好相反：
 *   - Provoke 是**场地性的**，拉的是站在场上的人 —— 支援不在场上，拉不动（跟 `provokedBy` 同一条理由）
 *   - 集火是**给己方下的索敌指令**，标在敌人头上、由自己这边全员执行 —— 支援照样跟着打
 */
const tauntTargetOf = (side, noProvoke = false) => {
  const sm = side.summons || []
  const focused = side.units.find(isFocus) || sm.find(isFocus) || null
  if (noProvoke) return focused
  return sm.find(isProvoke) || side.units.find(isProvoke) || focused
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
  /**
   * **支援免疫嘲讽**：它们不站在场上，场地性的 Provoke 拉不到它们。
   * 于是椿 / 人偶把对面四个主力全拉走的那一轮，支援仍然出得了手 —— 这正是支援的独有生态位，
   * 也是「全员被封就自动过回合」那条必须跟着 `exCastableOf` 走的原因：现在它天然不会空了。
   */
  if (u.support) return null
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
  const alive = aliveCastersOf(state.sides[sideIndex])
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

/** 技能原文指定「生命值百分比最低」；并列时取号位小者。 */
function lowestHpRateTarget(alive) {
  if (!alive.length) return null
  return alive.reduce((m, f) => {
    const a = f.hp / f.maxhp, b = m.hp / m.maxhp
    return a < b - 1e-9 || (Math.abs(a - b) < 1e-9 && f.idx < m.idx) ? f : m
  })
}

/**
 * 普攻 / 普通技能的对线锁定，按优先级：
 *   1. 嘲讽（Provoke）—— 最高，直接无视战场分割。**开火的是支援位时这一档整个跳过**
 *   2. 集火（ConcentratedTarget，切里诺）—— 己方攻击锁在被点名的那个人，支援也照锁
 *   3. 索敌改成「打攻击力最高的」（瞬的强化形态 / 柚子的技能自带），见 maxAtkTarget
 *   4. **同战场的佩洛洛**：挡在那半边最前面，嘲讽过期了也一样。本战场打空要越界时也先拆墙
 *   5. 同战场的前排 → 中排 → 后排。不是职业，是角色自己的 Front/Middle/Back
 *   6. 本战场空了才越界，跨过去还是前 → 中 → 后
 *   7. 同一层里：对位 → |位置差| 最小 → 编号小
 * @param {string|null} pick 技能描述自带的索敌（最高攻击 / 最低血量等）；null 时仍可读取瞬的强化形态
 * @param {{ignoreTaunt?: boolean}} [opts] 切里诺普技的集火是**选人条件**，嘲讽改不了落点
 */
function laneTarget(u, foes, pick = null, opts = {}) {
  // 嘲讽 > 集火，无视目标选择层 —— 战场分割、前排、人偶挡刀、瞬的强化索敌统统让路。
  // 掩体不在目标选择层；被嘲讽者同路的掩体仍可对 Block=1 分段掷 30%。
  // 嘲讽同槽只留一个（人偶入场 Provoke 和椿的 EX 会互相顶掉）；集火另开一槽，见 setTaunt。
  // **支援位的刀不被嘲讽拉走**：椿把场上四个人全拽过去的那一轮，5、6 号该打谁还打谁。
  const taunting = tauntTargetOf(foes, Boolean(u.support))
  if (taunting && !opts.ignoreTaunt) return taunting

  // **人偶按战场拦一切；掩体不参与索敌**。掩体只在 strike 里对被护者的
  // `Block=1` 分段掷 30%，成功才承受那一段伤害。
  const decoys = summonsOf(foes).filter((s) => !s.cover)
  const alive = aliveOf(foes)
  const describedTarget = pick === "lowest_hp_rate"
    ? lowestHpRateTarget(alive)
    : maxAtkTarget(u, alive, pick === "max_atk")

  if (describedTarget) return describedTarget

  /**
   * **支援位没有对位**，`zoneOf(u.idx)` 对它们没有意义（它们不站在任何一个战场里）。
   * 进攻型支援从战线后方落刀：**后排 → 中排 → 前排**，
   * 同排就打号位更小的。技能自带索敌（`skill.pick`）
   * 在上面就返回了，所以这里只管默认情况。
   *
   * 墙照挡：先按这条挑出人，再看**那个人所在的半边**有没有墙 —— 支援的刀一样绕不过去。
   */
  if (u.support) {
    if (!alive.length) return decoys[0] || null
    const best = Math.max(...alive.map(lineRank))
    const aim = alive.filter((f) => lineRank(f) === best).reduce((m, f) => (f.idx < m.idx ? f : m))
    return decoys.find((s) => zoneOf(s.blockIdx) === zoneOf(aim.idx)) || aim
  }

  const zoneAlive = alive.filter((f) => zoneOf(f.idx) === zoneOf(u.idx))
  // **人偶**按战场拦，不是按号位：它挡在那半边最前面，比前排还靠前一格。
  // 日富美的人偶落在自动主目标的战场，那一整边的刀都归它接。
  const blocking = decoys.find((s) => zoneOf(s.blockIdx) === zoneOf(u.idx))
    // 本战场打空后，仍先处理敌方人偶；无人躲在后面的掩体不会被主动索敌。
    || (zoneAlive.length === 0 ? decoys[0] : null)
  if (blocking) return blocking

  if (!alive.length) return null
  const pool = zoneAlive.length ? zoneAlive : alive
  const best = Math.min(...pool.map(lineRank))
  return pickInLayer(pool.filter((f) => lineRank(f) === best), u.idx)
}

/**
 * 从自动主目标向外扩散选人。
 *
 * 2 目标扩散不跨战场：主目标在 3 位就只可能波及 4 位，
 * 同战场只剩一人时当场退化成单体。
 */
function expandAdjacent(pool, primary, count) {
  // count≥3 是「以主目标为中心向两边炸开」（睦月的三连雷、日富美的圆），
  // 走**固定窗口** [idx−half, idx+half] 而不是贪心找邻居：越界的那一发就是浪费掉，
  // 不能往另一边多抓一个来凑满。自动目标在 1 号位只炸 {1,2}，在 2 号位才炸满 {1,2,3}。
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

/** 场地每次跳伤害时重新读取当前占位；支援不站场，只扫描主力和这一方的召唤物。 */
function fieldOccupants(side, field) {
  const inRange = (idx) => Number.isInteger(idx) && idx >= field.lo && idx <= field.hi
  return [
    ...(side.units || []).filter((u) => u.alive && inRange(u.idx)),
    ...summonsOf(side).filter((s) => inRange(Number.isInteger(s.blockIdx) ? s.blockIdx : s.idx)),
  ]
}

/**
 * 己方就近：**同战场优先 → |号位差| 最小 → 编号小**。跟 laneTarget 的分层口径对称，
 * 但不含「自己」那一档 —— 由调用方决定要不要把自己放进 pool。
 */
function nearestAlly(u, pool) {
  // 支援位没有对位也没有战场，「就近」退化成号位最小的那个（跟 laneTarget 那条同一个方向）
  if (u.support) return pool.reduce((best, a) => (a.idx < best.idx ? a : best))
  const same = pool.filter((a) => zoneOf(a.idx) === zoneOf(u.idx))
  const list = same.length ? same : pool
  return list.reduce((best, a) => {
    const da = Math.abs(a.idx - u.idx), db = Math.abs(best.idx - u.idx)
    return da < db || (da === db && a.idx < best.idx) ? a : best
  })
}

/** 己方技能没有自带选人条件时的固定位置选择。 */
function allyLaneTarget(u, allies, skill) {
  const alive = aliveOf(allies)

  if (u.support) {
    // 这里只补「技能没有自带选人描述」的默认落点；ally_lowest / ally_maxhp 等在上层先返回。
    // 治疗类先照顾己方佩洛洛，再按前 → 中 → 后、同排号位小的顺序选主力。
    const healing = (skill?.effects || []).some((e) => ["heal", "regen", "ward"].includes(e.type))
    if (healing) {
      const doll = perorosOf(allies).sort((a, b) => a.idx - b.idx)[0]
      if (doll) return doll
    }
    if (!alive.length) return null
    // 攻击 / 攻速 / 命中 / 暴击 / 增伤等进攻拐优先后排；奶、盾、加防、闪避等防御技能优先前排。
    // 同排永远取号位小者。没有明确归为进攻 Buff 的新效果默认留在前排侧，避免误拐后排。
    const offensiveBuff = (skill?.effects || []).some((e) =>
      e.type === "buff" && e.scope === "ally_target" && isOffensiveBuffStat(e.stat))
    const lineOrder = offensiveBuff
      ? (a, b) => lineRank(b) - lineRank(a)
      : (a, b) => lineRank(a) - lineRank(b)
    return [...alive].sort((a, b) => lineOrder(a, b) || a.idx - b.idx)[0]
  }

  // 非支援位若技能明确是给「一名队友」加增益，不能再默认把 Buff 塞给自己：
  // 先选同战场的队友，再按号位距离和编号决定最近者。技能自带的 named / lowest 等不走这里。
  const buffsTeammate = (skill?.effects || []).some((e) =>
    e.scope === "ally_target" && ["buff", "shield", "ward"].includes(e.type))
  if (buffsTeammate) {
    const teammates = alive.filter((a) => a !== u)
    return teammates.length ? nearestAlly(u, teammates) : null
  }

  return u.alive ? u : null
}

/**
 * @returns {Array<object>} 命中的单位列表（AoE 无衰减，每个目标吃全额）
 */
function resolveTargets(state, u, skill, foes, allies) {
  const tg = skill.target || "enemy_single"
  const count = skill.count || 1

  if (tg === "self") return [u]
  if (tg === "ally_all") return aliveOf(allies)
  /**
   * 点名奶。人数和挑法以原文措辞为准，玩家指不了（跟绿 / 小春同一条）：
   *   `ally_lowest`（绿 / 花子普技）「生命值百分比**最低**」→ 按血量挑，并列再按站位就近；
   *     count 可以 > 1（花子爱用品是 2 名最残）
   *   `ally_hurt`（小春）原文只写「不高于 50%」，**没说最低** → 够格的人里按站位就近喂
   *   `ally_maxhp`（风香普技）「生命值上限最高」→ 按 maxhp 挑，并列再按站位就近
   *
   * 没人够格就返回空，`execute` 会当作没放 —— 既不进冷却，也不占掉她这一轮的普攻。
   */
  if (tg === "ally_lowest" || tg === "ally_hurt" || tg === "ally_maxhp") {
    // 佩洛洛有完整的 hp / maxhp，必须和主力一起接受「最低血量 / 生命阈值 / 最高生命」判定。
    // 掩体不是角色，仍然排除。
    let al = healthAlliesOf(allies)
    if (skill.exceptSelf) al = al.filter((a) => a !== u)
    if (skill.hpMax != null) al = al.filter((a) => a.hp / a.maxhp <= skill.hpMax)
    if (!al.length) return []
    if (tg === "ally_hurt") return [nearestAlly(u, al)]
    const key = tg === "ally_maxhp"
      ? (a) => -a.maxhp
      : (a) => a.hp / a.maxhp
    const ranked = [...al].sort((a, b) => {
      const da = key(a), db = key(b)
      if (Math.abs(da - db) >= 1e-9) return da - db
      // 并列再按站位就近，跟 count=1 时 nearestAlly 同一把尺子
      if (u.support) {
        // 治疗类在数值完全并列时，佩洛洛仍优先；之后才按号位。
        if (a.summon !== b.summon) return a.summon ? -1 : 1
        return a.idx - b.idx
      }
      const za = zoneOf(a.idx) === zoneOf(u.idx) ? 0 : 1
      const zb = zoneOf(b.idx) === zoneOf(u.idx) ? 0 : 1
      if (za !== zb) return za - zb
      const da2 = Math.abs(a.idx - u.idx), db2 = Math.abs(b.idx - u.idx)
      return da2 - db2 || a.idx - b.idx
    })
    return ranked.slice(0, Math.min(skill.count || 1, ranked.length))
  }
  if (tg === "enemy_all") return aliveOf(foes)
  // 循环点名（绿）：落点由**她自己的号位**定死，玩家指不了 —— 逐发在 execute 里算
  if (tg === "enemy_cycle") return aliveOf(foes)

  const pool = tg.startsWith("ally") ? allies : foes
  let primary = null

  if (tg === "enemy_random") return aliveOf(foes) // 逐段随机，在 strike 里再抽
  // 连发第一发也按固定索敌，后续各段仍在 execute 里重新锁定。
  if (tg === "enemy_chain") {
    primary = laneTarget(u, foes)
    return primary ? [primary] : []
  }

  // 玩家只选释放者；落点先服从技能自带索敌，再走位置规则。
  if (!primary) {
    // 切里诺普技的「攻击力最高」是选人条件，不是开火：嘲讽拉得走柚子那种带伤害的最高攻索敌，
    // 但改不了集火标记落在谁头上。过期之后火力还得锁回那个最高攻的人。
    const markFocus = skill.pick === "max_atk"
      && (skill.effects || []).some((e) => e.type === "taunt" && e.kind === "focus")
    primary = tg.startsWith("ally")
      ? allyLaneTarget(u, allies, skill)
      : laneTarget(u, foes, skill.pick || null, { ignoreTaunt: markFocus })
  }
  if (!primary) return []
  // 召唤物不在 pool.units 里，扩散算不出邻居；打到它就只打它
  if (primary.summon) return [primary]

  // 范围技的落点只要碰到召唤物所在的**战场**，整发就被它接走 —— 它是挡在那半边前面的墙，
  // 跟 laneTarget 里的挡刀同一条口径（按战场，不按号位）。
  // 2 目标的覆盖面本来就是主目标那个战场；3 目标是中心窗口，跨到哪半边就被哪半边的墙接。
  // 只处理敌方目标；己方增益和治疗不会被自家召唤物拦截。
  const instMode = tg === "enemy_instances"
  if (tg.startsWith("enemy") && (instMode || tg.endsWith("adjacent")) && count > 1) {
    const half = count >= 3 ? Math.floor((count - 1) / 2) : 0
    // 多圈技（响）的圈心逐个落在不同的人身上，覆盖面就是整条战线：哪半边有墙都接得住
    const lanes = instMode
      ? [0, 3]
      : count >= 3
        ? [primary.idx - half, primary.idx + half]
        : (zoneOf(primary.idx) === 0 ? [0, 1] : [2, 3])
    // **人偶**：覆盖面碰到它那半场就整发被接走，不问 Block
    const decoy = summonsOf(pool).find((s) => !s.cover
      && [0, 1, 2, 3].some((i) => i >= lanes[0] && i <= lanes[1] && zoneOf(i) === zoneOf(s.blockIdx)))
    if (decoy) return [decoy]
  }
  // 嘲讽把整发吸走，不往后排溅。跟人偶同一档。
  // 支援不吃嘲讽，所以它的范围技照常铺开 —— 吸走整发的前提是这一发本来就被拉过来了。
  if (tg.startsWith("enemy") && count > 1
    && primary === tauntTargetOf(foes, Boolean(u.support)) && !primary.summon) {
    return [primary]
  }
  /**
   * **圈数跟着人数走**（响，全 272 人只有她）。`instances` 是原文写死的圈数（5），
   * 而战场上最多 4 个人 —— 写死 5 会让第 5 发凭空浪费掉。
   *
   * 圈数取 `min(instances, 存活敌人数)`，**每个圈的伤害不变**；圈心从自动主目标起
   * 按号位绕圈，一人一个。每个圈仍按自己的半径铺（响是半径 150 → 同战场同身位 2 人），
   * 所以同一个人可能被相邻的两个圈盖到 —— 那是圆形范围重叠的自然结果，不是重复计算。
   */
  if (instMode) {
    const al = aliveOf(foes)
    const from = Math.max(0, al.indexOf(primary))
    const out = []
    for (let k = 0; k < Math.min(skill.instances || 1, al.length); k++) {
      const center = al[(from + k) % al.length]
      out.push(...(count > 1
        ? sameLineHits(expandAdjacent(pool.units, center, count), center, count)
        : [center]))
    }
    return out
  }

  if (tg.endsWith("adjacent")) {
    const hits = expandAdjacent(pool.units, primary, count)
    // 横向圆/扇锁同层（睦月、白子、千世普攻…）。直线贯穿（晴奈、纯子）圈到谁打谁。
    // 己方的 ally_adjacent 也按同样的层与窗口扩散。
    if (count > 1 && skill.depth !== "through") {
      return sameLineHits(hits, primary, count)
    }
    return hits
  }
  return [primary]
}

function resolveTargetPlan(state, u, skill, foes, allies) {
  return { targets: resolveTargets(state, u, skill, foes, allies) }
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
    // 掩体承伤事件仍保留真实伤害供结算 / 测试读取；战场图只切换场地掩体三态图，不再单独冒数字。
    ...(meta.blocked ? { blocked: meta.blocked } : {}),
    // 部分分段被挡时，把玩家可见的 BLOCK 信息并回原角色的伤害标签；不改实际承伤事件语义。
    ...(meta.visualBlocked ? {
      visualBlocked: meta.visualBlocked,
      visualHits: meta.visualHits,
      visualLanded: meta.visualLanded,
    } : {}),
  })

  const tag = (meta.crit ? "暴击" : "") +
    (meta.aff > 1.01 ? "·克制" : meta.aff < 0.99 ? "·抵抗" : "")
  const ab = absorbed > 0 ? `（护盾吸收 ${Math.round(absorbed)}）` : ""
  const seg = meta.hits ? ` [${meta.landed}/${meta.hits}段]` : ""
  ctx.log(`  ${src ? nameOf(src) : "持续"} → ${nameOf(tgt)} ${Math.round(dmg)}${ab}${seg} ${tag}`.trimEnd())
  if (saved) ctx.log(`  ${nameOf(tgt)} 靠不死撑住了（剩 1 生命）`)

  if (tgt.hp <= 0) {
    tgt.hp = 0
    // 同一伤害链若重复落到该目标，击杀也只认第一次掉到 0 的那一段。
    if (wasAlive) {
      tgt.alive = false
      tgt.taunt = 0
      tgt.focus = 0
      tgt.regens.length = 0
      tgt.dots.length = 0
      tgt.ward = null
      ctx.log(`  ✝ ${nameOf(tgt)} ${tgt.summon ? "被打碎" : "倒下"}`)
      if (src && src !== tgt && src.alive) tryKillProc(ctx, src)
    }
  } else {
    tryWard(ctx, tgt)
  }
}

/**
 * 对单个目标打出一组分段攻击。每段独立判定掩体、命中与暴击；底层仍按实际承伤方分别
 * 产生事件，战场图则只在原角色处显示最终承伤与 BLOCK；场地掩体靠三态图片反馈耐久。
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

function strike(ctx, src, tgt, hits, actionKind, skill, hitBlocks) {
  const { state } = ctx
  // ③-a / ③-b 锁定目标已倒下时由 execute 直接丢弃伤害；这里仍允许同一技能内部的
  // 独立后续段（概率追伤等）按自己的规则调用。击杀只在 applyDamage 里认第一次掉到 0。
  if (!src.alive || !tgt) return 0

  const floor = stabilityFloor(src)
  const atk = atkOf(src)
  // 攻速折成的 aa 只乘普攻。EX / 普通技能走 dmg_deal，别把射速加成套到技能倍率上。
  // 鹤城 / 芹香 ③-b 的普攻、强化普攻都是 actionKind === "normal"，会吃到。
  let sourceDealF = factorOf(src, "dmg_deal")
  if (actionKind === "normal") sourceDealF *= factorOf(src, "aa")
  // 属性增伤（爱用品，桃给绿的 +13.2% 贯通）。按**攻击者自己的弹种**匹配，
  // 所以同一层给不同弹种的队友，效果不一样 —— 原作就是这么设计的
  sourceDealF *= factorOf(src, `enh_${tmplOf(src).bullet}`)

  /**
   * **统一掩体判定**：伤害的自动目标始终是角色。角色身前有掩体时，每个原数据
   * `Damage.Block=1` 的分段独立掷 `COVER_BLOCK_RATE`（基础 30%）：
   *   - 成功：该段改由掩体承伤并扣耐久；
   *   - 失败：该段继续对角色做命中 / 闪避、暴击和伤害判定；
   *   - `Block=0`：完全跳过掩体。
   *
   * `hitBlocks` 必须跟 `hits` 同粒度，爱露的直击 `Block=1`、爆风 `Block=0` 才不会被
   * 技能级 `skill.block` 错盖成整发可挡。掩体若在这组分段中被打碎，后续分段直接落回角色。
   */
  const cover = coverOf(state, tgt)
  const blocks = Array.isArray(hitBlocks) && hitBlocks.length === hits.length
    ? hitBlocks
    : hits.map(() => Boolean(skill?.block))

  const profileCache = new Map()
  const profileOf = (target) => {
    if (profileCache.has(target)) return profileCache.get(target)
    const p = {
      aff: affinity(tmplOf(src).atkType, tmplOf(target).defType),
      hr: hitChance(src, target),
      cr: critChance(src, target),
      critMul: critMultOf(src, target),
      dm: defModOf(target),
      dealF: Math.max(0.1, sourceDealF * hpRateMult(skill?.hpRate, target)),
      takeF: Math.max(0.1, factorOf(target, "dmg_take")),
    }
    profileCache.set(target, p)
    return p
  }
  const resultOf = (target) => ({
    target, hits: 0, landed: 0, critHits: 0, total: 0,
  })
  const targetResult = resultOf(tgt)
  const coverResult = cover ? resultOf(cover) : null
  let projectedCoverHp = cover?.hp || 0

  for (const [i, pct] of hits.entries()) {
    const intercepted = Boolean(coverResult && projectedCoverHp > 0 && blocks[i]
      && nextRandom(state) < CFG.COVER_BLOCK_RATE)
    const out = intercepted ? coverResult : targetResult
    const profile = profileOf(out.target)
    out.hits++
    if (nextRandom(state) >= profile.hr) continue
    out.landed++
    const crit = nextRandom(state) < profile.cr
    if (crit) out.critHits++
    let d = atk * (pct / 100) * profile.aff * profile.dm * profile.dealF * profile.takeF
    d *= randRange(state, floor, 1)
    if (crit) d *= profile.critMul
    d = Math.max(1, d)
    out.total += d
    if (intercepted) projectedCoverHp -= d
  }

  let total = 0
  if (coverResult?.landed) {
    const profile = profileOf(coverResult.target)
    ctx.log(`  ${nameOf(coverResult.target)} 替 ${nameOf(tgt)} 挡下 ${coverResult.landed} 段`)
    applyDamage(ctx, src, coverResult.target, coverResult.total, {
      crit: coverResult.critHits > 0, critHits: coverResult.critHits, aff: profile.aff,
      hits: coverResult.hits, landed: coverResult.landed, blocked: coverResult.landed,
    })
    total += coverResult.total
  }

  const blockedHits = coverResult?.landed || 0
  if (targetResult.landed) {
    const profile = profileOf(tgt)
    applyDamage(ctx, src, tgt, targetResult.total, {
      crit: targetResult.critHits > 0, critHits: targetResult.critHits, aff: profile.aff,
      hits: targetResult.hits, landed: targetResult.landed,
      ...(blockedHits ? {
        visualBlocked: blockedHits, visualHits: hits.length, visualLanded: targetResult.landed,
      } : {}),
    })
    total += targetResult.total
  } else if (targetResult.hits) {
    ctx.log(`  ${nameOf(tgt)} 闪避了 ${nameOf(src)}${targetResult.hits > 1 ? `（${targetResult.hits}段全空）` : ""}`)
    emitEvent(ctx, {
      type: "miss", source: unitRef(src), target: unitRef(tgt),
      attackType: tmplOf(src).atkType, hits: targetResult.hits, landed: 0,
      ...(blockedHits ? {
        visualBlocked: blockedHits, visualHits: hits.length, visualLanded: 0,
      } : {}),
    })
  } else if (blockedHits) {
    // 全段都被掩体接住：角色实际承伤为 0，但仍在原目标位置给出一次明确反馈。
    emitEvent(ctx, {
      type: "block", source: unitRef(src), target: unitRef(tgt),
      attackType: tmplOf(src).atkType, amount: 0, totalAmount: 0,
      hits: hits.length, landed: 0, blocked: blockedHits,
    })
  }
  return total
}

/**
 * 急救状态：身上挂着、当前生命已经不高于阈值，就消耗并回血。
 * 打死的那一下来不及救（先判死亡），已经残血时上状态会当场触发。
 */
function tryWard(ctx, t) {
  const w = t.ward
  if (!w || !t.alive || t.hp / t.maxhp > w.hpMax) return
  t.ward = null
  t.wardUsed = true
  const src = casterAt(ctx.state.sides[w.srcSide], w.srcPos) || t
  heal(ctx, src, t, w.amount)
}

function heal(ctx, src, tgt, amount) {
  if (!tgt.alive) return
  // 受治疗量走 buff 系统（白热化的减益也在里面）
  amount *= Math.max(0.1, factorOf(tgt, "heal_taken"))
  const h = Math.min(amount, tgt.maxhp - tgt.hp)
  if (h <= 0) return
  tgt.hp = Math.min(tgt.maxhp, tgt.hp + h)
  ctx.log(`  ${nameOf(src)} 治疗 ${tgt === src ? "自身" : nameOf(tgt)} +${Math.round(h)}`)
  emitEvent(ctx, { type: "heal", source: unitRef(src), target: unitRef(tgt), amount: Math.round(h) })
}

// ---------------- 效果执行 ----------------

/**
 * 非伤害效果的作用域。默认（`enemy`）跟随伤害目标。
 *
 * - `ally_target` 自动选择的己方目标（绿 / 花江 / 芹娜）。跟默认分支同义，
 *   但名字不同才读得出「这是我方那一个」而不是「打到的敌人」
 * - `ally_named`  指名给某个队友，人不在场就整条不生效（绿 ⇄ 桃 的联动）
 * - `mirror_ally` 小春 EX：治疗自动攻击主目标对位的己方主力；该号位阵亡则落空
 */
function scopeTargets(scope, u, allies, dmgTargets, eff) {
  if (scope === "self") return [u]
  if (scope === "ally_all") return aliveOf(allies)
  if (scope === "ally_named") {
    const t = allies.units.find((a) => a.id === eff?.ally && a.alive)
    return t ? [t] : []
  }
  if (scope === "mirror_ally") {
    const primary = dmgTargets[0]
    const mate = primary ? allies.units[primary.idx] : null
    return mate?.alive ? [mate] : []
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
    if (cur >= a.min) return { hits: a.hits, hitBlocks: a.hitBlocks }
  }
  return null
}

/**
 * @param {"ex"|"skill"|"normal"} [actionKind] 决定自身进攻向增益是不是「从下个己方回合才跳」
 */
function applyEffects(ctx, u, skill, dmgTargets, allies, actionKind) {
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

      case "ward":
        for (const t of targets) {
          if (!t.alive) continue
          // 全场只赋予一次：已经挂着或已经消耗过的人不再拿
          if (t.ward || t.wardUsed) continue
          t.ward = {
            amount: healOf(u) * eff.scale, hpMax: eff.hpMax,
            srcSide: u.side, srcPos: u.idx,
          }
          ctx.log(`  ${nameOf(t)} 获得急救（生命≤${Math.round(eff.hpMax * 100)}%时回血）`)
          emitEvent(ctx, { type: "buff", source: unitRef(u), target: unitRef(t), effects: ["ward"] })
          tryWard(ctx, t)
        }
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

      // 周期伤害先保存来源与倍率。正常每跳读取当前攻防 / 增减伤；施加者阵亡后
      // 退回施放快照继续存在。DMGZone 与 DMGDot 的命中 / 暴击规则在 endTurn 分流。
      case "dot":
        // 固定场地把完整伤害参数存进地面对象，不再往施放瞬间的人身上挂 Zone DoT。
        // 每次跳伤害都由 endTurn 按 lo~hi 重新扫描当前占位，所以位移进出会立刻改变承伤者。
        if (eff.icon === "Zone") {
          const aimed = dmgTargets.length ? dmgTargets : targets
          const lanes = fieldLanes(skill, aimed)
          const ground = (aimed[0] || targets[0])
            ? state.sides[(aimed[0] || targets[0]).side]
            : null
          if (lanes && ground) {
            upsertField(ground, {
              lo: lanes.lo, hi: lanes.hi,
              icon: "Zone", scale: eff.scale, tickHits: eff.tickHits,
              canCrit: Boolean(eff.canCrit), alwaysCrit: Boolean(eff.alwaysCrit),
              canEvade: Boolean(eff.canEvade), applyStability: eff.applyStability !== false,
              turns: eff.turns, period: eff.period || 1, tick: 0,
              sourceId: u.id, sourceSide: u.side, sourcePos: u.idx,
              // 老对局 / 找不到来源时的兜底；正常结算读取来源与目标的**当前**面板。
              sourceAtk: atkOf(u), sourceAcc: accOf(u), sourceCrit: critOf(u), sourceCritDmg: critDmgOf(u),
              sourceDealF: factorOf(u, "dmg_deal") * factorOf(u, `enh_${tmplOf(u).bullet}`),
              sourceStabilityFloor: stabilityFloor(u), sourceBullet: tmplOf(u).bullet,
              attackType: tmplOf(u).atkType, st: T,
            })
            const pos = lanes.lo === lanes.hi ? `${lanes.lo + 1}` : `${lanes.lo + 1}～${lanes.hi + 1}`
            ctx.log(`  ${DOT_TEXT.Zone}覆盖 ${pos} 号位（${eff.turns}回合，每${eff.period || 1}回合重新扫描）`)
          }
          break
        }
        for (const t of targets) {
          if (!t.alive) continue
          t.dots.push({
            icon: eff.icon || "Burn", scale: eff.scale,
            canCrit: Boolean(eff.canCrit), alwaysCrit: Boolean(eff.alwaysCrit),
            canEvade: Boolean(eff.canEvade), applyStability: eff.applyStability !== false,
            turns: eff.turns, period: eff.period || 1, tick: 0,
            sourceId: u.id, sourceSide: u.side, sourcePos: u.idx,
            sourceAtk: atkOf(u), sourceAcc: accOf(u), sourceCrit: critOf(u), sourceCritDmg: critDmgOf(u),
            sourceDealF: factorOf(u, "dmg_deal") * factorOf(u, `enh_${tmplOf(u).bullet}`),
            sourceStabilityFloor: stabilityFloor(u), sourceBullet: tmplOf(u).bullet,
            attackType: tmplOf(u).atkType, st: T,
          })
          ctx.log(`  ${nameOf(t)} 陷入${DOT_TEXT[eff.icon] || "持续伤害"}（${eff.turns}回合，每${eff.period || 1}回合跳）`)
          emitEvent(ctx, { type: "debuff", source: unitRef(u), target: unitRef(t), effects: ["dot"] })
        }
        break

      case "charge": {
        u.charge = {
          hits: eff.hits, hitBlocks: eff.hitBlocks, block: Boolean(eff.block), count: eff.count,
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
        // 技能 1 级血量为 0 就不部署（志美子的掩体）—— 立一堵 0 血的墙等于当场碎掉
        if (!tpl || eff.inactive) break
        /**
         * 落点＝这一发**主目标**所在的战场。两种来源同一条规则：
         *   日富美「打谁」—— 主目标是敌人，墙扔进敌方那半边，接住那半边打过来的刀
         *   静子「给谁」—— 主目标是自己人，墙架在我方那半边，接的还是打向那半边的刀
         * 号位在两边是镜像的，所以这里不用分支；施法者是支援（没有号位）时也天然对，
         * 因为 `dmgTargets` 里装的是被圈中的主力。
         */
        const blockIdx = (dmgTargets.find((t) => !t.summon) || dmgTargets[0])?.idx ?? u.idx
        const onAlly = dmgTargets.some((t) => t.side === u.side)
        const key = sourceKeyOf(u.side, u.idx)
        // 同一施法者重复使用时清掉旧召唤；掩体还要保证同一路只有一个，技能掩体会替换
        // 该路原有的场地掩体或别的技能掩体，而不是叠出两次 30% 判定。
        const replacedCover = eff.cover
          ? (me.summons || []).find((s) => s.cover && s.blockIdx === blockIdx) || null
          : null
        me.summons = (me.summons || []).filter((s) => (s.alive || s.fieldCover)
          && s.sourceKey !== key
          && !(eff.cover && s.cover && s.blockIdx === blockIdx))
        const hp = Math.round(tpl.hp + tmplOf(u).hp * (eff.hpRate || 0))
        const doll = {
          summon: true, id: eff.summonId, side: u.side, idx: blockIdx, blockIdx,
          hp, maxhp: hp, shield: 0, shieldMax: 0, shieldTurns: 0,
          /**
           * **抛出型（人偶）和布置型（掩体）是两套挡刀口径**，别再合成一条：
           *   人偶 `cover=false` —— 扔到敌方半场的诱饵，那**一整个战场**打过来的刀全归它接
           *   掩体 `cover=true`  —— 架在自己这边的掩护，只管**自己那一路**；
           *                        `Block=1` 分段掷中 30% 后才由它承伤
           */
          ...(eff.cover ? { cover: true } : {}),
          ...(onAlly ? { onAlly: true } : {}),
          // dots 不能漏：灼烧 / 中毒等状态也可能落到召唤物身上；老存档还可能带 Zone DoT
          buffs: [], regens: [], dots: [], stun: 0,
          taunt: 0, tauntKind: null, focus: 0, turns: eff.turns, turnsMax: eff.turns, st: T,
          sourceKey: key, alive: true,
        }
        me.summons.push(doll)
        // 入场 Provoke 走跟椿同一个位置：同一方只留最后放的那个嘲讽目标
        if (eff.taunt) setTaunt(me, doll, eff.taunt, T, "provoke")
        ctx.log(`  ${nameOf(u)} ${onAlly ? "部署" : "召唤"}${tpl.name}（${hp} 生命，` +
          `${onAlly ? "架在己方" : "扔到敌方"} ${blockIdx + 1} 号位前` +
          (replacedCover ? "，替换该路原掩体" : "") +
          (eff.taunt ? `，嘲讽 ${eff.taunt} 回合` : "") +
          // 掩体没有时长（原数据的 Summon 效果压根没有 Duration），只有被打掉和被自己顶掉
          `，${eff.turns == null ? "打掉才消失" : `${eff.turns}回合`}）`)
        emitEvent(ctx, {
          type: "summon", source: unitRef(u), target: unitRef(doll),
          name: tpl.name, hp, turns: eff.turns, ...(replacedCover ? { replaced: true } : {}),
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
       * 位移（泉奈）：朝本次自动攻击主目标的号位移动一格。
       * 四格模型里仍用 swapPos 保持「一格一人」，但这在规则上是泉奈移动，不要求邻位队友存活：
       * 邻位已经阵亡时，她照样进入那个空出的号位，阵亡单位对象退到她原来的格子。
       */
      case "reposition": {
        const aim = dmgTargets.find((t) => t.side !== u.side)
          || laneTarget(u, state.sides[1 - u.side])
        if (!aim || aim.idx === u.idx) { ctx.log(`  ${nameOf(u)} 已与目标对位，留在原位`); break }
        const next = u.idx + Math.sign(aim.idx - u.idx)
        const dest = me.units[next]
        if (!dest) { ctx.log(`  ${nameOf(u)} 已在战线边缘，留在原位`); break }
        const destWasAlive = dest.alive
        const crossed = zoneOf(u.idx) !== zoneOf(dest.idx)
        swapPos(state, me, u, dest)
        ctx.log(`  ${nameOf(u)} 朝 ${nameOf(aim)} 移动一格` +
          `${destWasAlive ? `（${nameOf(dest)} 调整到她原来的位置）` : `（进入 ${nameOf(dest)} 的阵亡位置）`}` +
          `${crossed ? "，跨过战场分界" : ""}`)
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
          } else if (eff.key === "bonusChance") {
            // 真白：给「下 1 次 EX」的追伤概率加算，封顶两层。EX 放完在 execute 里清零
            const before = t.bonusChance || 0
            t.bonusChance = Math.min(eff.max ?? eff.step, before + eff.step)
            if (t.bonusChance === before) continue
            ctx.log(`  ${nameOf(t)} 下次 EX 的追伤概率 +${Math.round(eff.step * 100)}%（现 +${Math.round(t.bonusChance * 100)}%）`)
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
          tryWard(ctx, t)
        }
        break
    }
  }
}

/**
 * ③-a / ③-b 是同一拍先锁目标：前手把目标击倒后，后手不重锁，但那份伤害直接丢失。
 * action 事件仍保留原锁定目标，图上能看出「这一刀原本打谁」；不再生成 damage / miss 数字。
 */
function lockedTargetGone(locked, tgt) {
  return Boolean(locked && tgt && !tgt.alive)
}

/** 某一段是否能被掩体挡；旧数据没带 hitBlocks 时退回技能级 block。 */
function blockAt(skill, hitBlocks, i) {
  return Array.isArray(hitBlocks) && i < hitBlocks.length
    ? Boolean(hitBlocks[i])
    : Boolean(skill?.block)
}

/**
 * 执行一个技能（EX / 普通技能 / 普攻）。
 * @param {string} label 日志抬头，含技能名
 * @param {"ex"|"skill"|"normal"} actionKind 供渲染层区分动作类型
 * @param {{targets:Array<object>}} [lockedPlan] ③-a 同时锁定的落点计划，传入后不再重算、打死也不换人
 */
function execute(ctx, u, skill, label, actionKind, lockedPlan) {
  const { state } = ctx
  const me = state.sides[u.side]
  const foes = state.sides[1 - u.side]
  const locked = Boolean(lockedPlan)
  const plan = lockedPlan || resolveTargetPlan(state, u, skill, foes, me)
  const { targets } = plan
  // 一个合法目标都没有 = 这一发根本没出去。返回 false 让调用方决定要不要算「出手过」——
  // 小春的「我来治疗！」要求队友血量 ≤50%，全队满血时她不该白白扣掉冷却和普攻
  if (!targets.length && skill.target !== "self") return false

  ctx.log(`[${u.side === 0 ? "蓝" : "红"}] ${nameOf(u)} ${label}`)
  // action.targets 是「这一发实际打到谁」，战场图按它画连线。
  // 连发 / 弹射会在结算过程中换人，先占位再回填，否则图上只剩第一发那条线。
  const actionEv = {
    type: "action", source: unitRef(u),
    action: actionKind,
    skillName: skill.name || null,
    kind: skill.hits ? "damage" : "support",
    targetType: skill.target || "enemy_single",
    // 掩体只改变底层承伤对象；箭头和玩家可见的伤害反馈始终留在技能自动选中的人身上。
    targets: targets.map(unitRef),
  }
  emitEvent(ctx, actionEv)

  const hit = []
  // 条件追伤：状态到了哪一档就换哪一组倍率（妮露的 Fury、爱丽丝的能量充能）
  const alt = altHitsOf(u, skill)
  const hits = alt?.hits || skill.hits
  const hitBlocks = alt?.hitBlocks || skill.hitBlocks
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
        const aim = ring[i % ring.length]
        // 每一发都是一个新的主目标；掩体只在 strike 内按该段 Block 独立掷 30%。
        strike(ctx, u, aim, [hits[i]], actionKind, skill, [blockAt(skill, hitBlocks, i)])
        if (!hit.includes(aim)) hit.push(aim)
      }
    } else if (!locked && skill.target === "enemy_chain") {
      // 连发：第一发沿用本技能的固定索敌，后面每一发都照普攻的规则重锁一次
      //（人偶 → 前排 → 中排 → 后排），不再有「不能和上一发相同」那条 ——
      // 有前排就后两发全打前排，有人偶就全打人偶，这才是「视作普攻索敌」。
      // 每发都在结算之后重算，所以打死人会自动换目标（本战场清空就越界）。
      const first = targets[0]
      for (const [i, pct] of hits.entries()) {
        // 第一枪沿用初始固定索敌；后续每枪按普攻规则重锁，Block 跟着该枪交给 strike。
        const t = i === 0 && first?.alive
          ? first
          : laneTarget(u, foes)
        if (!t) break
        strike(ctx, u, t, [pct], actionKind, skill, [blockAt(skill, hitBlocks, i)])
        if (!hit.includes(t)) hit.push(t)
      }
    } else if (!locked && skill.target === "enemy_random") {
      // 弹射：每一段单独抽目标
      for (const [i, pct] of hits.entries()) {
        const al = aliveOf(foes)
        if (!al.length) break
        const t = randPick(state, al)
        strike(ctx, u, t, [pct], actionKind, skill, [blockAt(skill, hitBlocks, i)])
        if (!hit.includes(t)) hit.push(t)
      }
    } else {
      // AoE 默认无衰减，每个目标吃全额分段。两个例外，都靠「targets[0] 是主目标」成立
      // （由 expandAdjacent 保证，生成器也只在 adjacent/all 上给这两个字段）：
      //   splashHits —— 「单体 + 以其为中心的范围」，主目标吃直击＋爆风，扩散只吃爆风（爱露）
      //   falloff    —— 贯穿逐个递减，第 i 个目标 ×(1 − min(rate×i, max))（晴奈）
      for (const [i, t] of targets.entries()) {
        if (lockedTargetGone(locked, t)) continue
        const splashOnly = i > 0 && skill.splashHits
        const base = splashOnly ? skill.splashHits : hits
        const blocks = splashOnly
          ? (skill.splashHitBlocks || skill.splashHits.map(() => false))
          : hitBlocks
        const cut = skill.falloff ? Math.min(skill.falloff.rate * i, skill.falloff.max) : 0
        strike(ctx, u, t, cut ? base.map((h) => h * (1 - cut)) : base, actionKind, skill, blocks)
        hit.push(t)
      }
    }
  }
  /**
   * **概率追伤**（真白，全 272 人只有她）。主伤害打完之后掷一次骰子，中了就再多打一发。
   *
   * 它是**独立的一发**（单独 roll 命中和暴击），所以走 `strike` 而不是并进上面那组倍率 ——
   * 这跟 `altHits`（换掉整套倍率）是两件事。
   * 概率 = 技能自带的 50% ＋ 普通技能攒下的加算（`u.bonusChance`，每次 +12.5% 最多两层）。
   * 攒到的那份**用掉就清零**：原文写的是「下 1 次 EX 技能」，不是永久。
   */
  if (skill.bonus && hit.length) {
    const chance = Math.min(1, skill.bonus.chance + (u.bonusChance || 0))
    if (nextRandom(state) < chance) {
      const t = hit.find((x) => x.alive) || hit[0]
      ctx.log(`  追加伤害触发（${Math.round(chance * 100)}%）`)
      strike(ctx, u, t, skill.bonus.hits, actionKind, skill, skill.bonus.hitBlocks)
      if (!hit.includes(t)) hit.push(t)
    }
    if (actionKind === "ex") u.bonusChance = 0
  }
  // ③-a / ③-b 同时锁定时保留开场锁定列表：后手目标已倒下会伤害缺失，但不能在图上伪装成换了目标。
  // 只有连发 / 循环 / 弹射这类未锁定技能，才用结算过程中实际换到的人回填。
  if (hit.length && !locked) actionEv.targets = hit.map(unitRef)

  applyEffects(ctx, u, skill, hit.length ? hit : targets, me, actionKind)
  return true
}

/**
 * 这一发普攻用哪套参数。强化形态抄 `u.charge`（鹤城扇形 / 瞬改索敌），否则抄模板。
 * ③-b 同时锁定时先拿这个去 resolveTargets，再交给 autoAttack 结算。
 */
function autoSkillOf(u) {
  const tmpl = tmplOf(u)
  const block = Boolean(tmpl.autoAttack?.block)
  const c = u.charge
  if (c && (c.shots > 0 || c.turns > 0)) {
    const hits = c.hits
    // 强化形态读取自己的 FormChange.Damage.Block；没带元数据的旧存档才退回基础普攻。
    const chargedBlock = Array.isArray(c.hitBlocks) ? Boolean(c.hitBlocks[0]) : block
    return {
      target: c.count > 1 ? "enemy_adjacent" : "enemy_single",
      count: c.count, hits, effects: [],
      charged: true, block: chargedBlock,
      hitBlocks: c.hitBlocks || hits.map(() => chargedBlock),
    }
  }
  const hits = tmpl.autoAttack.hits
  return {
    target: tmpl.autoAttack.target || "enemy_single",
    count: tmpl.autoAttack.count || 1,
    hits, effects: [], block,
    hitBlocks: tmpl.autoAttack.hitBlocks || hits.map(() => block),
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
 * `lockedPlan` 由 ③-b 同时锁定传入。不换人，伤害照算；普攻触发的技能（泉奈手里剑）
 * 在 tryAutoProc 里另走 execute，不带锁，目标死了会重锁。
 */
function autoAttack(ctx, u, lockedPlan) {
  const c = u.charge
  const sk = autoSkillOf(u)
  if (c && c.shots > 0) c.shots -= 1
  execute(ctx, u, {
    // `block` / `hitBlocks` 不能漏：这里重新拼了一个技能对象交给 execute，漏掉后 strike
    // 就不知道每个普攻分段能否触发掩体的 30% 承伤判定。
    target: sk.target, count: sk.count, hits: sk.hits, effects: [],
    block: sk.block, hitBlocks: sk.hitBlocks,
  }, sk.charged ? "强化普攻" : "普攻", "normal", lockedPlan)
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

/** 周期伤害的施加者。支援也可能放场地，所以按 0~5 号位找；老存档没有来源时返回 null。 */
function periodicSourceOf(state, d) {
  if (!Number.isInteger(d?.sourceSide)) return null
  const side = state.sides[d.sourceSide]
  if (!side) return null
  // 泉奈换位后 idx 会变，保存的 sourcePos 可能已经站着别人；先验 id，不对就按 id 追到当前对象。
  if (Number.isInteger(d.sourcePos)) {
    const at = casterAt(side, d.sourcePos)
    if (at?.id === d.sourceId) return at
  }
  return castersOf(side).find((u) => u.id === d.sourceId) || null
}

/** 用快照命中值计算命中率，供施加者已阵亡但场地仍存续时使用。 */
function hitChanceFrom(acc, tgt) {
  const gap = Math.max(dodgeOf(tgt) - Math.max(0, acc || 0), 0)
  return Math.min(1, Math.max(0, CFG.HIT_BASE / (gap * CFG.HIT_C + CFG.HIT_BASE)))
}

/** 用快照暴击值计算暴击率。 */
function critChanceFrom(crit, tgt) {
  const gap = Math.max(Math.max(0, crit || 0) - critResOf(tgt), 0)
  return Math.min(1, Math.max(0, 1 - CFG.CRIT_BASE / (gap * CFG.CRIT_C + CFG.CRIT_BASE)))
}

/** 周期伤害不画施加者连线，但伤害本身仍走护盾、不死、急救和死亡清理。 */
function applyPeriodicDamage(ctx, tgt, dmg, meta) {
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
  const saved = tgt.hp <= 0 && tgt.immortal > 0 && wasAlive
  if (saved) tgt.hp = 1

  emitEvent(ctx, {
    type: "damage", source: null, target: unitRef(tgt), dot: true, dotIcon: meta.icon,
    amount: Math.round(dmg), absorbed: Math.round(absorbed), totalAmount: Math.round(total),
    crit: meta.critHits > 0, critHits: meta.critHits,
    affinity: affinityMark(meta.aff), attackType: meta.attackType,
    hits: meta.hits, landed: meta.landed,
  })
  const seg = meta.hits > 1 ? ` [${meta.landed}/${meta.hits}段]` : ""
  ctx.log(`  ${nameOf(tgt)} ${DOT_TEXT[meta.icon] || "持续伤害"} ${Math.round(dmg)}${seg}` +
    (meta.critHits ? `（${meta.critHits}段暴击）` : ""))
  if (saved) ctx.log(`  ${nameOf(tgt)} 靠不死撑住了（剩 1 生命）`)

  if (tgt.hp <= 0) {
    tgt.hp = 0
    if (wasAlive) {
      tgt.alive = false; tgt.taunt = 0; tgt.focus = 0
      tgt.regens.length = 0; tgt.dots.length = 0
      tgt.ward = null
      ctx.log(`  ✝ ${nameOf(tgt)} ${tgt.summon ? "被烧毁" : "倒下"}`)
    }
  } else {
    tryWard(ctx, tgt)
  }
}

/**
 * 一次周期伤害跳动。
 *
 * - DMGZone：每个原始 HitFrame 独立判命中 / 暴击 / 稳定，并读取结算时当前攻防与增减伤。
 * - DMGDot：不判闪避、不暴击，但同样读取当前攻防与增减伤。
 * - 老存档只有 `amount` 时保留旧固定伤害，避免 Redis 中进行中的对局崩掉。
 */
function tickPeriodicDamage(ctx, tgt, d) {
  const { state } = ctx
  if (!tgt.alive) return

  const idx = Math.max(0, (d.tick || 1) - 1)
  const hits = Array.isArray(d.tickHits)
    ? (d.tickHits[Math.min(idx, d.tickHits.length - 1)] || [])
    : d.scale != null ? [d.scale * 100] : null

  // 老存档兼容：以前在施放时把 `atk × scale` 算死，既没有来源也没有倍率。
  if (!hits?.length) {
    const hurt = Math.max(1, d.amount || 0)
    applyPeriodicDamage(ctx, tgt, hurt, {
      icon: d.icon, hits: 1, landed: 1, critHits: 0,
      aff: 1, attackType: d.attackType || "持续",
    })
    return
  }

  const src = periodicSourceOf(state, d)
  // 来源存活时读当前面板；场地施加者已阵亡时退回施放快照，场地本身继续存在。
  const liveSource = src?.alive ? src : null
  const attackType = liveSource ? tmplOf(liveSource).atkType : (d.attackType || "持续")
  const bullet = liveSource ? tmplOf(liveSource).bullet : d.sourceBullet
  const atk = liveSource ? atkOf(liveSource) : (d.sourceAtk || 0)
  const dealF = liveSource
    ? factorOf(liveSource, "dmg_deal") * factorOf(liveSource, `enh_${bullet}`)
    : (d.sourceDealF || 1)
  const acc = liveSource ? accOf(liveSource) : d.sourceAcc
  const crit = liveSource ? critOf(liveSource) : d.sourceCrit
  const critDmg = liveSource ? critDmgOf(liveSource) : d.sourceCritDmg
  const floor = d.applyStability === false
    ? 1
    : liveSource ? stabilityFloor(liveSource) : (d.sourceStabilityFloor ?? 1)

  const aff = affinity(attackType, tmplOf(tgt).defType)
  const dm = defModOf(tgt)
  const takeF = Math.max(0.1, factorOf(tgt, "dmg_take"))
  const hr = d.canEvade ? hitChanceFrom(acc, tgt) : 1
  const cr = d.canCrit ? critChanceFrom(crit, tgt) : 0
  const cm = Math.max(1, ((critDmg || 0) - critDmgResOf(tgt)) / 10000)

  let total = 0, landed = 0, critHits = 0
  for (const pct of hits) {
    if (d.canEvade && nextRandom(state) >= hr) continue
    landed++
    const isCrit = d.alwaysCrit || (d.canCrit && nextRandom(state) < cr)
    if (isCrit) critHits++
    let amount = atk * (pct / 100) * aff * dm * Math.max(0.1, dealF) * takeF
    amount *= randRange(state, floor, 1)
    if (isCrit) amount *= cm
    total += Math.max(1, amount)
  }

  if (!landed) {
    ctx.log(`  ${nameOf(tgt)} 闪避了${DOT_TEXT[d.icon] || "持续伤害"}（${hits.length}段全空）`)
    emitEvent(ctx, {
      type: "miss", source: null, target: unitRef(tgt), dot: true, dotIcon: d.icon,
      attackType, hits: hits.length, landed: 0,
    })
    return
  }
  applyPeriodicDamage(ctx, tgt, total, {
    icon: d.icon, hits: hits.length, landed, critHits, aff, attackType,
  })
}

/**
 * 状态都从施放瞬间写入，时长一律按「**它真正起作用的 N 个攻击窗口**」计：
 * 防御向（含护盾、不死、嘲讽）跟敌方回合跳，进攻向与控制、持续治疗跟自己方回合跳。
 * 回合末固定顺序是：状态层更新 → 持续治疗 → 伤害性状态。判据见 `DEFENSIVE_STATS` 的注释。
 */
function endTurn(ctx, side) {
  const { state } = ctx
  const T = state.turnId
  const ticking = side.side

  for (const s of state.sides) {
    // 支援也要跳增益；佩洛洛既然能成为治疗/生命判定目标，挂到它身上的增益和护盾也必须正常计时。
    for (const u of [...castersOf(s), ...summonsOf(s)]) {
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
      if (!u.summon && u.taunt > 0 && 1 - u.side === ticking && u.tauntSt !== T) u.taunt -= 1
      // 集火跟嘲讽同一把防御向尺子：换来的是敌人（其实是己方）的一次出手
      if (!u.summon && u.focus > 0 && 1 - u.side === ticking && u.focusSt !== T) u.focus -= 1
    }
  }

  // 召唤物按**敌方**回合跳：它挡的是敌人的攻击窗口，跟护盾同一套口径。
  // 6 轮 = 撑过敌人 6 次出手；施放当回合不扣（st !== T）。
  for (const s of state.sides) {
    if (s.side === ticking) continue
    for (const sm of [...(s.summons || [])]) {
      if (!sm.alive || sm.st === T) continue
      if (sm.taunt > 0) sm.taunt -= 1
      // `turns == null` = **永久**（掩体）：原数据里没有 Duration，只有被打掉和被自己顶掉
      if (sm.turns == null) continue
      sm.turns -= 1
      if (sm.turns <= 0) {
        sm.alive = false
        ctx.log(`  ${tmplOf(sm).name} 消失了`)
      }
    }
    // 死亡场地掩体保留为纯视觉残骸；佩洛洛与技能掩体仍按原规则从状态里清掉。
    // `summonsOf()` 只返回 alive，对索敌、场地伤害与格挡结算都没有影响。
    s.summons = (s.summons || []).filter((x) => x.alive || x.fieldCover)
  }

  // 持续治疗在状态层更新之后、伤害性状态之前结算。
  // 先抬血再吃 DoT / 场地伤害；这也是为什么回合末顺序会直接改变生死。
  // 持续治疗按承受者自己的回合跳，固定排在 DoT / 场地伤害之前。
  //
  // 这里**不能**照抄 buff/护盾那套 `st === T 就跳过本回合` 的写法：持续治疗永远由己方
  // 施加，也就永远在自己的回合结算，跳过施放回合等于把第一跳推迟整整一轮。星野的急救
  // 治疗是「生命≤30% 触发、每场限 1 次」的救命技能，延后一轮基本等于没放。
  // 支援也在列 —— 它们的**技能冷却**在这个循环末尾跳（见下面的 skillCd），
  // 漏了的话支援的普通技能只放得出第一发，之后永远压在冷却里
  for (const u of [...castersOf(side), ...perorosOf(side)]) {
    if (!u.alive) continue
    for (const r of [...u.regens]) {
      r.tick += 1
      if (r.tick % r.period === 0) {
        const h = Math.min(r.amount, u.maxhp - u.hp)
        if (h > 0) {
          u.hp = Math.min(u.maxhp, u.hp + h)
          ctx.log(`  ${nameOf(u)} 持续治疗 +${Math.round(h)}`)
          emitEvent(ctx, { type: "heal", source: unitRef(u), target: unitRef(u), amount: Math.round(h) })
        }
      }
      r.turns -= 1
      if (r.turns <= 0) u.regens.splice(u.regens.indexOf(r), 1)
    }

    // 佩洛洛只参加上面的持续治疗；技能冷却、控制和自身形态仍是学生专属状态。
    if (u.summon) continue

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

  /**
   * 伤害性状态最后结算：状态层跳时 / 到期 → 持续治疗 → DoT / 固定场地。
   *
   * - DMGZone（场地）：每个压缩后的原始 HitFrame 独立判命中、暴击、稳定；读取当前攻防与增减伤。
   * - DMGDot（灼烧 / 中毒等）：不判闪避、不暴击，但同样读取当前攻防与增减伤。
   * - 不发 action 事件，战场图不画来源连线；场地施加者阵亡后用施放快照继续跳。
   * - 普通 DoT 跟随原目标；场地每跳重扫当前号位，召唤物站在范围里也会受到伤害。
   */
  for (const u of [...side.units, ...summonsOf(side)]) {
    for (const d of [...(u.dots || [])]) {
      if (d.st === T) continue
      d.tick += 1
      if (d.tick % d.period === 0 && u.alive) tickPeriodicDamage(ctx, u, d)
      // 致死会在 applyPeriodicDamage 里清空 dots；对象已不在数组时别再回写时长。
      if (!(u.dots || []).includes(d)) break
      d.turns -= 1
      if (d.turns <= 0) u.dots.splice(u.dots.indexOf(d), 1)
    }
  }

  // 新版场地的伤害参数全存在 field 上，每次跳伤害先重扫当前号位，再统一扣一轮时长。
  // 老对局的 field 没有 icon / 伤害参数，仍由上面的单位 Zone DoT 结算，这里只替旧圈倒计时。
  for (const f of [...(side.fields || [])]) {
    if (f.st === T) continue
    if (f.icon === "Zone") {
      f.tick = (f.tick || 0) + 1
      if (f.tick % (f.period || 1) === 0) {
        // 先取当前占位快照：同一次场地跳动对范围内所有人同时生效，不因前一个人倒下而缩圈。
        for (const u of fieldOccupants(side, f)) tickPeriodicDamage(ctx, u, f)
      }
    }
    f.turns -= 1
    if (f.turns <= 0) side.fields.splice(side.fields.indexOf(f), 1)
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

/**
 * Cost 回复只取决于存活人数，**支援也算**：满编 6 人 = 3/回合。
 * 支援不会死，所以每方恒定有 1.0 打底，主力全灭之前在 2.0~3.0 之间。
 * 白热化时每个存活的场上主力回复乘以 `FEVER_COST_MULT`；支援仍各回 0.5。
 */
export const regenOf = (side, state) => {
  const base = CFG.COST_REGEN_PER_UNIT * aliveCastersOf(side).length
  if (!state || !feverOn(state)) return base
  const fieldCount = side.units.filter(feverFieldUnitOf).length
  const extraPerFieldUnit = CFG.COST_REGEN_PER_UNIT * (Math.max(1, CFG.FEVER_COST_MULT || 1) - 1)
  return base + fieldCount * extraPerFieldUnit
}

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
  // 支援也能放 EX，所以按名字找人要在 4 主力 + 2 支援里找
  const mine = castersOf(state.sides[state.activeSide])
  const pick = (units, id) => units.find((u) => u.id === id)
  const label = (id) => BY_ID[id]?.name || id

  const casts = []
  for (const c of action.casts) {
    if (c.target != null) return { error: "EX 不能指定目标，只能选择释放者" }
    let pos = c.pos
    if (pos == null) {
      const u = pick(mine, c.id)
      if (!u) return { error: `你的队伍里没有${label(c.id)}` }
      pos = u.idx
    }
    casts.push({ pos })
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
  const u = casterAt(side, cast.pos)
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
 * @param {{type:'pass'}|{type:'ex', casts:Array<{pos?:number,id?:string}>}} action
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
    const u = casterAt(side, cast.pos)
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
        execute(ctx, u, ex, `EX「${ex.name}」(-${cost})`, "ex")
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
  // 支援跟主力一起在这一阶段出手，结算顺序排在 4 个主力之后（5、6 号）。
  // ③-b 的普攻阶段**不遍历支援** —— 它们原数据里就没有 Skills.Normal。
  const skillQueue = []
  for (const u of castersOf(side)) {
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
    const locked = resolveTargetPlan(state, u, sk, foes(), side)
    if (!locked.targets.length && sk.target !== "self") continue
    skillQueue.push({ u, sk, locked })
  }
  for (const { u, sk, locked } of skillQueue) {
    if (!u.alive) continue
    if (!execute(ctx, u, sk, `普通技能「${sk.name}」`, "skill", locked)) continue
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
      locked: resolveTargetPlan(state, u, autoSkillOf(u), foes(), side),
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
