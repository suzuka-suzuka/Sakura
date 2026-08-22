/**
 * 战场分割与对线锁定的规则回归。
 *
 * 这几条规则很容易在改目标选择时被悄悄改坏，而压测只看不变量、看不出「打错人」，
 * 所以单独写成断言。改 laneTarget / expandAdjacent / resolveTargets 之后必跑：
 *
 *   node scripts/target-test.mjs
 */
import { createBattle, playerTurn, validateAction, exCastableOf, exWaitOf, exCostOf, exLockLenOf, regenOf, tmplOf, atkOf, dfsOf, healOf, provokedBy, focusedOf, exLockedOf, exSealedOf, autoProcChance } from "../lib/ba/engine.js"
import { ROSTER, CFG } from "../lib/ba/roster.js"
import { describeEffect } from "../lib/ba/format.js"
import { parseAction } from "../lib/ba/parse.js"
import { buildBattleHtml } from "../lib/ba/battleHtml.js"
import { statusIconOf, summonArtOf, fieldCoverArtOf } from "../lib/ba/htmlAssets.js"

const id = (n) => ROSTER.find((t) => t.name === n).id

/**
 * 编成是 4 主力 + 2 支援。绝大多数用例只关心 1~4 号位打谁，所以只写四个名字，
 * 这里补两个支援凑满编成 —— **不能干脆不给**：EX 冷却长度 = 存活总人数 − 3，
 * 少两个人整条冷却链就失真（第 16 组「剩 3 人放完 1 不能立刻再放 1」曾经因此假绿）。
 *
 * 但填充的支援必须**在编不出手**：随便挑两个都不惰性 —— 花子的普技加防走 Channel 103，
 * 会把椿自己的防御层顶掉，第 26 组的窗口计数当场从 6 变 7。所以建局后直接把它们的
 * 普通技能冷却压到永不就绪，它们只贡献人头（冷却长度、Cost 回复、可放名单）。
 * 要真的让支援出手的用例，自己写满 6 个名字。
 */
const FILLER_SUPPORTS = ["芹娜", "花子"]
const withSupports = (picks) => (picks.length >= 6 ? picks : [...picks, ...FILLER_SUPPORTS])
const muteFillers = (st, given) => {
  if (given.length >= 6) return
  for (const side of st.sides) for (const u of side.supports || []) u.skillCd = 9999
}

/**
 * 建一局并按 kill 列表把人打死（kill 是 [side, idx] 列表）。多数规则用例隔离掉场地掩体，
 * 避免随机格挡改写与该用例无关的伤害；掩体 / 场地联动组显式传 `fieldCovers:true` 测真实开局。
 */
function setup(bluePicks, redPicks, kills = [], { fieldCovers = false } = {}) {
  const st = createBattle(
    { uid: "a", name: "蓝", picks: withSupports(bluePicks).map(id) },
    { uid: "b", name: "红", picks: withSupports(redPicks).map(id) },
    { seed: 11, first: 0 }
  )
  muteFillers(st, bluePicks)
  muteFillers(st, redPicks)
  if (!fieldCovers) for (const side of st.sides) side.summons = []
  for (const [side, idx] of kills) {
    const u = st.sides[side].units[idx]
    u.alive = false; u.hp = 0
  }
  // 普通技能压住不放，否则大家都去放自身增益，根本不普攻，就测不到对线锁定
  for (const s of st.sides) for (const u of s.units) u.skillCd = 99
  st.sides[0].cost = 10; st.sides[1].cost = 10
  return st
}

/** 把一步打完：EX 之后若还停着，自动「过」把技能/普攻收掉。测对线/技能落点要用完整回合。 */
function run(st, action) {
  let r = playerTurn(st, action)
  while (!r.error && r.state.phase === "command" && r.state.turnOpen) {
    const n = playerTurn(r.state, { type: "pass" })
    r = { ...n, events: r.events.concat(n.events || []), log: r.log.concat(n.log || []) }
  }
  return r
}

/** 跑一个「过」的回合，收集普攻的 源→目标 对 */
function autoPairs(st) {
  const r = playerTurn(st, { type: "pass" })
  const out = []
  for (const ev of r.events) {
    if (ev.type !== "action" || ev.action !== "normal") continue
    out.push({
      from: ev.source.pos + 1,
      to: (ev.targets || []).map((t) => t.pos + 1),
    })
  }
  return out
}

let bad = 0
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`${ok ? "✓" : "✗"} ${label}\n    实际 ${JSON.stringify(got)}${ok ? "" : `\n    期望 ${JSON.stringify(want)}`}`)
}

const OUT = ["野宫", "野宫", "野宫", "野宫"]        // 全后排，测对位/铺开时不被前排削层
const TANK1 = ["星野", "野宫", "野宫", "野宫"]      // 1 位前排（星野）+ 后排

console.log("=== 1. 默认对位：各打各的战场 ===")
check("蓝方四人普攻的目标", autoPairs(setup(OUT, OUT)).map((p) => `${p.from}→${p.to}`),
  ["1→1", "2→2", "3→3", "4→4"])

console.log("\n=== 2. 红方 2、3 阵亡：红3 的对面（蓝3）打谁 ===")
// 蓝方视角：红 2、3 死。蓝3 同战场（3·4）只剩红4
check("蓝3 的普攻目标", autoPairs(setup(OUT, OUT, [[1, 1], [1, 2]])).find((p) => p.from === 3).to, [4])
check("蓝1 的普攻目标（同战场还有红1）", autoPairs(setup(OUT, OUT, [[1, 1], [1, 2]])).find((p) => p.from === 1).to, [1])

console.log("\n=== 3. 红方 1、2 全灭，蓝 1、2 才越界 ===")
const cross = autoPairs(setup(OUT, OUT, [[1, 0], [1, 1]]))
check("蓝1 越界打 3", cross.find((p) => p.from === 1).to, [3])
check("蓝2 越界打 3", cross.find((p) => p.from === 2).to, [3])
check("蓝3 不受影响", cross.find((p) => p.from === 3).to, [3])

console.log("\n=== 4. 前排挡中后排：红1 是前排（星野）===")
const tank = autoPairs(setup(OUT, TANK1))
check("蓝1 打前排", tank.find((p) => p.from === 1).to, [1])
check("蓝2 也打前排（同战场）", tank.find((p) => p.from === 2).to, [1])
check("蓝3 不受另一战场前排影响", tank.find((p) => p.from === 3).to, [3])
check("蓝4 不受另一战场前排影响", tank.find((p) => p.from === 4).to, [4])

console.log("\n=== 4b. 前 / 中 / 后：按层打，不是按坦克职业 ===")
{
  // 堇前排输出 + 芹香中排：没有坦克，刀仍打前排
  const mix = autoPairs(setup(OUT, ["堇", "芹香", "野宫", "野宫"]))
  check("前+中 → 蓝1 打前排堇", mix.find((p) => p.from === 1).to, [1])
  check("前+中 → 蓝2 也打前排堇", mix.find((p) => p.from === 2).to, [1])
  // 两个前排：还是 2 打 2，对位还在
  const twoF = autoPairs(setup(OUT, ["星野", "鹤城", "野宫", "野宫"]))
  check("两个前排 → 蓝1 对位星野", twoF.find((p) => p.from === 1).to, [1])
  check("两个前排 → 蓝2 对位鹤城", twoF.find((p) => p.from === 2).to, [2])
  // 中+后：没有前排，打中排
  const mb = autoPairs(setup(OUT, ["白子", "野宫", "野宫", "野宫"]))
  check("中+后 → 蓝1 打中排白子", mb.find((p) => p.from === 1).to, [1])
  check("中+后 → 蓝2 也打中排白子", mb.find((p) => p.from === 2).to, [1])
}

console.log("\n=== 5. 星野 EX（2 目标范围）不跨战场 ===")
const exTargets = (st, pos = 0) => {
  const r = run(st, { type: "ex", casts: [{ pos }] })
  return r.events.find((e) => e.type === "action" && e.action === "ex").targets.map((t) => t.pos + 1)
}
check("自动主目标在 1·2 → 波及同战场两人", exTargets(setup(TANK1, OUT)), [1, 2])
check("自动主目标的同战场只剩一人 → 退化成单体", exTargets(setup(TANK1, OUT, [[1, 1]])), [1])

console.log("\n=== 6. 野宫全体技能仍然打 4 个 ===")
const allSt = setup(["野宫", "星野", "野宫", "野宫"], OUT)
const rAll = run(allSt, { type: "ex", casts: [{ pos: 0 }] })
check("敌方全体命中数",
  rAll.events.find((e) => e.type === "action" && e.action === "ex").targets.length, 4)

console.log("\n=== 7. 3 目标技能走「以主目标为中心的固定窗口」（睦月）===")
const mutsuki = (pos) => {
  const picks = ["野宫", "野宫", "野宫", "野宫"]
  picks[pos] = "睦月"
  const st = setup(picks, OUT)
  const r = run(st, { type: "ex", casts: [{ pos }] })
  return r.events.find((e) => e.type === "action" && e.action === "ex").targets
    .map((t) => t.pos + 1).sort()
}
check("睦月站 1 位、自动锁 1 位 → 边缘只炸 2 个", mutsuki(0), [1, 2])
check("睦月站 2 位、自动锁 2 位 → 炸满 3 个", mutsuki(1), [1, 2, 3])
check("睦月站 3 位、自动锁 3 位 → 炸满 3 个", mutsuki(2), [2, 3, 4])
check("睦月站 4 位、自动锁 4 位 → 边缘只炸 2 个", mutsuki(3), [3, 4])
// 2 目标技能的战场分割限制不受影响，第 5 组已经断言过，这里再钉一次边界
check("2 目标技能仍然不跨战场", exTargets(setup(TANK1, OUT)).sort(), [1, 2])

console.log("\n=== 5b. 多目标只打最前那一层（白子普技 / 千世普攻 / 睦月）===")
/** who 站 1 位放普通技能，红方 picks；返回命中号位 */
function skillHits(who, redPicks) {
  const st = setup([who, "野宫", "野宫", "野宫"], redPicks)
  st.sides[0].units[0].skillCd = 0
  const r = playerTurn(st, { type: "pass" })
  const ev = r.events.find((e) => e.type === "action" && e.action === "skill" && e.source.pos === 0)
  return (ev?.targets || []).map((t) => t.pos + 1).sort()
}
function chiseAA(redPicks) {
  const st = setup(["千世", "野宫", "野宫", "野宫"], redPicks)
  const r = playerTurn(st, { type: "pass" })
  const ev = r.events.find((e) => e.type === "action" && e.action === "normal" && e.source.pos === 0)
  return (ev?.targets || []).map((t) => t.pos + 1).sort()
}
check("白子 2 目标 · 两个后排 → 两个都打", skillHits("白子", OUT), [1, 2])
check("白子 2 目标 · 前+中 → 只打前排", skillHits("白子", ["星野", "白子", "野宫", "野宫"]), [1])
check("白子 2 目标 · 中+后 → 只打中排", skillHits("白子", ["白子", "野宫", "野宫", "野宫"]), [1])
check("白子 2 目标 · 两个前排 → 两个都打", skillHits("白子", ["星野", "鹤城", "野宫", "野宫"]), [1, 2])
check("星野 EX · 前+中 → 固定索敌先打前排", exTargets(setup(["星野", "野宫", "野宫", "野宫"], ["星野", "白子", "野宫", "野宫"])), [1])
check("千世普攻 · 两个后排 → 两个都打", chiseAA(OUT), [1, 2])
check("千世普攻 · 前+中 → 只打前排", chiseAA(["星野", "白子", "野宫", "野宫"]), [1])
check("千世普攻 · 中+后 → 只打中排", chiseAA(["白子", "野宫", "野宫", "野宫"]), [1])
{
  const mutsukiMix = (red, pos = 0) => {
    const picks = ["野宫", "野宫", "野宫", "野宫"]
    picks[pos] = "睦月"
    const st = setup(picks, red)
    const r = run(st, { type: "ex", casts: [{ pos }] })
    return r.events.find((e) => e.type === "action" && e.action === "ex").targets
      .map((t) => t.pos + 1).sort()
  }
  check("睦月 3 目标 · 有前排时不能越过前排打中排",
    mutsukiMix(["星野", "白子", "鹤城", "野宫"]), [1])
  check("睦月站 2 位 · 自动主目标同为前排 · 窗口三个前排",
    mutsukiMix(["星野", "鹤城", "春香", "野宫"], 1), [1, 2, 3])
  check("睦月 3 目标 · 自动前排主目标旁边都是中后 → 退化成单体",
    mutsukiMix(["星野", "白子", "芹香", "野宫"]), [1])
}

console.log("\n=== 5c. 直线贯穿 / 场地盖战场 / 堇连发 ===")
function exHits(who, red, pos = 0) {
  const picks = ["野宫", "野宫", "野宫", "野宫"]
  picks[pos] = who
  const st = setup(picks, red)
  st.sides[0].cost = 10
  const r = run(st, { type: "ex", casts: [{ pos }] })
  return (r.events.find((e) => e.type === "action" && e.action === "ex")?.targets || [])
    .map((t) => (t.summon ? "偶" : t.pos + 1))
}
check("晴奈直线 · 自动锁前排后贯穿同战场两人",
  exHits("晴奈", ["星野", "白子", "野宫", "野宫"]).sort(), [1, 2])
check("纯子站 2 位 · 自动锁 2 位前排 → 固定窗口贯穿三人",
  exHits("纯子", ["白子", "星野", "鹤城", "野宫"], 1).sort(), [1, 2, 3])
check("爱露二段 · 前+中自动锁前排 → 不同层吃不到溅射",
  exHits("爱露", ["星野", "白子", "野宫", "野宫"]).sort(), [1])
check("爱露二段 · 两个前排 → 第二人吃溅射",
  exHits("爱露", ["星野", "鹤城", "野宫", "野宫"], 0).sort(), [1, 2])
check("日富美 EX · 前中前 → 自动锁本战场前排",
  exHits("日富美", ["星野", "白子", "鹤城", "野宫"]).sort(), [1])
{
  const st = setup(["千世", "野宫", "野宫", "野宫"], ["星野", "白子", "野宫", "野宫"])
  st.sides[0].cost = 10
  const r = run(st, { type: "ex", casts: [{ pos: 0 }] })
  check("千世场地 · 前+中 仍盖住同战场两路",
    r.state.sides[1].fields.map((f) => [f.lo + 1, f.hi + 1]), [[1, 2]])
}
function sumireShots(pos) {
  const picks = ["野宫", "野宫", "野宫", "野宫"]
  picks[pos] = "堇"
  const st = setup(picks, OUT)
  st.sides[0].cost = 10
  const r = run(st, { type: "ex", casts: [{ pos }] })
  return r.events.filter((e) => e.type === "damage" && e.source?.side === 0 && e.source.pos === pos)
    .map((e) => e.target.pos + 1)
}
check("堇 EX 连发 · 站 1 位自动锁 1 位，三发全在 1", sumireShots(0), [1, 1, 1])
check("堇 EX 连发 · 站 3 位自动锁 3 位，三发全在 3", sumireShots(2), [3, 3, 3])

console.log("\n=== 8. 召唤物挡刀（日富美的佩洛洛人偶）===")
/** 蓝1 = 日富美，EX 把人偶扔向红方 blockIdx 号位，返回随后红方普攻的 源→目标 */
function withDoll(blockIdx, skipTaunt) {
  const picks = ["野宫", "野宫", "野宫", "野宫"]
  picks[blockIdx] = "日富美"
  const st = setup(picks, OUT)
  let cur = run(st, { type: "ex", casts: [{ pos: blockIdx }] }).state
  if (skipTaunt) {
    cur = run(cur, { type: "pass" }).state // 红方（嘲讽期）
    cur = run(cur, { type: "pass" }).state // 蓝方
  }
  const r = run(cur, { type: "pass" })
  return r.events
    .filter((e) => e.type === "action" && e.action === "normal")
    .map((e) => `${e.source.pos + 1}→${(e.targets || []).map((t) => (t.summon ? "偶" : t.pos + 1)).join("")}`)
}
check("嘲讽那一轮：红方全员都被拉去打人偶", withDoll(0, false), ["1→偶", "2→偶", "3→偶", "4→偶"])
// 嘲讽过期之后它仍然挡在那半边最前面：扔进 1·2 就把 1·2 两路的刀全接了
check("嘲讽过后扔进 1·2 战场：红1 红2 都打人偶", withDoll(0, true), ["1→偶", "2→偶", "3→3", "4→4"])
// 蓝 1 日富美是中排、蓝 2 野宫是后排：红 1·2 都打最前的日富美，不是对位
check("嘲讽过后扔进 3·4 战场：红3 红4 都打人偶", withDoll(2, true), ["1→1", "2→2", "3→偶", "4→偶"])
// 人偶比前排还靠前：同战场有星野也照样先打人偶
{
  const st = setup(["日富美", "野宫", "野宫", "野宫"], TANK1)
  st.sides[0].cost = 10
  let cur = run(st, { type: "ex", casts: [{ pos: 0 }] }).state
  cur = run(cur, { type: "pass" }).state // 红方（嘲讽期）
  cur = run(cur, { type: "pass" }).state // 蓝方
  const r = run(cur, { type: "pass" })
  check("人偶优先于本战场的前排",
    r.events.filter((e) => e.type === "action" && e.action === "normal")
      .map((e) => `${e.source.pos + 1}→${(e.targets || []).map((t) => (t.summon ? "偶" : t.pos + 1)).join("")}`),
    ["1→偶", "2→偶", "3→3", "4→4"])
}

console.log("\n=== 9. 范围技撞上人偶：整发被接走，覆盖面按各自的规则算 ===")
const FOE = ["爱露", "伊织", "日奈", "真纪"] // 全后排，测范围铺开时不被前/中排削层
/** who 站 pos 位放普通技能，敌方在 doll 号位有人偶；返回命中列表 */
function skillVsDoll(who, pos, doll) {
  const picks = ["伊织", "伊织", "伊织", "伊织"]
  picks[pos] = who
  const st = setup(picks, FOE)
  st.sides[0].units[pos].skillCd = 0
  if (doll != null) {
    st.sides[1].summons = [{
      summon: true, id: 40002, side: 1, idx: doll, blockIdx: doll,
      hp: 99999, maxhp: 99999, shield: 0, shieldMax: 0, shieldTurns: 0,
      buffs: [], regens: [], stun: 0, taunt: 0, turns: 6, st: -1, sourceKey: "x", alive: true,
    }]
  }
  const r = playerTurn(st, { type: "pass" })
  const ev = r.events.find((e) => e.type === "action" && e.action === "skill" && e.source.pos === pos)
  return (ev?.targets || []).map((t) => (t.summon ? "偶" : t.pos + 1))
}
// 睦月在 2 位 → 主目标 2、窗口 {1,2,3}，横跨两个战场：任一边有墙都接得住
check("睦月 3 目标 · 无人偶", skillVsDoll("睦月", 1, null).sort(), [1, 2, 3])
check("睦月 3 目标 · 人偶在 1·2 战场", skillVsDoll("睦月", 1, 0), ["偶"])
check("睦月 3 目标 · 人偶在 3·4 战场（窗口伸到了 3 位）", skillVsDoll("睦月", 1, 3), ["偶"])
// 睦月位于 4 位 → 自动目标窗口 {3,4} 只在 3·4 战场，1·2 那边的墙够不着
check("睦月 3 目标 · 位于 4 位、人偶在 1·2 战场 → 拦不住", skillVsDoll("睦月", 3, 0).sort(), [3, 4])
// 白子在 1 位 → 2 目标，覆盖面就是主目标那个战场
check("白子 2 目标 · 人偶挡 2 位（同战场）", skillVsDoll("白子", 0, 1), ["偶"])
check("白子 2 目标 · 人偶挡 3 位（另一战场）", skillVsDoll("白子", 0, 2).sort(), [1, 2])

console.log("\n=== 10. 伊织 EX：第一发固定索敌，后两发按普攻规则重锁 ===")
/** 伊织在 1 位；kill 是开局就打死的号位，doll 是人偶挡的号位 */
function iori(kill = [], doll = null) {
  const st = setup(["伊织", "日富美", "野宫", "芹香"], FOE, kill.map((k) => [1, k]))
  st.sides[0].cost = 10
  if (doll != null) {
    st.sides[1].summons = [{
      summon: true, id: 40002, side: 1, idx: doll, blockIdx: doll,
      hp: 99999, maxhp: 99999, shield: 0, shieldMax: 0, shieldTurns: 0,
      buffs: [], regens: [], stun: 0, taunt: 0, turns: 6, st: -1, sourceKey: "x", alive: true,
    }]
  }
  const r = run(st, { type: "ex", casts: [{ pos: 0 }] })
  return r.events.filter((e) => e.type === "damage" && e.source.side === 0 && e.source.pos === 0)
    .map((e) => (e.target.summon ? "偶" : e.target.pos + 1))
}
// 后两发不再「不能和上一发相同」：普攻锁谁就锁谁，锁定的人没死就连吃三发
check("自动锁同战场 1 位 → 三发全在 1（对位）", iori(), [1, 1, 1])
check("本战场只剩 1 位 → 后两发继续打它", iori([1]), [1, 1, 1])
check("人偶在本战场 → 从第一发起全被它接走", iori([], 0), ["偶", "偶", "偶"])
check("人偶挡同战场另一路 → 一样从第一发接走", iori([], 1), ["偶", "偶", "偶"])
check("人偶在另一战场 → 本战场还有人时不接", iori([], 2), [1, 1, 1])
check("本战场打空 + 人偶在本战场 → 三发全打人偶", iori([0, 1], 0), ["偶", "偶", "偶"])
check("本战场打空 + 人偶在另一战场 → 越界前先拆墙", iori([0, 1], 2), ["偶", "偶", "偶"])
// 有前排就后两发都落前排身上（敌 1 位放星野，伊织在 1 位）
check("同战场有前排 → 后两发都打前排", (() => {
  const st = setup(["伊织", "日富美", "野宫", "芹香"], TANK1)
  st.sides[0].cost = 10
  const r = run(st, { type: "ex", casts: [{ pos: 0 }] })
  return r.events.filter((e) => e.type === "damage" && e.source?.side === 0 && e.source.pos === 0)
    .map((e) => e.target.pos + 1)
})(), [1, 1, 2])
// 打死锁定的人会自动换目标：这条机制还在
check("对位被打死 → 后面的发数换成同战场另一个", (() => {
  const st = setup(["伊织", "日富美", "野宫", "芹香"], FOE)
  st.sides[0].cost = 10
  st.sides[1].units[0].hp = 1 // 第一发就能打死红1
  const r = run(st, { type: "ex", casts: [{ pos: 0 }] })
  return r.events.filter((e) => e.type === "damage" && e.source?.side === 0 && e.source.pos === 0)
    .map((e) => e.target.pos + 1)
})(), [1, 2, 2])
// 战场图按 action.targets 画线：必须是实际打到的人，不能只写 resolveTargets 给出的第一发
{
  const st = setup(["伊织", "日富美", "野宫", "芹香"], FOE)
  st.sides[0].cost = 10
  st.sides[1].units[0].hp = 1
  const r = run(st, { type: "ex", casts: [{ pos: 0 }] })
  const ev = r.events.find((e) => e.type === "action" && e.action === "ex" && e.source.pos === 0)
  check("换过目标后 action.targets 两个人都在",
    (ev?.targets || []).map((t) => t.pos + 1).sort(), [1, 2])
}

console.log("\n=== 11. 千世场地：固定范围，每跳重扫当前号位 ===")
function chiseCast(kills = [], red = OUT) {
  const st = setup(["千世", "野宫", "野宫", "野宫"], red, kills, { fieldCovers: true })
  st.sides[0].cost = 10
  return run(st, { type: "ex", casts: [{ pos: 0 }] })
}
const zoneHits = (result) => result.events
  .filter((e) => (e.type === "damage" || e.type === "miss") && e.dotIcon === "Zone")
  .map((e) => e.target.summon ? "掩体" : e.target.pos + 1)
const fieldShape = (side) => (side.fields || []).map((f) => [f.lo, f.hi, f.turns, f.tick])
const kill = (st, idx) => {
  const u = st.sides[1].units[idx]
  u.alive = false
  u.hp = 0
  u.dots = []
}

const drop = chiseCast()
check("自动锁定红1 → 地上的圈盖住 1·2 整个战场", fieldShape(drop.state.sides[1]), [[0, 1, 2, 0]])
check("场地伤害存在 field 上，不给施放瞬间的人挂 Zone DoT",
  drop.state.sides[1].units.some((u) => (u.dots || []).some((d) => d.icon === "Zone")), false)
const firstTick = playerTurn(drop.state, { type: "pass" })
check("第一次跳伤害重新扫描：当前 1·2 号位和圈内掩体挨烧", zoneHits(firstTick), [1, 2, "掩体"])
check("另一战场的 3·4 不受伤", zoneHits(firstTick).some((p) => p === 3 || p === 4), false)

const emptyNeighbor = chiseCast([[1, 1]])
check("红2 已死再打红1 → 圈仍盖 1·2（生效范围，不缩成单体）",
  emptyNeighbor.state.sides[1].fields.map((f) => [f.lo, f.hi]), [[0, 1]])
check("红2 已死时场地重扫 → 烧当前红1和圈内掩体",
  zoneHits(playerTurn(emptyNeighbor.state, { type: "pass" })), [1, "掩体"])

const afterKill = chiseCast()
kill(afterKill.state, 0)
const afterRed = playerTurn(afterKill.state, { type: "pass" })
check("场里红1 死后，圈还在原处 1·2", afterRed.state.sides[1].fields.map((f) => [f.lo, f.hi]), [[0, 1]])
check("场里红1 死后，每跳烧当前红2和圈内掩体", zoneHits(afterRed), [2, "掩体"])

const bothDead = chiseCast()
kill(bothDead.state, 0)
kill(bothDead.state, 1)
const afterEmpty = playerTurn(bothDead.state, { type: "pass" })
check("场里两人都死后，圈仍留在 1·2", afterEmpty.state.sides[1].fields.map((f) => [f.lo, f.hi]), [[0, 1]])
check("场里两人都死后，圈内掩体仍作为构造物受伤", zoneHits(afterEmpty), ["掩体"])

// 位移后按对象现在站的格子算：原本在圈内的星野移出，原本在圈外的野宫进入。
const moved = chiseCast([], ["星野", "白子", "野宫", "伊织"])
const movedSide = moved.state.sides[1]
const leaving = movedSide.units[0]
const entering = movedSide.units[2]
movedSide.units[0] = entering; entering.idx = 0
movedSide.units[2] = leaving; leaving.idx = 2
const movedTick = playerTurn(moved.state, { type: "pass" })
const movedNames = zoneHits(movedTick).filter(Number.isInteger)
  .map((pos) => tmplOf(movedTick.state.sides[1].units[pos - 1]).name)
check("移入场地的野宫开始受伤，移出去的星野不再受伤", movedNames, ["野宫", "白子"])
check("EX 不是 debuff：身上不加 buff", drop.state.sides[1].units.every((u) => !(u.buffs || []).length), true)
check("EX 不是 debuff：不发 debuff 事件", drop.events.some((e) => e.type === "debuff"), false)
check("EX 的场地对象标成 Zone，不是灼烧", drop.state.sides[1].fields.every((f) => f.icon === "Zone"), true)

console.log("\n=== 12. 千世圆形普攻依旧被人偶挡 ===")
/** who 站 pos 位普攻，敌方 doll 号位有人偶；返回这一发普攻的命中 */
function autoVsDoll(who, pos, doll) {
  const picks = ["野宫", "野宫", "野宫", "野宫"]
  picks[pos] = who
  const st = setup(picks, FOE)
  if (doll != null) {
    st.sides[1].summons = [{
      summon: true, id: 40002, side: 1, idx: doll, blockIdx: doll,
      hp: 99999, maxhp: 99999, shield: 0, shieldMax: 0, shieldTurns: 0,
      buffs: [], regens: [], dots: [], stun: 0, taunt: 0, turns: 6, st: -1, sourceKey: "x", alive: true,
    }]
  }
  const r = playerTurn(st, { type: "pass" })
  const ev = r.events.find((e) => e.type === "action" && e.action === "normal" && e.source.pos === pos)
  return (ev?.targets || []).map((t) => (t.summon ? "偶" : t.pos + 1))
}
check("千世普攻 · 无人偶 → 圆形盖住同战场 1·2", autoVsDoll("千世", 0, null).sort(), [1, 2])
check("千世普攻 · 人偶挡 1 位（同路）→ 整发被接走", autoVsDoll("千世", 0, 0), ["偶"])
check("千世普攻 · 人偶挡 2 位（同战场另一路）→ 整发被接走", autoVsDoll("千世", 0, 1), ["偶"])
check("千世普攻 · 人偶挡 3 位（另一战场）→ 不拦，仍打 1·2", autoVsDoll("千世", 0, 2).sort(), [1, 2])
// 单体普攻也按战场拦：人偶在 1·2 里，野宫（1 位）的刀就归它接
check("野宫单体普攻 · 人偶挡 2 位（同战场）→ 照样接走", autoVsDoll("野宫", 0, 1), ["偶"])
check("野宫单体普攻 · 人偶挡 3 位（另一战场）→ 不接", autoVsDoll("野宫", 0, 2), [1])

console.log("\n=== 13. EX 只能选择释放者，任何 target 注入都拒绝 ===")
{
  const st = setup(["真纪", "野宫", "野宫", "茜"], ["白子", "星野", "日奈", "爱露"])
  const injected = { type: "ex", casts: [{ pos: 3, target: { scope: "foe", idx: 0 } }] }
  check("引擎校验拒绝 target 字段", validateAction(st, injected), "EX 不能指定目标，只能选择释放者")
  const rejectedTarget = playerTurn(st, injected)
  check("非法点名不产生事件", rejectedTarget.events?.length || 0, 0)
  check("非法点名不改变 Cost", rejectedTarget.state.sides[0].cost, st.sides[0].cost)
  check("解析器拒绝旧式敌方点名", parseAction("真纪ex打白子")?.ok, false)
  check("解析器拒绝旧式友方点名", parseAction("茜ex给野宫")?.ok, false)
  check("裸 EX 仍能解析", parseAction("茜ex"), { ok: true, action: { type: "ex", casts: [{ id: id("茜") }] } })
}

const two = setup(["真纪", "野宫", "野宫", "茜"], ["白子", "星野", "日奈", "爱露"])
const rejected = playerTurn(two, {
  type: "ex",
  casts: [{ pos: 0 }, { pos: 3 }],
})
check("一条指令两个 EX 被拒绝", Boolean(rejected.error), true)
check("放完一个 EX 且还能再放时回合还开着",
  playerTurn(setup(["真纪", "野宫", "野宫", "茜"], ["白子", "星野", "日奈", "爱露"]), {
    type: "ex", casts: [{ pos: 3 }],
  }).state.turnOpen, true)

console.log("\n=== 14. 泉普技是普攻触发，不是每 5 回合必放 ===")
const izumi = ROSTER.find((t) => t.name === "泉")
const akari = ROSTER.find((t) => t.name === "明里")
check("泉 trigger = 普攻 20%、冷却 2 回合", izumi.skill.trigger, { type: "on_auto", chance: 0.2, turns: 2 })
check("明里 trigger = 普攻 10%、冷却 3 回合", akari.skill.trigger, { type: "on_auto", chance: 0.1, turns: 3 })
check("泉描述带普攻概率", /普攻时 20%/.test(describeEffect(izumi.skill)), true)
const izumiTurn = run(setup(["泉", "野宫", "野宫", "野宫"], OUT), { type: "pass" })
const izumiActs = izumiTurn.events.filter((e) => e.type === "action" && e.source.pos === 0)
check("过的时候泉一定先普攻", izumiActs[0]?.action, "normal")
check("泉不会在技能阶段单独放普技", izumiActs[0]?.action === "skill", false)

console.log("\n=== 15. 鹤城回血按自己击杀判定 ===")
const tsurugi = ROSTER.find((t) => t.name === "鹤城")
const hasumi = ROSTER.find((t) => t.name === "莲见")
check("鹤城 trigger = 击杀、冷却 2 回合", tsurugi.skill.trigger, { type: "on_kill", turns: 2 })
check("莲见 trigger = 击杀、无冷却", hasumi.skill.trigger, { type: "on_kill", turns: 0 })
const noKill = run(setup(["鹤城", "野宫", "野宫", "野宫"], OUT), { type: "pass" })
check("没击杀不回血", noKill.events.some((e) => e.type === "heal" && e.source.pos === 0), false)
const killSt = setup(["鹤城", "野宫", "野宫", "野宫"], OUT)
killSt.sides[0].units[0].hp = 800
killSt.sides[0].units[0].skillCd = 0
killSt.sides[1].units[0].hp = 1
const didKill = run(killSt, { type: "pass" })
check("自己击杀掉才回血", didKill.events.some((e) => e.type === "heal" && e.source.pos === 0), true)
check("击杀回血后进冷却", didKill.state.sides[0].units[0].skillCd > 0, true)

console.log("\n=== 16. 人少时同一人可以连放 EX ===")
/** 蓝方只留前 n 个人，茜 2 费站 1 位 */
function leftover(n, cost = 10) {
  const kills = []
  for (let i = n; i < 4; i++) kills.push([0, i])
  const st = setup(["茜", "芹香", "野宫", "伊织"], OUT, kills)
  st.sides[0].cost = cost
  return st
}
{
  // 2 主力 + 2 支援 = 4 人 → 冷却长度 4−3 = 1，茜放完要等本方再放一个才轮回来。
  // **支援永远不死，所以「人少」的门槛整体后移了一格**：真正归零要等到只剩 1 个主力。
  const first = playerTurn(leftover(2), { type: "ex", casts: [{ pos: 0 }] })
  check("剩 2 主力放完茜，回合还开着", first.state.turnOpen, true)
  check("剩 2 主力（+2 支援=4 人）放完茜进冷却", exCastableOf(first.state, 0).includes(0), false)
  check("剩 2 主力时可放的人仍 ≥3", exCastableOf(first.state, 0).length >= 3, true)
  const second = playerTurn(first.state, { type: "ex", casts: [{ pos: 0 }] })
  check("剩 2 主力时连放同一人被拦下", Boolean(second.error), true)
}
{
  // 1 主力 + 2 支援 = 3 人 → 冷却长度归零，同一人可以连放
  const first = playerTurn(leftover(1), { type: "ex", casts: [{ pos: 0 }] })
  check("剩 1 主力放完回合还开着", first.state.turnOpen, true)
  check("剩 1 主力（+2 支援=3 人）放完仍能再放", exCastableOf(first.state, 0).includes(0), true)
  const second = playerTurn(first.state, { type: "ex", casts: [{ pos: 0 }] })
  check("剩 1 主力连放不报错", Boolean(second.error), false)
  check("剩 1 主力第二发仍是茜的 EX",
    second.events.some((e) => e.type === "action" && e.action === "ex" && e.source.pos === 0), true)
}
{
  // 3 主力 + 2 支援 = 5 人 → 冷却长度 5−3 = 2，要 1→2→3 之后 1 才解锁
  const first = playerTurn(leftover(3), { type: "ex", casts: [{ pos: 0 }] })
  check("剩 3 主力放完 1 不能立刻再放 1", exCastableOf(first.state, 0).includes(0), false)
  const second = playerTurn(first.state, { type: "ex", casts: [{ pos: 1 }] })
  check("剩 3 主力 1→2 之后 1 还锁着（冷却 2）", exCastableOf(second.state, 0).includes(0), false)
  const third = playerTurn(second.state, { type: "ex", casts: [{ pos: 2 }] })
  check("剩 3 主力 1→2→3 之后 1 解锁", exCastableOf(third.state, 0).includes(0), true)
  const fourth = playerTurn(third.state, { type: "ex", casts: [{ pos: 0 }] })
  check("剩 3 主力 1→2→3→1 不报错", Boolean(fourth.error), false)
  check("剩 3 主力第四发仍是 1 的 EX",
    fourth.events.some((e) => e.type === "action" && e.action === "ex" && e.source.pos === 0), true)
}
{
  const first = playerTurn(leftover(4), { type: "ex", casts: [{ pos: 0 }] })
  check("满编放完茜不能立刻再放", exCastableOf(first.state, 0).includes(0), false)
  check("满编同一人连放被冷却拦住",
    /冷却/.test(validateAction(first.state, { type: "ex", casts: [{ pos: 0 }] }) || ""), true)
}
{
  // 4→3：蓝方放过茜，红方打死伊织，交回合时就必须清冷却，不能等蓝方再出招
  let st = leftover(4)
  const used = playerTurn(st, { type: "ex", casts: [{ pos: 0 }] })
  st = used.state.turnOpen ? playerTurn(used.state, { type: "pass" }).state : used.state
  st.sides[0].units[3].alive = false
  st.sides[0].units[3].hp = 0
  const handed = playerTurn(st, { type: "pass" })
  const blue = handed.state.sides[0]
  check("4→3 交回合后 lastAlive 已更新", blue.lastAlive, 3)
  check("4→3 交回合后上回合的茜 wait 为 0", exWaitOf(blue, blue.units[0]), 0)
  check("4→3 交回合后茜在可放名单", exCastableOf(handed.state, 0).includes(0), true)
  const reuse = playerTurn(handed.state, { type: "ex", casts: [{ pos: 0 }] })
  check("4→3 下回合能再用上回合放过的茜", Boolean(reuse.error), false)
  check("4→3 再用茜确实结算了 EX",
    reuse.events.some((e) => e.type === "action" && e.action === "ex" && e.source.pos === 0), true)
}

console.log("\n=== 17. 瞬的强化形态：索敌改成「攻击力最高」，只有嘲讽拉得走 ===")
/**
 * 瞬站蓝 1 位，敌方 [茜(中) 星野(前) 鹤城(471) 野宫(321)]：
 * 常规对线会打同战场的前排（红2），强化后要越过战场分割去点全场最高攻的红3。
 */
const SHUN_FOE = ["茜", "星野", "鹤城", "野宫"]
/** 放完 EX 再空转到下一个蓝方回合，返回瞬那一发普攻打到谁 */
function shunShot(mutate) {
  const st = setup(["瞬", "野宫", "野宫", "野宫"], SHUN_FOE)
  const cast = run(st, { type: "ex", casts: [{ pos: 0 }] }).state
  mutate?.(cast)
  const mine = run(run(cast, { type: "pass" }).state, { type: "pass" })
  const ev = mine.events.find((e) => e.type === "action" && e.action === "normal" && e.source.pos === 0)
  return (ev?.targets || []).map((t) => (t.summon ? "偶" : t.pos + 1))
}
const doll = (idx, taunt = 0) => (st) => {
  st.sides[1].summons = [{
    summon: true, id: 40002, side: 1, idx, blockIdx: idx,
    hp: 99999, maxhp: 99999, shield: 0, shieldMax: 0, shieldTurns: 0,
    buffs: [], regens: [], dots: [], stun: 0, taunt, turns: 6, st: -1, sourceKey: "x", alive: true,
  }]
}
{
  const plain = playerTurn(setup(["瞬", "野宫", "野宫", "野宫"], SHUN_FOE), { type: "pass" })
  const ev = plain.events.find((e) => e.type === "action" && e.action === "normal" && e.source.pos === 0)
  check("未强化 → 照常打同战场的前排（红2）", (ev?.targets || []).map((t) => t.pos + 1), [2])
}
check("强化后 → 越过战场分割和前排，打全场最高攻的红3", shunShot(), [3])
check("红3 被削到最低攻 → 改打新的最高攻（红4）", shunShot((st) => {
  st.sides[1].units[2].buffs.push({ stat: "atk", value: -0.9, turns: 9, effectKind: "debuff", channel: 603 })
}), [4])
check("敌方嘲讽 → 拉回最低攻的红1（嘲讽是唯一能改索敌的）", shunShot((st) => {
  st.sides[1].units[0].taunt = 3
  st.sides[1].units[0].tauntSt = -1
}), [1])
check("人偶挡她那一路 → 拦不住，仍打红3", shunShot(doll(0)), [3])
check("人偶还在嘲讽期 → 接得住（Provoke 优先级更高）", shunShot(doll(0, 2)), ["偶"])
// 强化只在自己身上，别把索敌规则漏给队友
check("队友不受影响，照常打同战场的前排", (() => {
  const st = setup(["瞬", "野宫", "野宫", "野宫"], SHUN_FOE)
  const cast = run(st, { type: "ex", casts: [{ pos: 0 }] }).state
  const mine = run(run(cast, { type: "pass" }).state, { type: "pass" })
  const ev = mine.events.find((e) => e.type === "action" && e.action === "normal" && e.source.pos === 1)
  return (ev?.targets || []).map((t) => t.pos + 1)
})(), [2])

console.log("\n=== 18. 瞬的强化存续 6 轮 / 开局回费在建局时就落地 ===")
{
  const shun = ROSTER.find((t) => t.name === "瞬")
  check("普技是「战斗开始时」触发，不进技能阶段", shun.skill.trigger, { type: "battle_start", maxUses: 1 })
  check("普技的效果是自身 Cost +2（原数据 Effects 为空，从描述里抠的）",
    shun.skill.effects, [{ type: "cost", scope: "self", value: 2 }])
  const st = createBattle(
    { uid: "a", name: "蓝", picks: ["瞬", "野宫", "野宫", "野宫"].map(id) },
    { uid: "b", name: "红", picks: SHUN_FOE.map(id) }, { seed: 11, first: 0 }
  )
  check("后手开局补偿固定为 2 Cost", CFG.SECOND_BONUS, 2)
  check("先手带瞬 → 开局 Cost 0+2", st.sides[0].cost, 2)
  check("对面没瞬 → 只有后手补偿", st.sides[1].cost, CFG.SECOND_BONUS)
  check("开局就算用掉一次，不会在技能阶段再放", st.sides[0].units[0].skillUses, 1)
  let cur = st
  for (let i = 0; i < 6; i++) cur = playerTurn(cur, { type: "pass" }).state
  check("跑满 3 轮后仍然只用过 1 次", cur.sides[0].units[0].skillUses, 1)

  // 6 轮存续。施放那轮她忙着放 EX 没普攻，所以那一轮**不扣**（startNext，第三类时长口径）——
  // 30 秒换来的是 6 发强化普攻，不是 5 发
  let r = run(setup(["瞬", "野宫", "野宫", "野宫"], SHUN_FOE), { type: "ex", casts: [{ pos: 0 }] })
  check("施放回合她不普攻",
    r.events.some((e) => e.type === "action" && e.action === "normal" && e.source.pos === 0), false)
  check("施放回合不扣：从下个己方回合才开始跳", r.state.sides[0].units[0].charge.turns, 6)
  let boosted = 0
  for (let i = 0; i < 8; i++) {
    r = run(r.state, { type: "pass" })
    r = run(r.state, { type: "pass" })
    boosted += r.log.filter((l) => /瞬 强化普攻/.test(l)).length
  }
  check("累计打出 6 发强化普攻", boosted, 6)
  check("到期后 charge 清干净", r.state.sides[0].units[0].charge, null)
}

console.log("\n=== 19. 鹤城的换弹强化仍然按发数走 ===")
{
  const opened = setup(["鹤城", "野宫", "野宫", "野宫"], SHUN_FOE)
  opened.sides[0].cost = 10
  const justEx = playerTurn(opened, { type: "ex", casts: [{ pos: 0 }] })
  check("EX 只上形态，不带普攻", justEx.log.filter((l) => /鹤城 强化普攻/.test(l)).length, 0)
  check("回合还开着，等「过」再普攻", justEx.state.turnOpen, true)
  check("EX 之后 charge 还是 2 发", justEx.state.sides[0].units[0].charge?.shots, 2)
  const afterPass = playerTurn(justEx.state, { type: "pass" })
  check("过了之后才打出第 1 发强化普攻",
    afterPass.log.filter((l) => /鹤城 强化普攻/.test(l)).length, 1)
  check("按发数存续，并保留强化普攻自己的 Block", afterPass.state.sides[0].units[0].charge,
    { hits: [69.355, 69.355], hitBlocks: [true, true], block: true, count: 2, shots: 1 })
  let r = afterPass
  r = run(run(r.state, { type: "pass" }).state, { type: "pass" })
  check("下个己方回合打出第 2 发", r.log.filter((l) => /鹤城 强化普攻/.test(l)).length, 1)
  check("两发打完就没了", r.state.sides[0].units[0].charge, null)
  // 强化普攻的倍率与分段照抄 Skills.Normal.FormChange，不是「基础普攻 × 描述里的倍率」
  const ex = ROSTER.find((t) => t.name === "鹤城").ex.effects.find((e) => e.type === "charge")
  check("鹤城强化普攻合计 138.71% 分 2 段", [ex.hits.reduce((a, b) => a + b, 0).toFixed(2), ex.hits.length], ["138.71", 2])
  check("鹤城不带索敌变更", ex.targeting ?? null, null)

  const serika = setup(["芹香", "野宫", "野宫", "野宫"], SHUN_FOE)
  serika.sides[0].cost = 10
  const sEx = playerTurn(serika, { type: "ex", casts: [{ pos: 0 }] })
  check("芹香 EX 也不带普攻", sEx.events.some((e) => e.type === "action" && e.action === "normal" && e.source.pos === 0), false)
  const sPass = playerTurn(sEx.state, { type: "pass" })
  check("芹香过了之后才普攻", sPass.events.some((e) => e.type === "action" && e.action === "normal" && e.source.pos === 0), true)
}

console.log("\n=== 20. 纯子：残血触发不死 + EX 减费 ===")
const J = (st) => st.sides[0].units[0]
/**
 * 纯子站蓝 1 位、压到 15% 血，跑一个蓝方回合触发她的普通技能。
 *
 * `acc` 增益是给红方灌的：纯子闪避 794 是全池最高，而红方的茜 / 野宫命中只有 101 / 99，
 * 命中率不到五成 —— 不钉死就测不到「挨了致命伤」，断言会随种子飘。
 */
function junko(pin = true) {
  const st = setup(["纯子", "野宫", "野宫", "野宫"], SHUN_FOE)
  J(st).hp = Math.floor(J(st).maxhp * 0.15)
  if (pin) for (const x of st.sides[1].units) x.buffs.push({ stat: "acc", value: 8, turns: 9999, effectKind: "buff", channel: 5 })
  return run(st, { type: "pass" }).state
}
/** 空转到蓝方回合 */
const toBlue = (st) => {
  let cur = st
  while (cur.phase === "command" && cur.activeSide !== 0) cur = run(cur, { type: "pass" }).state
  return cur
}
{
  const t = ROSTER.find((x) => x.name === "纯子")
  check("普技是「生命≤20%、每场 1 次」触发", t.skill.trigger, { type: "hp_below", value: 0.2, maxUses: 1 })
  check("普技给 EX 减 4 费、管 2 次（CostChange 是打折不是回费）",
    t.skill.effects.find((e) => e.type === "ex_discount"), { type: "ex_discount", scope: "self", mode: "flat", value: 4, uses: 2 })
  check("普技给 3 回合不死（12.8 秒，只写在描述里）",
    t.skill.effects.find((e) => e.type === "immortal"), { type: "immortal", scope: "self", turns: 3 })
  check("EX 带自伤：当前生命 25.7%（也只写在描述里）",
    t.ex.effects.find((e) => e.type === "hp_cost"), { type: "hp_cost", scope: "self", rate: 0.257 })

  const st = junko()
  check("触发后进入不死 3 回合", J(st).immortal, 3)
  check("触发后 EX 从 5 费变 1 费", [tmplOf(J(st)).ex.cost, exCostOf(J(st))], [5, 1])
  check("每场只触发 1 次", J(st).skillUses, 1)
}

console.log("\n=== 21. 不死：血量掉不到 0，撑满 3 个敌方回合 ===")
{
  // 致命伤：挨完仍剩 1 血
  let cur = toBlue(junko())
  J(cur).hp = 30
  cur = run(cur, { type: "pass" }).state
  const red = run(cur, { type: "pass" })
  check("挨了致命伤仍剩 1 血且没倒下", [Math.round(J(red.state).hp), J(red.state).alive], [1, true])
  check("战报里说清了是不死撑住的", red.log.some((l) => /靠不死撑住/.test(l)), true)

  // 时长按**敌方**回合跳（跟护盾同口径）：施放回合不扣，之后每个红方回合 −1
  let st = junko()
  const seen = []
  for (let i = 0; i < 3; i++) {
    if (J(st).alive) J(st).hp = 30 // 每轮压回必死血量
    const wasRed = st.activeSide === 1
    st = run(st, { type: "pass" }).state
    if (wasRed) seen.push(`${J(st).immortal}/${J(st).alive ? "活" : "死"}`)
    if (!J(st).alive) break
    st = run(st, { type: "pass" }).state // 蓝方回合，不该跳时长
  }
  check("三个红方回合逐格跳，期间一直活着", seen, ["2/活", "1/活", "0/活"])
  J(st).hp = 30
  const dead = run(st, { type: "pass" }).state // 第 4 个红方回合，不死已到期
  check("不死到期后照常会死", dead.sides[0].units[0].alive, false)

  // 灼烧/场地走的是 endTurn 里另一条掉血路径，也要拦住
  let burn = toBlue(junko())
  J(burn).hp = 20
  J(burn).dots.push({ icon: "Burn", amount: 9999, turns: 3, period: 1, tick: 0, attackType: "神秘", st: -1 })
  const burned = run(burn, { type: "pass" }).state
  check("9999 灼烧也只把她打到 1 血", [Math.round(J(burned).hp), J(burned).alive], [1, true])
}

console.log("\n=== 22. EX 减费：折后价要一路贯穿到校验和扣费 ===")
{
  let cur = toBlue(junko(false))
  const rows = []
  for (let i = 0; i < 3; i++) {
    cur = toBlue(cur)
    J(cur).hp = J(cur).maxhp // 别被自伤耗死，这一组只测费用
    cur.sides[0].cost = 10
    for (const x of cur.sides[0].units) x.exCastNo = 0
    cur.sides[0].exCasts = 0
    const want = exCostOf(J(cur))
    const r = playerTurn(cur, { type: "ex", casts: [{ pos: 0 }] })
    rows.push([want, r.spent])
    cur = r.state
  }
  check("前两发 1 费、第三发回到原价 5，且实扣与卡面一致", rows, [[1, 1], [1, 1], [5, 5]])

  // 折后价必须同时被「能不能放」和「够不够 Cost」两条路认
  const poor = toBlue(junko(false))
  poor.sides[0].cost = 1
  check("只剩 1 Cost 时 5 费的 EX 也放得出", validateAction(poor, { type: "ex", casts: [{ pos: 0 }] }), null)
  check("只剩 1 Cost 时她在可放名单里", exCastableOf(poor, 0).includes(0), true)
  const broke = toBlue(junko(false))
  broke.sides[0].cost = 0
  check("0 Cost 就放不出，报的是折后价 1", /要 1 点/.test(validateAction(broke, { type: "ex", casts: [{ pos: 0 }] }) || ""), true)
}

console.log("\n=== 23. EX 自伤：失去当前生命的 25.7%，但打不死自己 ===")
{
  const st = setup(["纯子", "野宫", "野宫", "野宫"], OUT)
  const before = J(st).hp
  const r = run(st, { type: "ex", casts: [{ pos: 0 }] })
  check("按当前生命扣 25.7%", Math.round(before - J(r.state).hp), Math.round(before * 0.257))
  const ev = r.events.find((e) => e.type === "damage" && !e.source)
  check("自伤事件不带施法者（战场图不画连线），走持续伤害那套配色",
    ev && [ev.source, ev.dot, ev.attackType], [null, true, "自伤"])
  check("直线 3 目标以自动主目标为中心；站在边缘会少覆盖一格",
    r.events.find((e) => e.type === "action" && e.action === "ex").targets.map((x) => x.pos + 1), [1, 2])

  const low = setup(["纯子", "野宫", "野宫", "野宫"], SHUN_FOE)
  J(low).hp = 3
  const r2 = run(low, { type: "ex", casts: [{ pos: 0 }] })
  check("3 血放 EX 也死不了（按比例扣，永远剩 74.3%）", [Math.round(J(r2.state).hp), J(r2.state).alive], [2, true])

  // 放 EX 的那个回合她在 turnEx 里，③-a 整个跳过 —— 自伤把她打到 20% 以下也要等下回合
  const edge = setup(["纯子", "野宫", "野宫", "野宫"], SHUN_FOE)
  J(edge).hp = Math.floor(J(edge).maxhp * 0.25)
  const cast = run(edge, { type: "ex", casts: [{ pos: 0 }] })
  check("EX 自伤到 20% 以下，当回合不触发不死", J(cast.state).immortal, 0)
  const nextTurn = run(run(cast.state, { type: "pass" }).state, { type: "pass" })
  check("下一个己方回合才触发", [J(nextTurn.state).immortal, exCostOf(J(nextTurn.state))], [3, 1])
}

console.log("\n=== 24. 椿的嘲讽：无视一切，且同一方只留最后放的那个 ===")
/**
 * 红方放完 `order` 里这几个 EX 再收回合，返回随后蓝方四人普攻各打到谁。
 * 红队默认 [椿, 日富美, 野宫, 野宫]：两个嘲讽源（椿的 Provoke、人偶的入场 Provoke）。
 */
function redThenBlue(order, red = ["椿", "日富美", "野宫", "野宫"], blue = OUT) {
  const st = setup(blue, red)
  st.sides[1].cost = 10
  let cur = run(st, { type: "pass" }).state // 蓝方过，轮到红方
  for (const pos of order) {
    cur.sides[1].cost = 10
    for (const x of cur.sides[1].units) x.exCastNo = 0 // 清冷却，方便连放
    cur.sides[1].exCasts = 0
    const r = playerTurn(cur, { type: "ex", casts: [{ pos }] })
    if (r.error) throw new Error(`红 ${pos + 1} 位放不出 EX：${r.error}`)
    cur = r.state
  }
  while (cur.turnOpen) cur = playerTurn(cur, { type: "pass" }).state
  const r = playerTurn(cur, { type: "pass" }) // 蓝方回合
  return r.events
    .filter((e) => e.type === "action" && e.action === "normal" && e.source.side === 0)
    .map((e) => (e.targets || []).map((t) => (t.summon ? "偶" : t.pos + 1)).join(""))
}
{
  const t = ROSTER.find((x) => x.name === "椿")
  check("椿的 EX 带自身嘲讽 1 回合（Provoke 从 CrowdControl 里分出来的）",
    t.ex.effects.find((e) => e.type === "taunt"), { type: "taunt", kind: "provoke", scope: "self", turns: 1 })
  check("Provoke 不能变成眩晕", t.ex.effects.some((e) => e.type === "cc"), false)
  check("描述说清是「敌方全体只打自己」", /敌方全体只打自己/.test(describeEffect(t.ex)), true)
  check("描述也写了封 EX", /放不出 EX/.test(describeEffect(t.ex)), true)

  check("只放椿 → 蓝方四人全去打她（跨战场、无视坦克）", redThenBlue([0]), ["1", "1", "1", "1"])
  check("只放日富美 → 全去打人偶", redThenBlue([1]), ["偶", "偶", "偶", "偶"])
  // 后放的覆盖先放的：两个嘲讽目标不共存
  check("先椿后人偶 → 打人偶", redThenBlue([0, 1]), ["偶", "偶", "偶", "偶"])
  check("先人偶后椿 → 打椿", redThenBlue([1, 0]), ["1", "1", "1", "1"])
  // 覆盖是真的清掉，不是排优先级
  {
    const st = setup(OUT, ["椿", "日富美", "野宫", "野宫"])
    st.sides[1].cost = 10
    let cur = run(st, { type: "pass" }).state
    cur = playerTurn(cur, { type: "ex", casts: [{ pos: 1 }] }).state // 人偶
    cur = playerTurn(cur, { type: "ex", casts: [{ pos: 0 }] }).state // 椿顶掉它
    check("椿接手之后人偶身上的嘲讽已清零",
      cur.sides[1].summons.find((s) => !s.cover)?.taunt, 0)
    check("同一方同时只有一个嘲讽目标",
      cur.sides[1].units.filter((u) => u.taunt > 0).length + cur.sides[1].summons.filter((s) => s.taunt > 0).length, 1)
  }

  // 嘲讽压过挡刀：人偶还杵在 1 号位，但椿后放，刀就该落在椿身上
  {
    const st = setup(OUT, ["椿", "日富美", "野宫", "野宫"])
    st.sides[1].cost = 10
    let cur = run(st, { type: "pass" }).state
    cur = playerTurn(cur, { type: "ex", casts: [{ pos: 1 }] }).state
    cur = playerTurn(cur, { type: "ex", casts: [{ pos: 0 }] }).state
    while (cur.turnOpen) cur = playerTurn(cur, { type: "pass" }).state
    const r = playerTurn(cur, { type: "pass" })
    const hits = r.events.filter((e) => e.type === "action" && e.action === "normal" && e.source.side === 0)
      .map((e) => (e.targets || []).map((x) => (x.summon ? "偶" : x.pos + 1)).join(""))
    check("嘲讽压过人偶挡刀（人偶还在场，刀全落椿身上）", hits, ["1", "1", "1", "1"])
  }

  // 嘲讽的状态标记落在**被拉走的人**身上，不是放嘲讽的那个人身上（原作就是这么画的）
  {
    const st = setup(OUT, ["椿", "野宫", "野宫", "野宫"])
    st.sides[1].cost = 10
    let cur = run(st, { type: "pass" }).state
    cur = playerTurn(cur, { type: "ex", casts: [{ pos: 0 }] }).state
    check("蓝方四人全被标成「被嘲讽」",
      cur.sides[0].units.map((u) => Boolean(provokedBy(cur, u))), [true, true, true, true])
    check("椿自己不带被嘲讽的标", Boolean(provokedBy(cur, cur.sides[1].units[0])), false)
    check("椿身上的 kind 是 provoke，不是集火", cur.sides[1].units[0].tauntKind, "provoke")
    check("只放椿时没人挂集火标",
      [...cur.sides[0].units, ...cur.sides[1].units].some((u) => focusedOf(u)), false)
  }

  // 瞬的强化索敌也让路 —— 第 17 组测的是同一条规则，这里换成椿的真嘲讽再钉一次
  {
    const st = setup(["瞬", "野宫", "野宫", "野宫"], ["野宫", "野宫", "椿", "鹤城"])
    st.sides[0].cost = 10
    let cur = run(st, { type: "ex", casts: [{ pos: 0 }] }).state // 蓝：瞬进强化形态
    cur.sides[1].cost = 10
    cur = playerTurn(cur, { type: "ex", casts: [{ pos: 2 }] }).state // 红：椿嘲讽
    while (cur.turnOpen) cur = playerTurn(cur, { type: "pass" }).state
    const r = playerTurn(cur, { type: "pass" })
    const ev = r.events.find((e) => e.type === "action" && e.action === "normal" && e.source.pos === 0)
    check("嘲讽把瞬从「打最高攻的鹤城」拉回椿", (ev?.targets || []).map((x) => x.pos + 1), [3])
  }
}

console.log("\n=== 25. 时长按技能等级取，不是 Effect.Duration ===")
{
  // Effect.Duration 存的是满级那一档：优香的护盾按级表是 15/15/20/20/25 秒，
  // 而 Duration 固定 25000。SKILL_LV=0 该取 15 秒 = 3 轮，不是 5 轮。
  const yuuka = ROSTER.find((x) => x.name === "优香")
  check("优香的护盾取 Lv1 的 15 秒 = 3 回合",
    yuuka.ex.effects.find((e) => e.type === "shield")?.turns, 3)
  // 描述里写死秒数的不受影响
  const shun = ROSTER.find((x) => x.name === "瞬")
  check("瞬的「持续30秒」照旧 6 回合",
    shun.ex.effects.find((e) => e.stat === "crit")?.turns, 6)
  const haruka = ROSTER.find((x) => x.name === "春香")
  check("春香普技的 20 秒防御增益 = 4 回合",
    haruka.skill.effects.find((e) => e.stat === "dfs")?.turns, 4)
}

console.log("\n=== 26. 状态时长：N 回合 = 它真正起作用的 N 个攻击窗口 ===")
/**
 * 判据是「这一层在谁的攻击窗口里生效」：防御向看承受者**挨打**的回合，进攻向看它**出手**的回合。
 * 施放那一回合算不算窗口，四种组合的答案不一样，全靠 tickSide 自己对齐 ——
 * 曾经 `dfs` 按施加者分 side 且强制计入施放回合，自身防御增益就白扣一格（椿 6 回合只挡 5 次）。
 */
function windowsOf(blue, apply, watch, wantSide) {
  const st = setup(blue, OUT)
  st.sides[0].cost = 10
  apply(st)
  const [ws, wi, stat] = watch
  const buf = (s) => s.sides[ws].units[wi].buffs.find((b) => b.stat === stat)
  let cur = st, n = 0
  for (let i = 0; i < 24 && cur.phase === "command"; i++) {
    const acting = cur.activeSide
    const r = run(cur, { type: "pass" })
    // 普通技能在 ③-a 才挂上，所以首轮要看回合末
    if (acting === wantSide && (buf(cur) || (i === 0 && buf(r.state)))) n++
    cur = r.state
    if (!buf(cur)) break
  }
  return n
}
// EX 只放不收回合，让第一轮就是施放那一回合；普技靠清冷却在 ③-a 放出来
const byEx = (pos) => (st) => Object.assign(st, playerTurn(st, { type: "ex", casts: [{ pos }] }).state)
const bySkill = (pos) => (st) => { st.sides[0].units[pos].skillCd = 0 }
const N = ["野宫", "野宫", "野宫", "野宫"]
const put = (who) => [who, "野宫", "野宫", "野宫"]

check("自身防御增益（椿 6 回合）管 6 个敌方窗口",
  windowsOf(put("椿"), byEx(0), [0, 0, "dfs"], 1), 6)
check("自身防御增益（春香 4 回合）管 4 个",
  windowsOf(put("春香"), bySkill(0), [0, 0, "dfs"], 1), 4)
check("自身闪避增益（优香 2 回合）管 2 个",
  windowsOf(put("优香"), bySkill(0), [0, 0, "dodge"], 1), 2)
check("自身攻击增益（野宫 4 回合）管 4 个己方窗口，施放回合就算第 1 个",
  windowsOf(N, bySkill(0), [0, 0, "atk"], 0), 4)
check("同一技能里的命中增益也是 4 个，不能比攻击多管一轮",
  windowsOf(N, bySkill(0), [0, 0, "acc"], 0), 4)
check("给敌人的减防（茜 6 回合）管 6 个己方窗口",
  windowsOf(put("茜"), byEx(0), [1, 0, "dfs"], 0), 6)
check("给敌人的减命中（日富美 6 回合）管 6 个敌方出手窗口",
  windowsOf(put("日富美"), bySkill(0), [1, 0, "acc"], 1), 6)

console.log("\n=== 27. 嘲讽 / 恐惧封 EX：全员被封也要等人发「过」===")
{
  // 红方放完嘲讽或恐惧、交回合之后，蓝方进 command 阶段。
  // 这一步必须停在蓝方面前：不能因为可放名单是空的就替他们把回合过掉。
  const handoff = (red, pos) => {
    const st = setup(OUT, red)
    st.sides[1].cost = 10
    let cur = run(st, { type: "pass" }).state
    cur.sides[1].cost = 10
    cur = playerTurn(cur, { type: "ex", casts: [{ pos }] }).state
    while (cur.turnOpen) cur = playerTurn(cur, { type: "pass" }).state
    return cur
  }

  const taunted = handoff(["椿", "野宫", "野宫", "野宫"], 0)
  check("椿交回合后轮到蓝方，回合还没开", [taunted.activeSide, taunted.turnOpen, taunted.phase], [0, false, "command"])
  check("蓝方四人都被嘲讽锁住", taunted.sides[0].units.map((u) => exLockedOf(taunted, u)),
    ["嘲讽", "嘲讽", "嘲讽", "嘲讽"])
  // **支援免疫嘲讽**：它们不站在场上，场地性的 Provoke 拉不到。
  // 所以四个主力全被拉走的那一轮，5、6 号仍然出得了手 —— 名单不空，
  // 指令层也就不会替玩家把回合自动过掉（那样等于吞掉支援的行动）。
  check("四个主力被封，支援仍在可放名单里", exCastableOf(taunted, 0), [4, 5])
  check("有支援时就不算全员被封", exSealedOf(taunted, 0), false)
  check("支援自己没被嘲讽", taunted.sides[0].supports.map((u) => exLockedOf(taunted, u)), [null, null])
  check("选择该角色释放 EX 会被拦", validateAction(taunted, { type: "ex", casts: [{ pos: 0 }] }),
    "野宫 被嘲讽，放不出 EX")
  check("「过」仍然合法", validateAction(taunted, { type: "pass" }), null)

  const afterPass = playerTurn(taunted, { type: "pass" })
  check("被嘲讽的那一轮普通技能和普攻照跑（不进 stun）",
    afterPass.events.some((e) => e.type === "action" && e.action === "normal" && e.source.side === 0), true)
  check("发「过」才交回合", [afterPass.state.activeSide, afterPass.state.turnOpen], [1, false])

  const doll = handoff(["日富美", "野宫", "野宫", "野宫"], 0)
  check("人偶入场嘲讽封住四个主力", doll.sides[0].units.map((u) => exLockedOf(doll, u)),
    ["嘲讽", "嘲讽", "嘲讽", "嘲讽"])
  check("人偶嘲讽下支援仍能放", exCastableOf(doll, 0), [4, 5])
  check("人偶嘲讽下也放不出", validateAction(doll, { type: "ex", casts: [{ pos: 2 }] }),
    "野宫 被嘲讽，放不出 EX")

  const feared = handoff(["佳代子", "野宫", "野宫", "野宫"], 0)
  check("佳代子 EX 恐惧也封 EX", feared.sides[0].units.map((u) => exLockedOf(feared, u)),
    ["恐惧", "恐惧", "恐惧", "恐惧"])
  // 恐惧同理：`u.stun` 只可能挂在场上的人身上，支援根本不在被选中的名单里
  check("恐惧下支援仍能放", exCastableOf(feared, 0), [4, 5])
  check("恐惧下也不算全员被封", exSealedOf(feared, 0), false)
  check("恐惧下选择该角色释放 EX 会被拦", validateAction(feared, { type: "ex", casts: [{ pos: 0 }] }),
    "野宫 被恐惧，放不出 EX")
  const fearedPass = playerTurn(feared, { type: "pass" })
  check("恐惧那一轮普攻被跳过",
    fearedPass.events.some((e) => e.type === "action" && e.action === "normal" && e.source.side === 0), false)
}

console.log("\n=== 28. 攻速只乘普攻，不乘 EX / 普通技能 ===")
{
  const asuna = ROSTER.find((t) => t.name === "明日奈")
  check("明日奈 EX 闪避留 1 回合",
    asuna.ex.effects.find((e) => e.stat === "dodge"),
    { type: "buff", scope: "self", stat: "dodge", value: 0.4341, turns: 1, channel: 7 })
  check("明日奈 EX 攻速 30 秒 = 6 回合（官方写了秒数）",
    asuna.ex.effects.find((e) => e.stat === "aa"), { type: "buff", scope: "self", stat: "aa", value: 0.302, turns: 6, channel: 24 })
  check("明日奈普技按目标血量改倍率：满血 ×1、空血 ×1.5",
    asuna.skill.hpRate, { lo: 0, hi: 1, atLo: 1.5, atHi: 1 })
  const asunaDmg = (hpFrac) => {
    const st = setup(["明日奈", "野宫", "野宫", "野宫"], ["野宫", "野宫", "野宫", "野宫"])
    st.sides[0].units[0].skillCd = 0
    const t = st.sides[1].units[0]
    t.maxhp = 9e6
    t.hp = Math.max(1, Math.round(t.maxhp * hpFrac))
    return run(st, { type: "pass" }).events
      .filter((e) => e.type === "damage" && !e.dot && e.source?.side === 0 && e.source?.pos === 0)
      .reduce((s, e) => s + (e.totalAmount ?? e.amount), 0)
  }
  const full = asunaDmg(1)
  const empty = asunaDmg(0)
  check("满血吃基础倍率", full > 0, true)
  check("空血约 1.5 倍满血", Math.round((empty / full) * 100) / 100, 1.5)
  check("卡面写清越残越高", /越残/.test(describeEffect(asuna.skill)), true)
  const shun = ROSTER.find((t) => t.name === "瞬")
  const tsurugi = ROSTER.find((t) => t.name === "鹤城")
  check("瞬的攻速减益是 aa，不是 dmg_deal",
    shun.ex.effects.find((e) => e.type === "buff" && e.stat === "aa")?.value, -0.1882)
  check("鹤城击杀攻速是 aa",
    tsurugi.skill.effects.find((e) => e.type === "buff" && e.stat === "aa")?.value, 0.2559)
  check("描述写攻速，不写成造成伤害", /攻速/.test(describeEffect(shun.ex)), true)

  const dmgOf = (events) => events
    .filter((e) => e.type === "damage" && !e.dot && e.source?.side === 0 && e.source?.pos === 0)
    .reduce((s, e) => s + (e.totalAmount ?? e.amount), 0)
  const inject = (st, value) => {
    st.sides[0].units[0].buffs.push({
      stat: "aa", value, turns: 9, st: -1,
      effectKind: "buff", sourceKey: "test:aa", srcSide: 0, srcPos: 0,
    })
    return st
  }
  const pair = (picks, action) => {
    const a = setup(picks, OUT)
    const b = inject(setup(picks, OUT), 1)
    return [dmgOf(playerTurn(a, action).events, action.type), dmgOf(playerTurn(b, action).events, action.type)]
  }
  const [ex0, ex1] = pair(["茜", "野宫", "野宫", "野宫"], { type: "ex", casts: [{ pos: 0 }] })
  check("茜的 EX 不吃攻速层（伤害不变）", [ex0, ex1], [ex0, ex0])
  const [aa0, aa1] = pair(["野宫", "野宫", "野宫", "野宫"], { type: "pass" })
  // 分段各自四舍五入，翻倍后可能差 1；鹤城那条已经按 ≤2 量
  check("普攻吃攻速层（+100% 正好翻倍）", Math.abs(aa1 - aa0 * 2) <= 2, true)

  // 鹤城 EX 本身没伤害，普攻在过了之后的 ③-b，必须吃攻速
  const pairRun = (picks, action) => {
    const a = setup(picks, OUT)
    const b = inject(setup(picks, OUT), 1)
    return [dmgOf(run(a, action).events), dmgOf(run(b, action).events)]
  }
  const [t0, t1] = pairRun(["鹤城", "野宫", "野宫", "野宫"], { type: "ex", casts: [{ pos: 0 }] })
  check("鹤城 ③-b 的强化普攻吃攻速层", Math.abs(t1 - t0 * 2) <= 2, true)
}

console.log("\n=== 29. 柚子：技能自带的「攻击力最高」索敌 ===")
{
  // 红方把全场最高攻放在**另一个战场的后排**（晴奈 457 / 后），对线锁定永远选不到它；
  // 同战场是两个茜（120 / 中）。选中晴奈就说明 skill.pick 生效了。
  const skillTargets = (st) => {
    st.sides[0].units[0].skillCd = 0
    const r = run(st, { type: "pass" })
    const ev = r.events.find((e) =>
      e.type === "action" && e.action === "skill" && e.source?.side === 0 && e.source?.pos === 0)
    return (ev?.targets || []).map((t) => t.pos + 1)
  }
  check("不带 pick 的技能仍走对线（同战场的 1 位）",
    skillTargets(setup(["梓", "茜", "茜", "茜"], ["茜", "茜", "茜", "晴奈"])), [1])
  check("柚子的普技越过战场分割，打全场攻击力最高的 4 位",
    skillTargets(setup(["柚子", "茜", "茜", "茜"], ["茜", "茜", "茜", "晴奈"])), [4])
  // 圆形锁同层：晴奈是后排、3 位的茜是中排，所以只打到一个人
  check("嘲讽仍然拉得走这套索敌", skillTargets((() => {
    const st = setup(["柚子", "茜", "茜", "茜"], ["茜", "茜", "茜", "晴奈"])
    st.sides[1].units[1].taunt = 2
    st.sides[1].units[1].tauntKind = "provoke"
    return st
  })()), [2])
}

console.log("\n=== 30. 泉奈：「每 6 次普通攻击」数的是枪，不是回合 ===")
{
  // 全场血量拉满，谁都死不掉，只看技能在第几个己方回合被打出来
  const izunaRun = (exOnTurn) => {
    const st = setup(["泉奈", "椿", "椿", "椿"], ["椿", "椿", "椿", "椿"])
    for (const s of st.sides) for (const u of s.units) { u.maxhp = 9e6; u.hp = 9e6 }
    st.sides[0].units[0].skillCd = 0
    let cur = st
    const fired = []
    for (let t = 1; t <= 8; t++) {
      cur.sides[0].cost = 10
      const r = run(cur, t === exOnTurn ? { type: "ex", casts: [{ pos: 0 }] } : { type: "pass" })
      if (r.events.some((e) =>
        e.type === "action" && e.action === "skill" && e.source?.side === 0 && e.source?.pos === 0)) fired.push(t)
      cur = run(r.state, { type: "pass" }).state
    }
    return fired
  }
  check("第 6 枪才打出「秘技！爆炸手里剑！」", izunaRun(0), [6])
  // 攒够的那一枪打完**当场**就放，不等下回合 —— tryAutoProc 挂在 autoAttack 末尾
  check("攒够当回合立刻释放，顺序是先普攻后技能", (() => {
    const st = setup(["泉奈", "椿", "椿", "椿"], ["椿", "椿", "椿", "椿"])
    for (const s of st.sides) for (const u of s.units) { u.maxhp = 9e6; u.hp = 9e6 }
    st.sides[0].units[0].skillCd = 0
    let cur = st
    for (let t = 1; t <= 5; t++) cur = run(run(cur, { type: "pass" }).state, { type: "pass" }).state
    const r = run(cur, { type: "pass" })   // 第 6 轮
    return r.events
      .filter((e) => e.type === "action" && e.source?.side === 0 && e.source?.pos === 0)
      .map((e) => e.action)
  })(), ["normal", "skill"])
  // 这条正是不折成回合冷却的理由：放 EX 的回合她不普攻，计数就不该前进
  check("第 3 轮放 EX（那轮不普攻）→ 推迟到第 7 轮", izunaRun(3), [7])

  // ---- EX 与普通技能的联动：攻速要能催动计数 ----
  // 直接注入攻速层（不放 EX），隔离出「攻速 → 攒枪更快」这一条因果
  const withAa = (value, turns = 99) => {
    const st = setup(["泉奈", "椿", "椿", "椿"], ["椿", "椿", "椿", "椿"])
    for (const s of st.sides) for (const u of s.units) { u.maxhp = 9e6; u.hp = 9e6 }
    st.sides[0].units[0].skillCd = 0
    if (value) {
      st.sides[0].units[0].buffs.push({
        stat: "aa", value, turns, st: -1, effectKind: "buff", sourceKey: "test:aa", srcSide: 0, srcPos: 0,
      })
    }
    let cur = st
    const fired = []
    for (let t = 1; t <= 8; t++) {
      const r = run(cur, { type: "pass" })
      if (r.events.some((e) =>
        e.type === "action" && e.action === "skill" && e.source?.side === 0 && e.source?.pos === 0)) fired.push(t)
      cur = run(r.state, { type: "pass" }).state
    }
    return fired
  }
  check("攻速 ×2：3 轮就攒够 6 枪", withAa(1), [3, 6])
  check("她自己 EX 那档 +27.4%：提前一轮", withAa(0.2744), [5])
  check("没有攻速层：老老实实 6 轮", withAa(0), [6])
  // ---- 攻速的第三个出口：命中触发的概率（泉 / 明里）----
  // 少接这一条，「给队友加攻速」的角色就会被系统性低估成一个普通的增伤
  const aaUnit = (value) => ({ buffs: value ? [{ stat: "aa", value }] : [] })
  const r2 = (x) => Number(x.toFixed(4))
  check("无攻速层：就是原始概率", r2(autoProcChance(aaUnit(0), 0.2)), 0.2)
  check("攻速 ×2 = 开两枪：1−0.8²", r2(autoProcChance(aaUnit(1), 0.2)), 0.36)
  check("泉奈那档 +27.4%：1−0.8^1.2744", r2(autoProcChance(aaUnit(0.2744), 0.2)), 0.2475)
  check("爱理的减攻速 −18.5%：概率跟着往下走", r2(autoProcChance(aaUnit(-0.1848), 0.2)), 0.1663)
  check("chance 为 1 的（泉奈）不受影响", autoProcChance(aaUnit(1), 1), 1)

  // 零头留到下个循环，不清零：+27.4% 第 5 轮攒到 6.37，多出来的 0.37 带走
  check("攒过头的零头带进下个循环", (() => {
    const st = setup(["泉奈", "椿", "椿", "椿"], ["椿", "椿", "椿", "椿"])
    for (const s of st.sides) for (const u of s.units) { u.maxhp = 9e6; u.hp = 9e6 }
    const iz = st.sides[0].units[0]
    iz.skillCd = 0
    iz.buffs.push({ stat: "aa", value: 0.2744, turns: 99, st: -1, effectKind: "buff", sourceKey: "t", srcSide: 0, srcPos: 0 })
    let cur = st
    for (let t = 1; t <= 5; t++) cur = run(run(cur, { type: "pass" }).state, { type: "pass" }).state
    return Number(cur.sides[0].units[0].autoCount.toFixed(2))
  })(), 0.37)
}

console.log("\n=== 31. 菲娜：无视开火间隔折成普攻增伤，与攻击力增益分槽共存 ===")
{
  const pina = ROSTER.find((t) => t.name === "菲娜")
  const aa = pina.ex.effects.find((e) => e.stat === "aa")
  const atk = pina.ex.effects.find((e) => e.stat === "atk")
  // (a+d)/(a+d/N)−1，a=21+19+32=72、d=42、N=3 → 114/86−1
  check("折算值 = 由她自己的射击帧数算出来的 +32.56%", aa?.value, 0.3256)
  check("跟攻击力增益不同槽，会共存", [aa?.channel, atk?.channel], [17, 2])
  check("走的是普攻增伤，不是造成伤害", /攻速|普攻/.test(describeEffect(pina.ex)), true)
}

console.log("\n=== 32. 泉奈的位移：朝自动攻击目标移动，阵亡邻位也能进入 ===")
{
  // 四格实现仍通过交换数组槽保持 units[i].idx === i，但规则语义是泉奈移动。
  const order = (st) => st.sides[0].units.map((u) => tmplOf(u).name)
  const idxOk = (st) => st.sides[0].units.every((u, i) => u.idx === i)
  const cast = (st) => run(st, { type: "ex", casts: [{ pos: st.sides[0].units.findIndex((u) => u.id === id("泉奈")) }] })

  // 红 2 是前排，泉奈站 1 位时会自动锁它，因此向右移动一格。
  const base = () => setup(["泉奈", "椿", "野宫", "茜"], ["野宫", "星野", "茜", "茜"])

  const a = cast(base())
  check("自动目标在 2 位：泉奈从 1 位向右移动一格", order(a.state), ["椿", "泉奈", "野宫", "茜"])
  check("units[i].idx === i 仍成立", idxOk(a.state), true)
  check("同战场内移动后仍保持四格唯一占位", a.state.sides[0].units.map((u) => u.idx), [0, 1, 2, 3])

  // 泉奈站 2 位，本战场敌人已空，自动越界锁 3 位，因此跨到 3 位。
  const st2 = setup(["椿", "泉奈", "野宫", "茜"], ["茜", "茜", "茜", "茜"], [[1, 0], [1, 1]])
  const b = cast(st2)
  check("站 2 位且本战场已空：朝 3 位移动并跨界", order(b.state), ["椿", "野宫", "泉奈", "茜"])
  check("日志写明跨了战场", b.log.some((l) => /跨过战场分界/.test(l)), true)

  // 邻位已经阵亡也不是障碍：泉奈进入空位，阵亡对象退到她原来的数组槽。
  const deadNeighbor = base()
  deadNeighbor.sides[0].units[1].alive = false
  deadNeighbor.sides[0].units[1].hp = 0
  const d = cast(deadNeighbor)
  check("相邻队友阵亡仍会进入其位置", [order(d.state), d.state.sides[0].units[1].id],
    [["椿", "泉奈", "野宫", "茜"], id("泉奈")])
  check("日志写明进入阵亡位置", d.log.some((l) => /阵亡位置/.test(l)), true)

  const aligned = setup(["泉奈", "椿", "野宫", "茜"], ["茜", "茜", "茜", "茜"])
  check("已经与自动目标对位时留在原位", order(cast(aligned).state), ["泉奈", "椿", "野宫", "茜"])

  // turnEx 是按号位记的：不跟着换的话，换完位的泉奈会被当成没放过 EX 而多打一枪
  const c = playerTurn(base(), { type: "ex", casts: [{ pos: 0 }] })
  const izunaIdx = c.state.sides[0].units.findIndex((u) => u.id === id("泉奈"))
  check("turnEx 跟着换位一起改号位", [izunaIdx, c.state.turnEx], [1, [1]])
  const done = run(c.state, { type: "pass" })
  check("换完位的泉奈本回合不再普攻",
    done.events.some((e) => e.type === "action" && e.action === "normal"
      && e.source.side === 0 && e.source.pos === izunaIdx), false)
}

/**
 * 让这个人必中。椿 / 优香的闪避是 1400+，而全池命中中位数只有 ~700 ——
 * 拿她们当靶子时半数刀会变成 miss 事件，落点断言就会随机少几发。
 * 命中公式在命中 ≥ 闪避时必中，所以灌一层夸张的命中层最省事。
 */
const noMiss = (u) => {
  u.buffs.push({ stat: "acc", value: 50, turns: 999, st: -1, effectKind: "buff", sourceKey: "t:acc", srcSide: u.side, srcPos: u.idx })
  return u
}

console.log("\n=== 33. 绿：按号位循环点名 5 次，玩家指不了目标 ===")
{
  const cyclePairs = (bluePicks, redPicks, kills = []) => {
    const st = setup(bluePicks, redPicks, kills)
    for (const s of st.sides) for (const u of s.units) { u.maxhp = 9e6; u.hp = 9e6 }
    const pos = st.sides[0].units.findIndex((u) => u.id === id("绿"))
    noMiss(st.sides[0].units[pos])
    const r = playerTurn(st, { type: "ex", casts: [{ pos }] })
    return r.events
      .filter((e) => e.type === "damage" && e.source?.side === 0 && !e.dot)
      .map((e) => e.target.pos + 1)
  }
  const FOUR = ["椿", "椿", "椿", "椿"]
  check("绿站 1 号位：1→2→3→4→1", cyclePairs(["绿", "椿", "椿", "椿"], FOUR), [1, 2, 3, 4, 1])
  check("绿站 2 号位：2→3→4→1→2", cyclePairs(["椿", "绿", "椿", "椿"], FOUR), [2, 3, 4, 1, 2])
  check("只剩 1 个敌人：5 发全落他身上",
    cyclePairs(["绿", "椿", "椿", "椿"], FOUR, [[1, 1], [1, 2], [1, 3]]), [1, 1, 1, 1, 1])
  check("剩 3 个：1→2→3→1→2",
    cyclePairs(["绿", "椿", "椿", "椿"], FOUR, [[1, 3]]), [1, 2, 3, 1, 2])
  const injected = setup(["椿", "绿", "椿", "椿"], FOUR)
  check("即使循环目标固定，额外 target 字段仍被统一拒绝",
    validateAction(injected, { type: "ex", casts: [{ pos: 1, target: { scope: "foe", idx: 3 } }] }),
    "EX 不能指定目标，只能选择释放者")
}

console.log("\n=== 34. 绿 ⇄ 桃：编队条件，同时上场才有 DoT ===")
{
  const dots = (picks) => {
    const st = setup(picks, ["椿", "椿", "椿", "椿"])
    for (const s of st.sides) for (const u of s.units) { u.maxhp = 9e6; u.hp = 9e6 }
    const pos = st.sides[0].units.findIndex((u) => u.id === id("绿"))
    const r = playerTurn(st, { type: "ex", casts: [{ pos }] })
    return r.state.sides[1].units.reduce((n, u) => n + (u.dots || []).length, 0)
  }
  check("绿单独上场：不挂中毒", dots(["绿", "椿", "椿", "椿"]), 0)
  check("绿 + 桃 同时上场：中毒挂上", dots(["绿", "桃", "椿", "椿"]) > 0, true)
  // 桃的爱用品把增伤和加攻只给绿，绿不在场则整条不生效
  const momoiBuffs = (picks) => {
    const st = setup(picks, ["椿", "椿", "椿", "椿"])
    const m = st.sides[0].units.find((u) => u.id === id("桃"))
    m.skillCd = 0
    const r = run(st, { type: "pass" })
    const g = r.state.sides[0].units.find((u) => u.id === id("绿"))
    return g ? g.buffs.map((b) => b.stat).sort() : []
  }
  check("桃的爱用品增益只给绿", momoiBuffs(["桃", "绿", "椿", "椿"]), ["atk", "enh_Pierce"])
  /**
   * 弹种增伤跟**克制无关**：它看的是攻击者自己的弹种，不是「这一刀是不是打在克制上」。
   * 原作把「只有打克制才生效」单列成另一个 Stat（`EnhanceWeakDamageRate`），
   * 而全数据 67 处 `EnhanceXXXRate` 的弹种**无一例外**等于施加者自己的弹种。
   * 三种克制关系下增幅必须完全一样，差一个就说明被写成条件增伤了。
   */
  const enhRatio = (foe) => {
    const st = setup(["绿", "椿", "椿", "椿"], [foe, foe, foe, foe])
    for (const s of st.sides) for (const u of s.units) { u.maxhp = 9e6; u.hp = 9e6 }
    const dmg = (on) => {
      const s = structuredClone(st)
      s.sides[0].units[0].buffs = on ? [{ stat: "enh_Pierce", value: 1 }] : []
      noMiss(s.sides[0].units[0])
      return playerTurn(s, { type: "pass" }).events
        .filter((e) => e.type === "damage" && e.source?.side === 0 && e.source.pos === 0)
        .reduce((x, e) => x + (e.totalAmount ?? e.amount), 0)
    }
    const a = dmg(false)
    return a ? Number((dmg(true) / a).toFixed(2)) : 0
  }
  // 绿是贯通：打重装是克制 ×2、打特殊是普通 ×1、打轻装是被抵抗 ×0.5
  check("被克制的目标（轻装）：增幅仍是 ×2", enhRatio("野宫"), 2)
  check("普通的目标（特殊）：增幅仍是 ×2", enhRatio("椿"), 2)
  check("克制的目标（重装）：增幅仍是 ×2", enhRatio("日奈"), 2)

  check("绿的贯通增伤真的乘进伤害", (() => {
    const st = setup(["绿", "椿", "椿", "椿"], ["椿", "椿", "椿", "椿"])
    const g = st.sides[0].units[0]
    const dmg = (u) => {
      const s = structuredClone(st)
      s.sides[0].units[0].buffs = u ? [{ stat: "enh_Pierce", value: 1 }] : []
      noMiss(s.sides[0].units[0])
      return playerTurn(s, { type: "pass" }).events
        .filter((e) => e.type === "damage" && e.source?.side === 0 && e.source.pos === 0)
        .reduce((x, e) => x + (e.totalAmount ?? e.amount), 0)
    }
    void g
    const a = dmg(false), b = dmg(true)
    return Math.abs(b - a * 2) <= 2
  })(), true)
}

console.log("\n=== 35. 妮露的 Fury / 爱丽丝的能量充能：条件追伤 ===")
{
  const neru = ROSTER.find((t) => t.name === "妮露")
  const aris = ROSTER.find((t) => t.name === "爱丽丝")
  const sum = (h) => h.reduce((a, b) => a + b, 0)
  check("妮露爱用品版是 ×2，不是原技能的 ×1.5",
    Math.round(neru.ex.altHits[0].total / sum(neru.ex.hits) * 100) / 100, 2)
  check("爱丽丝三档：311 / 467 / 622",
    [sum(aris.ex.hits), aris.ex.altHits[1].total, aris.ex.altHits[0].total].map((x) => Math.round(x)),
    [311, 467, 622])
  check("爱用品版开局自带半充", ROSTER.find((t) => t.name === "爱丽丝").skill.stateStart, { key: "energy", value: 1 })

  // 状态真的换了倍率：手动把状态点满，同一发 EX 的伤害应该翻倍
  const exDmg = (name, patch) => {
    const st = setup([name, "椿", "椿", "椿"], ["椿", "椿", "椿", "椿"])
    for (const s of st.sides) for (const u of s.units) { u.maxhp = 9e6; u.hp = 9e6 }
    Object.assign(st.sides[0].units[0], patch)
    noMiss(st.sides[0].units[0])
    st.sides[0].cost = 10
    return playerTurn(st, { type: "ex", casts: [{ pos: 0 }] }).events
      .filter((e) => e.type === "damage" && e.source?.side === 0)
      .reduce((x, e) => x + (e.totalAmount ?? e.amount), 0)
  }
  const n0 = exDmg("妮露", {}), n1 = exDmg("妮露", { fury: 4 })
  check("Fury 期间妮露的 EX 翻倍", Math.abs(n1 / n0 - 2) < 0.06, true)
  const a0 = exDmg("爱丽丝", { energy: 0 }), a2 = exDmg("爱丽丝", { energy: 2 })
  check("满充时爱丽丝的 EX 翻倍", Math.abs(a2 / a0 - 2) < 0.06, true)
  check("放完 EX 能量清零", (() => {
    const st = setup(["爱丽丝", "椿", "椿", "椿"], ["椿", "椿", "椿", "椿"])
    st.sides[0].units[0].energy = 2
    st.sides[0].cost = 10
    return playerTurn(st, { type: "ex", casts: [{ pos: 0 }] }).state.sides[0].units[0].energy
  })(), 0)
}

console.log("\n=== 36. 小春：伤害自动目标，同时治疗其对位友军 ===")
{
  const cast = (blue, red, kills = []) => {
    const st = setup(blue, red, kills)
    for (const u of st.sides[0].units) if (u.alive) u.hp = Math.round(u.maxhp / 2)
    for (const u of st.sides[1].units) { u.maxhp = 9e6; u.hp = 9e6 }
    const pos = st.sides[0].units.findIndex((u) => u.id === id("小春"))
    noMiss(st.sides[0].units[pos])
    st.sides[0].cost = 10
    const r = playerTurn(st, { type: "ex", casts: [{ pos }] })
    const at = (type, side) => r.events
      .filter((e) => e.type === type && e.target.side === side).map((e) => e.target.pos + 1)
    return { r, dmg: at("damage", 1), heal: at("heal", 0), selfDmg: at("damage", 0) }
  }

  // 小春站 2 位；红 1 是本战场唯一前排，所以自动主目标是红 1，治疗蓝 1。
  const mirrored = cast(["野宫", "小春", "野宫", "野宫"], ["星野", "野宫", "野宫", "野宫"])
  check("伤害照常落在自动攻击目标", mirrored.dmg, [1])
  check("同时只治疗攻击主目标对位的蓝 1", mirrored.heal, [1])
  check("不会对己方造成伤害", mirrored.selfDmg, [])

  const missing = cast(["野宫", "小春", "野宫", "野宫"],
    ["星野", "野宫", "野宫", "野宫"], [[0, 0]])
  check("攻击主目标没有存活对位友军时不治疗", missing.heal, [])

  // 红 2 是本战场唯一前排，主目标改成 2 位，治疗也跟着落在蓝 2（小春自己）。
  const shifted = cast(["野宫", "小春", "野宫", "野宫"], ["野宫", "星野", "野宫", "野宫"])
  check("自动主目标改变时，对位治疗同步改变", [shifted.dmg, shifted.heal], [[2], [2]])

  const koharu = ROSTER.find((t) => t.name === "小春")
  check("EX 治疗效果生成成 mirror_ally，不再带 circle 分支",
    [koharu.ex.effects[0].scope, Boolean(koharu.ex.circle)], ["mirror_ally", false])
  check("裸指令可用", parseAction("小春ex")?.ok, true)
  check("带敌方目标的旧写法被拒绝", parseAction("小春ex打白子")?.ok, false)
  check("带友方目标的旧写法被拒绝", parseAction("小春ex奶桃")?.ok, false)

  // 她的普通技能仍服从原文：排除自己、只选血量 ≤50% 的，不被通用位置规则改成最低血量。
  check("普技仍是 ally_hurt，不被改写成 ally_lowest",
    [koharu.skill.target, koharu.skill.exceptSelf, koharu.skill.hpMax], ["ally_hurt", true, 0.5])
  check("冷却 10 秒 = 2 回合，不是默认的 5", koharu.skill.trigger, { type: "cooldown", turns: 2, icd: true })
}

console.log("\n=== 37. 单体奶的选人：小春按站位就近，绿按血量最低 ===")
{
  // 站位：小春=1 号（战场 0）、椿=2 号（战场 0）、优香=3 号（战场 1）、春香=4 号（战场 1）
  const heal = (hp, picks = ["小春", "椿", "优香", "春香"]) => {
    const st = setup(picks, ["椿", "椿", "椿", "椿"])
    for (const s of st.sides) for (const u of s.units) { u.maxhp = 9e6; u.hp = 9e6 }
    st.sides[0].units[0].skillCd = 0
    hp(st.sides[0].units)
    const r = run(st, { type: "pass" })
    return r.events
      .filter((e) => e.type === "heal" && e.target.side === 0)
      .map((e) => tmplOf(r.state.sides[0].units[e.target.pos]).name)
  }
  check("同战场的够格 → 喂同战场，不看谁更残",
    heal((us) => { us[1].hp *= 0.5; us[2].hp *= 0.1 }), ["椿"])
  check("同战场没人够格 → 越界喂另一战场",
    heal((us) => { us[3].hp *= 0.4 }), ["春香"])
  check("都在另一战场 → 号位差小的优先，不是更残的那个",
    heal((us) => { us[2].hp *= 0.2; us[3].hp *= 0.4 }), ["优香"])
  check("永远只奶一个人，不是群奶",
    heal((us) => { us[1].hp *= 0.4; us[3].hp *= 0.4 }), ["椿"])
  check("排除自身：只有自己残血就不放", heal((us) => { us[0].hp *= 0.1 }), [])

  // 绿原文写的是「生命值百分比最低」，所以她按血量挑，跨战场也挑最残的
  check("绿按血量最低挑，跨战场也认",
    heal((us) => { us[1].hp *= 0.5; us[2].hp *= 0.1 }, ["绿", "椿", "优香", "春香"]), ["优香"])
}

console.log("\n=== 38. 没有合法目标时不算出手：不进冷却、也不吞掉普攻 ===")
{
  const st = setup(["小春", "椿", "优香", "春香"], ["椿", "椿", "椿", "椿"])
  for (const s of st.sides) for (const u of s.units) { u.maxhp = 9e6; u.hp = 9e6 }
  // setup 会把所有人的 skillCd 压成 99 来测对线，这一组要测的正是冷却本身
  st.sides[0].units[0].skillCd = 0
  let cur = st
  const seen = []
  for (let t = 1; t <= 3; t++) {
    const r = run(cur, { type: "pass" })
    const k = r.state.sides[0].units[0]
    seen.push([k.skillCd, k.skillUses,
      r.events.some((e) => e.type === "action" && e.action === "normal" && e.source?.side === 0 && e.source.pos === 0)])
    cur = run(r.state, { type: "pass" }).state
  }
  check("全队满血：冷却不动、次数不涨、普攻照常", seen, [[0, 0, true], [0, 0, true], [0, 0, true]])
  // 「(冷却N秒)」是再次使用的间隔，靠条件门控，所以开局就是就绪的
  check("条件+冷却型开局不压满冷却", ROSTER.find((t) => t.name === "小春").skill.trigger.icd, true)
  check("「每N秒」的周期型仍然压满", ROSTER.find((t) => t.name === "绿").skill.trigger.icd, undefined)

  // 放出去那一轮**算**一次冷却跳动：10 秒 = 2 轮，所以第 1、3、5 轮各放一次
  const rounds = (() => {
    const s2 = setup(["小春", "椿", "优香", "春香"], ["椿", "椿", "椿", "椿"])
    for (const s of s2.sides) for (const u of s.units) { u.maxhp = 9e6; u.hp = 9e6 }
    for (const i of [1, 2, 3]) s2.sides[0].units[i].hp = Math.round(s2.sides[0].units[i].maxhp * 0.4)
    s2.sides[0].units[0].skillCd = 0
    let c = s2
    const out = []
    for (let t = 1; t <= 6; t++) {
      const r = run(c, { type: "pass" })
      if (r.log.some((l) => /我来治疗/.test(l))) out.push(t)
      c = run(r.state, { type: "pass" }).state
    }
    return out
  })()
  check("施放回合算一次冷却跳动 → 每 2 轮一次，正好是 10 秒", rounds, [1, 3, 5])
}

console.log("\n=== 39. 切里诺：EX 全体、集火选最高攻、嘲讽优先于集火 ===")
{
  const cherino = ROSTER.find((t) => t.name === "切里诺")
  check("EX 是自身为圆心的大圆 → 全体 4 人，不是场地",
    [cherino.ex.target, cherino.ex.count, Boolean(cherino.ex.hits), cherino.ex.effects.some((e) => e.type === "dot")],
    ["enemy_all", 4, true, false])
  check("EX 515% 摊成 4 段",
    [cherino.ex.hits.length, Number(cherino.ex.hits.reduce((a, b) => a + b, 0).toFixed(2))],
    [4, 515.83])
  check("普技：每 40 秒 = 8 回合，点攻击力最高的，集火 15 秒 = 3 回合，暴伤抵抗 −18.75%",
    [cherino.skill.target, cherino.skill.pick, cherino.skill.trigger.turns,
      cherino.skill.effects.find((e) => e.kind === "focus"),
      cherino.skill.effects.find((e) => e.stat === "crit_dmg_res")],
    ["enemy_single", "max_atk", 8,
      { type: "taunt", kind: "focus", scope: "enemy", turns: 3 },
      { type: "buff", scope: "enemy", stat: "crit_dmg_res", value: -0.1875, turns: 3, channel: 623 }])
  check("卡面写清是打攻击力最高的、全体、集火", [
    /攻击力最高/.test(describeEffect(cherino.skill)),
    /被集火/.test(describeEffect(cherino.skill)),
    /暴伤抵抗/.test(describeEffect(cherino.skill)),
    /敌方全体/.test(describeEffect(cherino.ex)),
  ], [true, true, true, true])

  const skillTargets = (st) => {
    st.sides[0].units[0].skillCd = 0
    const r = run(st, { type: "pass" })
    const ev = r.events.find((e) =>
      e.type === "action" && e.action === "skill" && e.source?.side === 0 && e.source?.pos === 0)
    return { r, to: (ev?.targets || []).map((t) => t.pos + 1) }
  }
  // 晴奈 457 / 后排 / 另一战场；同战场两个茜 120。点到 4 才说明 pick 生效
  check("普技越过战场分割，点全场攻击力最高的 4 位",
    skillTargets(setup(["切里诺", "茜", "茜", "茜"], ["茜", "茜", "茜", "晴奈"])).to, [4])

  {
    const stMark = setup(["切里诺", "野宫", "野宫", "野宫"], ["茜", "茜", "茜", "晴奈"])
    for (const s of stMark.sides) for (const u of s.units) { u.maxhp = 9e6; u.hp = 9e6 }
    const { r } = skillTargets(stMark)
    const marked = r.state.sides[1].units[3]
    check("集火标落在被点名的那个人自己头上", focusedOf(marked), true)
    check("减暴伤抵抗也只挂在她身上",
      r.state.sides[1].units.map((u) => u.buffs.some((b) => b.stat === "crit_dmg_res")),
      [false, false, false, true])
    check("集火不封对面 EX", r.state.sides[1].units.map((u) => exLockedOf(r.state, u)),
      [null, null, null, null])
    const autos = r.events
      .filter((e) => e.type === "action" && e.action === "normal" && e.source.side === 0)
      .map((e) => (e.targets || []).map((t) => t.pos + 1).join(""))
    // 切里诺自己在 ③-a 放过技能，③-b 不再普攻，所以是三个队友
    check("集火后队友普攻全锁 4 位", autos, ["4", "4", "4"])
  }

  // EX 是全体，嘲讽封的是「放不出 EX」本身，所以测全体不被吸成单体要用集火（不封 EX）
  {
    const st = setup(["野宫", "切里诺", "野宫", "野宫"], ["茜", "茜", "茜", "晴奈"])
    for (const s of st.sides) for (const u of s.units) { u.maxhp = 9e6; u.hp = 9e6 }
    st.sides[1].units[3].focus = 3
    st.sides[1].units[3].focusSt = -1
    const r = run(st, { type: "ex", casts: [{ pos: 0 }] })
    if (r.error) throw new Error(`野宫 EX 放不出：${r.error}`)
    check("集火锁着时，全体 EX 仍打 4 人（不被吸成单体）",
      r.events.find((e) => e.type === "action" && e.action === "ex")?.targets.length, 4)
  }

  // 先集火再嘲讽：两套共存，开火嘲讽优先；嘲讽过期后锁回被集火的人
  {
    const st = setup(["切里诺", "野宫", "野宫", "野宫"], ["椿", "茜", "茜", "晴奈"])
    for (const s of st.sides) for (const u of s.units) { u.maxhp = 9e6; u.hp = 9e6 }
    st.sides[0].units[0].skillCd = 0
    let cur = run(st, { type: "pass" }).state
    check("集火先挂上时晴奈有标、椿没有嘲讽",
      [focusedOf(cur.sides[1].units[3]), cur.sides[1].units[0].taunt], [true, 0])
    cur.sides[1].cost = 10
    cur = playerTurn(cur, { type: "ex", casts: [{ pos: 0 }] }).state // 椿
    check("嘲讽后集火还在（不是被覆盖清掉）",
      [focusedOf(cur.sides[1].units[3]), cur.sides[1].units[0].taunt > 0, cur.sides[1].units[0].tauntKind],
      [true, true, "provoke"])
    while (cur.turnOpen) cur = playerTurn(cur, { type: "pass" }).state
    const first = playerTurn(cur, { type: "pass" })
    const hit1 = first.events
      .filter((e) => e.type === "action" && e.action === "normal" && e.source.side === 0)
      .map((e) => (e.targets || []).map((t) => t.pos + 1).join(""))
    check("嘲讽优先：蓝方普攻全打椿", hit1, ["1", "1", "1", "1"])
    check("这一轮打完嘲讽到期，集火还在",
      [first.state.sides[1].units[0].taunt, focusedOf(first.state.sides[1].units[3])], [0, true])
    const second = run(first.state, { type: "pass" }) // 红过
    const third = playerTurn(second.state, { type: "pass" })
    const hit2 = third.events
      .filter((e) => e.type === "action" && e.action === "normal" && e.source.side === 0)
      .map((e) => (e.targets || []).map((t) => t.pos + 1).join(""))
    check("嘲讽过期后火力锁回被集火的晴奈", hit2, ["4", "4", "4", "4"])
  }

  // 嘲讽拉得住开火，但改不了集火标记的落点
  {
    const st = setup(["切里诺", "野宫", "野宫", "野宫"], ["椿", "茜", "茜", "晴奈"])
    for (const s of st.sides) for (const u of s.units) { u.maxhp = 9e6; u.hp = 9e6 }
    let cur = run(st, { type: "pass" }).state
    cur.sides[1].cost = 10
    cur = playerTurn(cur, { type: "ex", casts: [{ pos: 0 }] }).state
    while (cur.turnOpen) cur = playerTurn(cur, { type: "pass" }).state
    cur.sides[0].units[0].skillCd = 0
    const { r, to } = skillTargets(cur)
    check("对面嘲讽着，普技仍点攻击力最高的晴奈，不是椿", to, [4])
    check("标记落在晴奈（嘲讽改不了选人）", focusedOf(r.state.sides[1].units[3]), true)
    const autos = r.events
      .filter((e) => e.type === "action" && e.action === "normal" && e.source.side === 0)
      .map((e) => (e.targets || []).map((t) => t.pos + 1).join(""))
    // 切里诺放过技能，三个队友的刀仍被嘲讽吸走。回合结束嘲讽才到期，所以这里不能去读剩余回合
    check("同一回合开火仍被嘲讽拉去打椿", autos, ["1", "1", "1"])
  }
}

console.log("\n=== 40. ③-a 同时锁定：打死不换目标，奶也按开场血量锁人 ===")
{
  // 两个茜都是单体伤害普技。红 1 是前排星野，同战场两个人都会锁她。
  // 她只剩 1 血，第一个人足够打死。同时锁定则两发都锁星野；第二发不换人，但伤害缺失。
  const dmg = setup(["茜", "茜", "野宫", "野宫"], ["星野", "野宫", "野宫", "野宫"])
  for (const s of dmg.sides) for (const u of s.units) { u.maxhp = 9e6; u.hp = 9e6 }
  // 命中拉满：闪避有 0.2 下限，星野底闪 1416，得给茜加命中才必中
  for (const u of dmg.sides[0].units) u.buffs.push({ stat: "acc", value: 20, turns: 99, st: -1 })
  dmg.sides[1].units[0].hp = 1
  dmg.sides[0].units[0].skillCd = 0
  dmg.sides[0].units[1].skillCd = 0
  const dmgR = run(dmg, { type: "pass" })
  const skillHits = dmgR.events
    .filter((e) => e.type === "action" && e.action === "skill" && e.source.side === 0)
    .map((e) => (e.targets || []).map((t) => t.pos + 1))
  check("两个单体普技都锁开场那个残血前排，第二发不换人", skillHits, [[1], [1]])
  check("第二发不换人，但目标已倒下所以伤害缺失",
    dmgR.events.some((e) => (e.type === "damage" || e.type === "miss") && !e.dot && e.source?.side === 0
      && e.source?.pos === 1 && e.target?.pos === 0), false)
  check("倒下只报一次", dmgR.log.filter((l) => /倒下/.test(l)).length, 1)

  // 椿 20% 会自奶，小春 / 绿同一回合都就绪。同时锁定则三个人都认椿；
  // 若顺序结算，椿先奶满，小春就找不到 ≤50% 的人、绿改奶别人。
  const healSt = setup(["椿", "小春", "绿", "野宫"], ["椿", "椿", "椿", "椿"])
  for (const s of healSt.sides) for (const u of s.units) { u.maxhp = 9e6; u.hp = 9e6 }
  healSt.sides[0].units[0].hp = Math.round(healSt.sides[0].units[0].maxhp * 0.2)
  healSt.sides[0].units[1].skillCd = 0
  healSt.sides[0].units[2].skillCd = 0
  const healR = run(healSt, { type: "pass" })
  const heals = healR.events
    .filter((e) => e.type === "heal" && e.source.side === 0)
    .map((e) => [tmplOf(healR.state.sides[0].units[e.source.pos]).name, e.target.pos + 1])
  check("椿 / 小春 / 绿三发治疗都锁开场最残的椿", heals, [["椿", 1], ["小春", 1], ["绿", 1]])
  check("小春这一轮算出手了（不是椿奶满后找不到人）",
    healR.state.sides[0].units[1].skillUses, 1)
}

console.log("\n=== 41. ③-b 普攻同时锁定；普攻触发的技能仍会换人 ===")
{
  // 同战场两个后排都锁红 1 前排。红 1 只剩 1 血，第一枪足够打死。
  const st = setup(["野宫", "野宫", "野宫", "野宫"], ["星野", "野宫", "野宫", "野宫"])
  for (const s of st.sides) for (const u of s.units) { u.maxhp = 9e6; u.hp = 9e6 }
  for (const u of st.sides[0].units) u.buffs.push({ stat: "acc", value: 20, turns: 99, st: -1 })
  st.sides[1].units[0].hp = 1
  const r = run(st, { type: "pass" })
  const autos = r.events
    .filter((e) => e.type === "action" && e.action === "normal" && e.source.side === 0)
    .map((e) => (e.targets || []).map((t) => t.pos + 1))
  // 1·2 号位同战场，都会锁红 1；3·4 是另一战场，本来就打自己那边
  check("同战场两个普攻都锁开场那个残血前排，不换人", autos.slice(0, 2), [[1], [1]])
  check("另一战场不受影响", autos.slice(2), [[3], [4]])
  check("后手普攻不换人，但目标已倒下所以伤害缺失",
    r.events.some((e) => (e.type === "damage" || e.type === "miss") && !e.dot && e.source?.side === 0
      && e.source?.pos === 1 && e.target?.pos === 0), false)
  check("普攻阶段倒下只报一次", r.log.filter((l) => /倒下/.test(l)).length, 1)

  // 泉奈第 6 枪触发手里剑：队友普攻仍锁尸体但伤害缺失；手里剑按触发时场上重锁到红 2
  const iz = setup(["泉奈", "野宫", "野宫", "野宫"], ["星野", "野宫", "野宫", "野宫"])
  for (const s of iz.sides) for (const u of s.units) { u.maxhp = 9e6; u.hp = 9e6 }
  for (const u of iz.sides[0].units) u.buffs.push({ stat: "acc", value: 20, turns: 99, st: -1 })
  iz.sides[1].units[0].hp = 1
  iz.sides[0].units[0].autoCount = 5
  iz.sides[0].units[0].skillCd = 0
  const izR = run(iz, { type: "pass" })
  const izAuto = izR.events.find((e) =>
    e.type === "action" && e.action === "normal" && e.source.side === 0 && e.source.pos === 0)
  const izSkill = izR.events.find((e) =>
    e.type === "action" && e.action === "skill" && e.source.side === 0 && e.source.pos === 0)
  const allyAuto = izR.events.find((e) =>
    e.type === "action" && e.action === "normal" && e.source.side === 0 && e.source.pos === 1)
  check("泉奈普攻仍锁开场的残血前排", (izAuto?.targets || []).map((t) => t.pos + 1), [1])
  check("队友普攻也锁那具尸体，不换人", (allyAuto?.targets || []).map((t) => t.pos + 1), [1])
  check("队友锁尸体的普攻伤害缺失",
    izR.events.some((e) => (e.type === "damage" || e.type === "miss") && !e.dot
      && e.source?.side === 0 && e.source?.pos === 1 && e.target?.pos === 0), false)
  check("手里剑是普攻触发，目标死了会换到红 2", (izSkill?.targets || []).map((t) => t.pos + 1), [2])

  // 击杀触发只认内部谁先把血打到 0
  const killSt = setup(["鹤城", "野宫", "野宫", "野宫"], ["星野", "野宫", "野宫", "野宫"])
  for (const s of killSt.sides) for (const u of s.units) { u.maxhp = 9e6; u.hp = 9e6 }
  for (const u of killSt.sides[0].units) u.buffs.push({ stat: "acc", value: 20, turns: 99, st: -1 })
  killSt.sides[1].units[0].hp = 1
  killSt.sides[0].units[0].skillCd = 0
  const killR = run(killSt, { type: "pass" })
  check("只有先把血打到 0 的鹤城触发击杀技", killR.state.sides[0].units[0].skillUses, 1)
  check("后手野宫仍锁已倒下目标，伤害缺失且不触发击杀", killR.state.sides[0].units[1].skillUses, 0)
}

console.log("\n=== 42. 被控：条件技不吞，周期技照吞 ===")
{
  const fat = (st) => {
    for (const s of st.sides) for (const u of s.units) { u.maxhp = 9e6; u.hp = 9e6 }
  }
  const cc = (u, icon) => { u.stun = 1; u.stunIcon = icon; u.stunSt = -1 }

  // 小春：有人 ≤50%、CD 好了，但她被恐惧。放不出，也不进冷却。
  const koharuSt = setup(["小春", "椿", "野宫", "野宫"], ["野宫", "野宫", "野宫", "野宫"])
  fat(koharuSt)
  koharuSt.sides[0].units[1].hp = Math.round(koharuSt.sides[0].units[1].maxhp * 0.4)
  koharuSt.sides[0].units[0].skillCd = 0
  cc(koharuSt.sides[0].units[0], "Fear")
  const koharuR = run(koharuSt, { type: "pass" })
  const kAfter = koharuR.state.sides[0].units[0]
  check("小春被恐惧：条件够了也不放",
    koharuR.events.some((e) => e.type === "heal" && e.source?.side === 0 && e.source?.pos === 0), false)
  check("小春这次不进冷却、不记次数", [kAfter.skillCd, kAfter.skillUses], [0, 0])
  check("小春战报是无法行动，不是被打断",
    koharuR.log.some((l) => /小春 恐惧，无法行动/.test(l)), true)
  check("小春这一轮也不普攻",
    koharuR.events.some((e) => e.type === "action" && e.action === "normal" && e.source.side === 0 && e.source.pos === 0), false)

  let kNext = run(koharuR.state, { type: "pass" }).state
  kNext.sides[0].units[1].hp = Math.round(kNext.sides[0].units[1].maxhp * 0.4)
  const koharu2 = run(kNext, { type: "pass" })
  check("解控后小春还能放", koharu2.state.sides[0].units[0].skillUses, 1)
  check("解控后小春才进冷却", koharu2.state.sides[0].units[0].skillCd > 0, true)

  const cond = (name) => {
    const st = setup([name, "野宫", "野宫", "野宫"], ["野宫", "野宫", "野宫", "野宫"])
    fat(st)
    const u = st.sides[0].units[0]
    u.hp = Math.round(u.maxhp * 0.15)
    cc(u, "Stunned")
    return run(st, { type: "pass" })
  }
  const tb = cond("椿")
  check("椿被眩晕：残血也不自奶",
    tb.events.some((e) => e.type === "heal" && e.source?.side === 0 && e.source?.pos === 0), false)
  check("椿的每场 1 次没被烧掉", tb.state.sides[0].units[0].skillUses, 0)

  const hs = cond("星野")
  check("星野被眩晕：急救治疗不触发",
    hs.events.some((e) => e.type === "heal" && e.source?.side === 0 && e.source?.pos === 0), false)
  check("星野的次数没被烧掉", hs.state.sides[0].units[0].skillUses, 0)

  let tbNext = run(tb.state, { type: "pass" }).state
  tbNext.sides[0].units[0].hp = Math.round(tbNext.sides[0].units[0].maxhp * 0.15)
  const tb2 = run(tbNext, { type: "pass" })
  check("解控后椿还能自奶", tb2.state.sides[0].units[0].skillUses, 1)

  // 野宫：按回合数转的周期技，就绪时被控就吞
  const n = setup(["野宫", "野宫", "野宫", "野宫"], ["野宫", "野宫", "野宫", "野宫"])
  n.sides[0].units[0].skillCd = 0
  cc(n.sides[0].units[0], "Stunned")
  const nR = run(n, { type: "pass" })
  const nu = nR.state.sides[0].units[0]
  check("周期技就绪被控：当场被打断进冷却", [nu.skillUses, nu.skillCd > 0], [1, true])
  check("周期技战报是被打断",
    nR.log.some((l) => /野宫 眩晕，「.+」被打断/.test(l)), true)
  check("周期技没真正放出去",
    nR.events.some((e) => e.type === "action" && e.action === "skill" && e.source.side === 0 && e.source.pos === 0), false)
}

console.log("\n=== 36. 支援位：不站在场上、5/6 只是结算编号 ===")
{
  // 静子 5 号、真白 6 号；对面塞两个惰性支援凑满编成
  const sup = setup(["野宫", "野宫", "野宫", "野宫", "静子", "真白"],
    ["伊织", "伊织", "伊织", "伊织", "芹娜", "芹娜"], [], { fieldCovers: true })
  for (const side of sup.sides) for (const u of side.supports) u.skillCd = 9999
  sup.sides[0].cost = 10

  check("支援在独立数组里，units 仍是 4 个", [sup.sides[0].units.length, sup.sides[0].supports.length], [4, 2])
  check("支援的号位是 4、5（对外 5、6 号）", sup.sides[0].supports.map((u) => u.idx), [4, 5])
  check("EX 冷却长度 = 6 − 3", exLockLenOf(sup.sides[0]), 3)
  check("开局双方都在 1、4 号位生成场地掩体",
    sup.sides.map((s) => s.summons.filter((sm) => sm.fieldCover).map((sm) => [sm.blockIdx, sm.maxhp])),
    [[[0, 700], [3, 700]], [[0, 700], [3, 700]]])
  check("场地掩体不复用静子 99999 的百夜堂摊位素材",
    [Boolean(fieldCoverArtOf()), Boolean(summonArtOf(99999)), fieldCoverArtOf() !== summonArtOf(99999)],
    [true, true, true])
  const fieldHtml = buildBattleHtml(sup)
  check("红蓝同号位掩体固定共用一行坐标系，不被 Grid 挤到人物行",
    /grid-template-rows:1fr/.test(fieldHtml) && /\.sm\{[^}]*grid-row:1/.test(fieldHtml), true)

  // 打不到：敌方任何索敌都不该选中支援。伊织的连发会逐发重锁，最容易漏
  const shot = run(sup, { type: "pass" })
  const hitSup = shot.events.some((e) => e.type === "damage" && e.target?.pos >= 4)
  check("支援挨不到刀", hitSup, false)
  check("支援血量没动", shot.state.sides[0].supports.map((u) => u.hp === u.maxhp), [true, true])

  // ally_* 的目标池只有 4 个主力：静子的圈不能落在支援自己头上
  const cast = playerTurn(sup, { type: "ex", casts: [{ pos: 4 }] })
  const tg = cast.events.find((e) => e.type === "action" && e.source.pos === 4)?.targets || []
  const placedCover = cast.state.sides[0].summons.find((sm) => sm.cover && !sm.fieldCover)
  check("静子的圈只圈得到主力", tg.every((t) => t.pos < 4), true)
  check("掩体架在我方半场（onAlly）", Boolean(placedCover?.onAlly), true)
  check("掩体永久：turns 是 null", placedCover?.turns, null)
  check("掩体是构造物（全属性 ×0.5）", tmplOf(placedCover).defType, "构造物")
  check("静子掩体按 29.26% 生命生成 734 耐久", placedCover?.maxhp, 734)
  check("静子部署到 1 路时替换场地掩体，同路不叠加",
    cast.state.sides[0].summons.filter((sm) => sm.cover).map((sm) => [sm.blockIdx, Boolean(sm.fieldCover)]).sort((a, b) => a[0] - b[0]),
    [[0, false], [3, true]])

  // Cost 回复算支援：4 主力 + 2 支援 = 6 × 0.5 = 3
  const fresh = setup(["野宫", "野宫", "野宫", "野宫"], OUT)
  check("满编 Cost 回复 = 3/回合", regenOf(fresh.sides[0], fresh), 3)
  fresh.sides[0].units[3].alive = false
  check("死一个主力后 = 2.5/回合", regenOf(fresh.sides[0], fresh), 2.5)

  // 白热化把 4 个场上主力的 0.5 都翻倍成 1.0；两个支援仍各贡献 0.5。
  const fever = setup(["星野", "白子", "野宫", "伊织"], OUT)
  fever.round = CFG.FEVER_ROUND
  check("白热化：4 个场上主力 ×1 + 2 个支援 ×0.5 = 5/回合", regenOf(fever.sides[0], fever), 5)
  check("白热化：场上主力全是后排也仍为 5/回合", regenOf(fever.sides[1], fever), 5)
  const entered = playerTurn(structuredClone(fever), { type: "pass" }).state
  check("白热化 Cost 回复 Buff 挂给全部场上主力",
    entered.sides[0].units.map((u) => u.buffs.some((b) => b.sourceKey === "fever-cost")),
    [true, true, true, true])
  check("白热化 Cost 回复 Buff 不挂给支援",
    entered.sides[0].supports.map((u) => u.buffs.some((b) => b.sourceKey === "fever-cost")),
    [false, false])
  fever.sides[0].units[3].alive = false
  check("白热化：阵亡一个场上主力后 = 4/回合", regenOf(fever.sides[0], fever), 4)

  // 冷却长度按**存活总人数**逐级退，剩 3 人（1 主力 + 2 支援）就完全没冷却了。
  // 支援不死，所以 3 是下限 —— 这也是反死锁不变量「可放的人永远 ≥3」的来源。
  const lens = [[], [3], [2, 3], [1, 2, 3]].map((kills) => {
    const st = setup(["茜", "芹香", "野宫", "伊织"], OUT, kills.map((i) => [0, i]))
    return exLockLenOf(st.sides[0])
  })
  check("冷却长度随人数退：6/5/4/3 人 → 3/2/1/0", lens, [3, 2, 1, 0])
}

console.log("\n=== 37. 支援免疫嘲讽，但**不免疫冷却** ===")
{
  /** 红方 pos 放 EX 之后把回合交回蓝方（跟第 33 组的 handoff 同一套，那个在块作用域里） */
  const handoff = (red, pos) => {
    const st = setup(OUT, red)
    st.sides[1].cost = 10
    let cur = run(st, { type: "pass" }).state
    cur.sides[1].cost = 10
    cur = playerTurn(cur, { type: "ex", casts: [{ pos }] }).state
    while (cur.turnOpen) cur = playerTurn(cur, { type: "pass" }).state
    cur.sides[0].cost = 10
    return cur
  }
  // 椿把蓝方四个主力全拉走，蓝方只剩两个支援有出手权
  const taunted = handoff(["椿", "野宫", "野宫", "野宫"], 0)
  check("四个主力被嘲讽", taunted.sides[0].units.map((u) => exLockedOf(taunted, u)),
    ["嘲讽", "嘲讽", "嘲讽", "嘲讽"])
  check("支援没被嘲讽", taunted.sides[0].supports.map((u) => exLockedOf(taunted, u)), [null, null])
  check("所以名单不空", exCastableOf(taunted, 0), [4, 5])

  /**
   * **免控不等于免冷却**：`exLockedOf` 只管控制那一把锁，冷却是另一把。
   * 两个支援都压进冷却之后名单就空了 —— 这一轮玩家真的没有任何选择，
   * 指令层按「`exCastableOf` 空就自动过回合」处理是对的，不算吞掉支援的行动。
   */
  const s = taunted.sides[0]
  s.exCasts = 9
  s.supports[0].exCastNo = 9
  s.supports[1].exCastNo = 8
  check("支援在冷却里", s.supports.map((u) => exWaitOf(s, u) > 0), [true, true])
  check("嘲讽 + 支援冷却 → 名单是空的", exCastableOf(taunted, 0), [])
  check("选择支援释放：报冷却，不报嘲讽",
    /冷却/.test(validateAction(taunted, { type: "ex", casts: [{ pos: 4 }] }) || ""), true)
  check("选择主力释放：仍然报嘲讽",
    /嘲讽/.test(validateAction(taunted, { type: "ex", casts: [{ pos: 0 }] }) || ""), true)

  // 恐惧同理：控制与冷却是两把独立的锁
  const feared = handoff(["佳代子", "野宫", "野宫", "野宫"], 0)
  const f = feared.sides[0]
  f.exCasts = 9
  f.supports[0].exCastNo = 9
  f.supports[1].exCastNo = 8
  check("恐惧 + 支援冷却 → 名单也是空的", exCastableOf(feared, 0), [])
}

console.log("\n=== 38. 场地掩体：Block=1 每段 30% 决定谁承伤 ===")
{
  /** 先让蓝方交回合，再只留红 1 一名攻击者，隔离其他人的伤害。 */
  const fieldBattle = (blue, attacker) => {
    const st = setup(blue, [attacker, "野宫", "野宫", "野宫"], [], { fieldCovers: true })
    for (const s of st.sides) for (const u of s.supports) u.skillCd = 9999
    for (const u of st.sides[1].units) u.hp = u.maxhp = 1e9
    const cur = playerTurn(st, { type: "pass" }).state
    for (let i = 1; i < 4; i++) { cur.sides[1].units[i].alive = false; cur.sides[1].units[i].hp = 0 }
    return cur
  }
  const shotOf = (r) => r.events.find((e) =>
    (e.type === "damage" || e.type === "miss") && e.source?.side === 1 && e.source?.pos === 0)
  const oldRate = CFG.COVER_BLOCK_RATE
  try {
    CFG.COVER_BLOCK_RATE = 1
    const blocked = fieldBattle(["星野", "白子", "千世", "芹香"], "伊织")
    const cover = blocked.sides[0].summons.find((s) => s.fieldCover && s.blockIdx === 0)
    const hp = blocked.sides[0].units[0].hp
    const r = run(blocked, { type: "pass" })
    const ev = shotOf(r)
    check("Block=1 强制成功：伤害事件落在场地掩体", Boolean(ev?.target?.summon), true)
    check("掩体事件带 cover 标记，渲染层可以统一过滤", ev?.target?.cover, true)
    check("格挡不是免伤：掩体实际掉耐久，角色不掉血",
      [r.state.sides[0].summons.find((s) => s.sourceKey === cover.sourceKey)?.hp < 700,
        r.state.sides[0].units[0].hp === hp], [true, true])
    check("掩体承伤事件记录 BLOCK 段数", ev?.blocked, 1)
    const blockFx = r.events.find((e) => e.type === "block" && e.source?.side === 1 && e.source?.pos === 0)
    check("全挡反馈仍挂回原角色并显示 0",
      [blockFx?.target?.pos, Boolean(blockFx?.target?.summon), blockFx?.totalAmount, blockFx?.blocked],
      [0, false, 0, 1])
    const blockHtml = buildBattleHtml(r.state, r.events)
    check("战场图只在角色处显示一个 0 BLOCK，掩体不再单独冒伤害数字",
      [(blockHtml.match(/class="fxstack"/g) || []).length,
        blockHtml.includes("<b>0</b>"), blockHtml.includes(">BLOCK</i>")],
      [1, true, true])
    const action = r.events.find((e) => e.type === "action" && e.action === "normal" && e.source?.side === 1)
    check("掩体不改索敌：出手线仍指向自动选中的 1 号角色",
      action?.targets.map((t) => [t.pos, Boolean(t.summon)]), [[0, false]])

    CFG.COVER_BLOCK_RATE = 0
    const failed = fieldBattle(["星野", "白子", "千世", "芹香"], "伊织")
    const failedCover = failed.sides[0].summons.find((s) => s.fieldCover && s.blockIdx === 0)
    const failedHp = failed.sides[0].units[0].hp
    const missBlock = run(failed, { type: "pass" })
    check("Block=1 格挡失败：伤害落回角色，掩体耐久不变",
      [Boolean(shotOf(missBlock)?.target?.summon), missBlock.state.sides[0].units[0].hp < failedHp,
        failedCover.hp], [false, true, 700])

    CFG.COVER_BLOCK_RATE = 1
    const uncovered = run(fieldBattle(["野宫", "星野", "千世", "芹香"], "伊织"), { type: "pass" })
    check("掩体只护同号位：自动锁定无掩体的 2 号仍直接打人",
      [shotOf(uncovered)?.target?.pos, Boolean(shotOf(uncovered)?.target?.summon)], [1, false])
    const bypass = fieldBattle(["星野", "白子", "千世", "芹香"], "爱丽丝")
    const bypassCover = bypass.sides[0].summons.find((s) => s.fieldCover && s.blockIdx === 0)
    const bypassResult = run(bypass, { type: "pass" })
    check("Block=0 光束直接穿过：打角色且掩体不掉血",
      [Boolean(shotOf(bypassResult)?.target?.summon), bypassCover.hp], [false, 700])
  } finally {
    CFG.COVER_BLOCK_RATE = oldRate
  }

  const aimed = { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: 0 } }] }
  check("有掩体也不能靠玩家点名绕过固定索敌",
    validateAction(fieldBattle(["星野", "白子", "千世", "芹香"], "伊织"), aimed),
    "EX 不能指定目标，只能选择释放者")
}

console.log("\n=== 39. 支援位治疗：人数以描述为准，不是有圈就是全体 ===")
{
  const of = (n) => ROSTER.find((t) => t.name === n)
  check("花江 EX 是单体持续治疗", [of("花江").ex.target, of("花江").ex.count], ["ally_single", 1])
  check("千夏 EX 是单体治疗", [of("千夏").ex.target, of("千夏").ex.count], ["ally_single", 1])
  check("芹娜 EX 是单体，大圈只是位移不是覆盖", [of("芹娜").ex.target, of("芹娜").ex.count], ["ally_single", 1])
  check("绫音 EX 是同战场 2 人", [of("绫音").ex.target, of("绫音").ex.count], ["ally_adjacent", 2])
  check("花子 EX 是同战场 2 人", [of("花子").ex.target, of("花子").ex.count], ["ally_adjacent", 2])
  check("风香 EX 原文写 4 名，是真·全体", [of("风香").ex.target, of("风香").ex.count], ["ally_all", 4])
  check("花子普技是 2 名最残，不是全队", [of("花子").skill.target, of("花子").skill.count], ["ally_lowest", 2])
  check("风香普技是生命上限最高的那一个", [of("风香").skill.target, of("风香").skill.count], ["ally_maxhp", 1])
  check("绫音普技仍是全体（前锋场地）", of("绫音").skill.target, "ally_all")
  check("绫音普技按 30 秒转，不是看她自己的血量", of("绫音").skill.trigger, { type: "cooldown", turns: 6 })
  check("绫音爱用品是周期暴击抵抗 + 急救状态，不是当场群奶",
    of("绫音").skill.effects.map((e) => e.type), ["buff", "ward"])
  check("急救是生命≤45%消耗、每场一次",
    of("绫音").skill.effects.find((e) => e.type === "ward"),
    { type: "ward", scope: "ally_all", scale: 0.624, source: "heal", hpMax: 0.45, once: true })

  const mains = ["星野", "椿", "优香", "春香"]
  const hurt = (st) => {
    for (const u of st.sides[0].units) u.hp = Math.round(u.maxhp * 0.4)
  }
  const heals = (r, src) => r.events
    .filter((e) => e.type === "heal" && (src == null || e.source?.pos === src))
    .map((e) => e.target.pos).sort((a, b) => a - b)

  const named = setup([...mains, "芹娜", "真白"], ["伊织", "伊织", "伊织", "伊织"])
  hurt(named)
  named.sides[0].cost = 10
  check("芹娜 EX 不接受点名字段",
    validateAction(named, { type: "ex", casts: [{ pos: 4, target: { scope: "ally", idx: 2 } }] }),
    "EX 不能指定目标，只能选择释放者")

  const def = setup([...mains, "芹娜", "真白"], ["伊织", "伊织", "伊织", "伊织"])
  hurt(def)
  def.sides[0].cost = 10
  check("四人同为前排时，芹娜按同排号位优先奶 1 号",
    heals(playerTurn(def, { type: "ex", casts: [{ pos: 4 }] }), 4), [0])

  const positioned = setup(["野宫", "白子", "星野", "伊织", "芹娜", "真白"], ["伊织", "伊织", "伊织", "伊织"])
  hurt(positioned)
  positioned.sides[0].cost = 10
  check("支援治疗按前排 → 中排 → 后排，而不是最低血量/最高攻击",
    heals(playerTurn(positioned, { type: "ex", casts: [{ pos: 4 }] }), 4), [2])

  const fuuka = setup([...mains, "风香", "真白"], ["伊织", "伊织", "伊织", "伊织"])
  hurt(fuuka)
  fuuka.sides[0].cost = 10
  check("风香 EX 奶全部 4 个主力",
    heals(playerTurn(fuuka, { type: "ex", casts: [{ pos: 4 }] }), 4), [0, 1, 2, 3])

  const hanae = setup([...mains, "花江", "真白"], ["伊织", "伊织", "伊织", "伊织"])
  hurt(hanae)
  hanae.sides[0].cost = 10
  const hanaeR = playerTurn(hanae, { type: "ex", casts: [{ pos: 4 }] })
  check("花江 EX 按前排、同排号位顺序只给 1 号上持续治疗",
    hanaeR.state.sides[0].units.map((u) => u.regens.length > 0), [true, false, false, false])

  const putPeroro = (st, idx = 2, hpRate = 0.4) => {
    const maxhp = 10000
    st.sides[0].summons = [{
      summon: true, id: 40002, side: 0, idx, blockIdx: idx,
      hp: Math.round(maxhp * hpRate), maxhp,
      shield: 0, shieldMax: 0, shieldTurns: 0,
      buffs: [], regens: [], dots: [], stun: 0,
      taunt: 0, tauntKind: null, focus: 0,
      turns: 6, turnsMax: 6, st: -1, sourceKey: "test:peroro", alive: true,
    }]
    return st.sides[0].summons[0]
  }

  const dollFirst = setup([...mains, "芹娜", "真白"], ["伊织", "伊织", "伊织", "伊织"])
  hurt(dollFirst)
  const doll = putPeroro(dollFirst)
  dollFirst.sides[0].cost = 10
  const dollHeal = playerTurn(dollFirst, { type: "ex", casts: [{ pos: 4 }] })
  check("治疗型支援的通用位置规则优先选择己方佩洛洛",
    dollHeal.events.some((e) => e.type === "heal" && e.source?.pos === 4 && e.target?.summon), true)
  check("佩洛洛的生命会被实际回复", dollHeal.state.sides[0].summons[0].hp > doll.hp, true)

  const lowest = (dollRate, mainRate) => {
    const st = setup([...mains, "芹娜", "真白"], ["伊织", "伊织", "伊织", "伊织"])
    for (const u of st.sides[0].units) { u.hp = Math.round(u.maxhp * 0.9); u.skillUses = 99 }
    st.sides[0].units[2].hp = Math.round(st.sides[0].units[2].maxhp * mainRate)
    putPeroro(st, 1, dollRate)
    st.sides[0].supports[0].skillCd = 0
    return playerTurn(st, { type: "pass" }).events.find((e) => e.type === "heal" && e.source?.pos === 4)?.target
  }
  check("芹娜普技自带最低血量：主力更残时不会被佩洛洛优先级覆盖",
    lowest(0.8, 0.2), { side: 0, pos: 2 })
  check("芹娜普技自带最低血量：佩洛洛更残时能选中佩洛洛",
    ((x) => x && ({ side: x.side, pos: x.pos, summon: x.summon }))(lowest(0.1, 0.8)),
    { side: 0, pos: 1, summon: true })

  const koharuDoll = setup(["小春", "椿", "优香", "春香"], ["伊织", "伊织", "伊织", "伊织"])
  for (const u of koharuDoll.sides[0].units) { u.hp = u.maxhp; u.skillUses = 99 }
  koharuDoll.sides[0].units[0].skillUses = 0
  koharuDoll.sides[0].units[0].skillCd = 0
  putPeroro(koharuDoll, 1, 0.4)
  const koharuDollR = playerTurn(koharuDoll, { type: "pass" })
  check("小春普技的生命≤50%判定也包含佩洛洛",
    koharuDollR.events.some((e) => e.type === "heal" && e.source?.pos === 0 && e.target?.summon), true)

  const dollRegen = setup([...mains, "花江", "真白"], ["伊织", "伊织", "伊织", "伊织"])
  const regenDoll = putPeroro(dollRegen, 2, 0.2)
  dollRegen.sides[0].cost = 10
  const regenCast = playerTurn(dollRegen, { type: "ex", casts: [{ pos: 4 }] })
  check("持续治疗也能挂到佩洛洛", regenCast.state.sides[0].summons[0].regens.length, 1)
  const beforeTick = regenDoll.hp
  const regenDone = run(regenCast.state, { type: "pass" })
  check("佩洛洛身上的持续治疗会正常跳动", regenDone.state.sides[0].summons[0].hp > beforeTick, true)

  const hanako = setup([...mains, "花子", "真白"], ["伊织", "伊织", "伊织", "伊织"])
  const us = hanako.sides[0].units
  us[0].hp = Math.round(us[0].maxhp * 0.2)
  us[1].hp = Math.round(us[1].maxhp * 0.9)
  us[2].hp = Math.round(us[2].maxhp * 0.3)
  us[3].hp = Math.round(us[3].maxhp * 0.5)
  hanako.sides[0].supports[0].skillCd = 0
  check("花子普技奶最残的两个：星野 + 优香",
    heals(run(hanako, { type: "pass" }), 4), [0, 2])

  const fk = setup([...mains, "风香", "真白"], ["伊织", "伊织", "伊织", "伊织"])
  const fs = fk.sides[0].units
  fs[0].maxhp = 1000; fs[0].hp = 1000
  fs[1].maxhp = 5000; fs[1].hp = 5000
  fs[2].maxhp = 2000; fs[2].hp = 2000
  fs[3].maxhp = 3000; fs[3].hp = 3000
  fk.sides[0].supports[0].skillCd = 0
  const fkR = run(fk, { type: "pass" })
  check("风香普技只给生命上限最高的椿加防",
    fkR.state.sides[0].units.map((u) => u.buffs.some((b) => b.stat === "dfs")),
    [false, true, false, false])

  const muteMains = (st) => { for (const u of st.sides[0].units) u.skillUses = 99 }
  const ayane = () => {
    const st = setup([...mains, "绫音", "真白"], ["伊织", "伊织", "伊织", "伊织"])
    muteMains(st)
    st.sides[0].supports[0].skillCd = 0
    return st
  }
  // 只用 playerTurn：run 会把对面那一轮也打完，伊织可能把人打到 45% 以下、提前消耗急救
  const rFull = playerTurn(ayane(), { type: "pass" })
  check("满血上急救：没人当场回血", heals(rFull, 4), [])
  check("四个主力都挂着急救", rFull.state.sides[0].units.map((u) => Boolean(u.ward)), [true, true, true, true])
  check("周期那段暴击抵抗照样上了",
    rFull.state.sides[0].units.every((u) => u.buffs.some((b) => b.stat === "crit_res")), true)

  const already = ayane()
  already.sides[0].units[1].hp = Math.round(already.sides[0].units[1].maxhp * 0.3)
  const rHurt = playerTurn(already, { type: "pass" })
  check("已残血的人上急救当场消耗回血", heals(rHurt, 4), [1])
  check("消耗过的人不再挂状态，别人还在",
    rHurt.state.sides[0].units.map((u) => Boolean(u.ward)), [true, false, true, true])

  // 不走过对面那一轮：伊织可能把还挂着急救的人打到 45% 以下，干扰「会不会再赋予」
  const again = rHurt.state
  again.activeSide = 0
  again.turnOpen = true
  again.sides[0].supports[0].skillCd = 0
  const rAgain = playerTurn(again, { type: "pass" })
  check("再放一次：消耗过的人不会再拿到急救",
    rAgain.state.sides[0].units.map((u) => Boolean(u.ward)), [true, false, true, true])
}

console.log("\n=== 39b. 非支援位的队友增益：同战场优先，其次最近 ===")
{
  // 当前角色池没有「主力 + 任意队友增益」样本，用一个最小技能模板锁住引擎的未来兼容规则。
  const nonSupport = ROSTER.find((t) => t.name === "野宫")
  const originalSkill = nonSupport.skill
  nonSupport.skill = {
    name: "测试·队友增益",
    target: "ally_single",
    count: 1,
    effects: [{ type: "buff", scope: "ally_target", stat: "atk", value: 0.1, turns: 2 }],
    trigger: { type: "cooldown", turns: 1 },
  }
  try {
    const cast = (killSameField = false) => {
      const st = setup(["星野", "野宫", "白子", "伊织"], ["伊织", "伊织", "伊织", "伊织"])
      if (killSameField) {
        st.sides[0].units[0].alive = false
        st.sides[0].units[0].hp = 0
      }
      st.sides[0].units[1].skillCd = 0
      return playerTurn(st, { type: "pass" }).events
        .find((e) => e.type === "buff" && e.source?.pos === 1)?.target
    }
    check("右边的 3 号更近，但 2 号先选同战场的 1 号", cast(false), { side: 0, pos: 0 })
    check("同战场队友阵亡后，才跨场选距离最近的 3 号", cast(true), { side: 0, pos: 2 })
  } finally {
    nonSupport.skill = originalSkill
  }
}

console.log("\n=== 40. 支援把基础面板按比例转给每个主力 ===")
{
  const of = (n) => ROSTER.find((t) => t.name === n)
  const giftOf = (names) => names.reduce((g, n) => {
    const t = of(n)
    g.hp += t.hp * CFG.SUPPORT_GIFT_HP
    g.atk += t.atk * CFG.SUPPORT_GIFT_ATK
    g.dfs += t.dfs * CFG.SUPPORT_GIFT_DFS
    g.heal += t.healPower * CFG.SUPPORT_GIFT_HEAL
    return g
  }, { hp: 0, atk: 0, dfs: 0, heal: 0 })

  check("PvP 4+2 的官方比例：生命/攻击 10%，防御/治疗 5%",
    [CFG.SUPPORT_GIFT_HP, CFG.SUPPORT_GIFT_ATK, CFG.SUPPORT_GIFT_DFS, CFG.SUPPORT_GIFT_HEAL],
    [0.1, 0.1, 0.05, 0.05])

  const two = setup(["星野", "椿", "优香", "春香", "绫音", "芹娜"], ["伊织", "伊织", "伊织", "伊织", "真白", "花子"])
  const g = giftOf(["绫音", "芹娜"])
  const hoshino = of("星野")
  const u0 = two.sides[0].units[0]
  check("两个支援叠加，生命写进上限", u0.maxhp, hoshino.hp + Math.round(g.hp))
  check("当前生命一起加上去", u0.hp, hoshino.hp + Math.round(g.hp))
  check("四个主力拿到同一份", two.sides[0].units.map((u) => u.gift), [u0.gift, u0.gift, u0.gift, u0.gift])
  check("攻击走 gift，不是主力面板的 10%", atkOf(u0), hoshino.atk + g.atk)
  check("防御 / 治疗力同样按支援自己的基础值转",
    [dfsOf(u0), healOf(u0)], [hoshino.dfs + g.dfs, hoshino.healPower + g.heal])

  check("支援自己拿不到",
    two.sides[0].supports.map((s) => [s.hp, s.maxhp, s.gift, atkOf(s)]),
    two.sides[0].supports.map((s) => {
      const t = tmplOf(s)
      return [t.hp, t.hp, undefined, t.atk]
    }))

  const one = createBattle(
    { uid: "a", name: "蓝", picks: ["星野", "椿", "优香", "春香", "绫音"].map(id) },
    { uid: "b", name: "红", picks: ["伊织", "伊织", "伊织", "伊织"].map(id) },
    { seed: 11, first: 0 }
  )
  const g1 = giftOf(["绫音"])
  check("一个支援就是一份，不会凭空按两个算",
    one.sides[0].units[0].maxhp, hoshino.hp + Math.round(g1.hp))
  check("两份比一份多（叠加成立）",
    two.sides[0].units[0].maxhp > one.sides[0].units[0].maxhp, true)

  const none = createBattle(
    { uid: "a", name: "蓝", picks: ["星野", "椿", "优香", "春香"].map(id) },
    { uid: "b", name: "红", picks: ["伊织", "伊织", "伊织", "伊织"].map(id) },
    { seed: 11, first: 0 }
  )
  check("没有支援就不加",
    [none.sides[0].units[0].maxhp, none.sides[0].units[0].gift, atkOf(none.sides[0].units[0])],
    [hoshino.hp, undefined, hoshino.atk])

  const buffed = setup(["星野", "椿", "优香", "春香", "绫音", "芹娜"], ["伊织", "伊织", "伊织", "伊织"])
  const before = atkOf(buffed.sides[0].units[0])
  buffed.sides[0].units[0].buffs.push({ stat: "atk", value: 1 })
  check("百分比加攻乘在（自身 + 支援转来）上", atkOf(buffed.sides[0].units[0]), before * 2)

  const doll = setup(["日富美", "野宫", "野宫", "野宫", "绫音", "芹娜"], ["伊织", "伊织", "伊织", "伊织"])
  doll.sides[0].cost = 10
  const summoned = playerTurn(doll, { type: "ex", casts: [{ pos: 0 }] })
  const sm = summoned.state.sides[0].summons.find((s) => !s.cover)
  const hifumi = of("日富美")
  const hpRate = hifumi.ex.effects.find((e) => e.type === "summon")?.hpRate || 0
  check("召唤物自己拿不到这份加成", Boolean(sm.gift), false)
  check("人偶生命按日富美模板算，不含编成加成",
    sm.maxhp, Math.round(10 + hifumi.hp * hpRate))
}

console.log("\n=== 43. 支援的刀不被嘲讽拉走，但照吃集火 ===")
{
  /**
   * 两套机制在支援这里正好分道扬镳，跟原作一致：
   *   - **Provoke 是场地性的**：拉的是站在场上的人，支援不在场上 → 该打谁还打谁
   *   - **集火是给己方下的索敌指令**：标在敌人头上、由自己这边全员执行 → 支援照样跟着打
   *
   * 第 37 组管的是「放不放得出 EX」（`exLockedOf`），这一组管的是**落点**（`laneTarget`）。
   * 两条都缺一不可：只免了 EX 锁的话，椿一放嘲讽，支援的普通技能仍会被拽去打椿。
   */

  /** 蓝方这一轮谁打了谁：键是「号位 + 普/技」，值是落点号位串 */
  const shotsOf = (r) => {
    const out = {}
    for (const e of r.events) {
      if (e.type !== "action" || e.source.side !== 0) continue
      out[`${e.source.pos + 1}${e.action === "normal" ? "普" : "技"}`] =
        (e.targets || []).map((t) => (t.summon ? "偶" : t.pos + 1)).join("")
    }
    return out
  }

  /**
   * 蓝方四后排 + 爱理（单体）/ 真白（2 目标）。首轮把支援压住不放，
   * 红方按 exPos 放个 EX（null 就干过），再回到蓝方那一轮量支援的落点。
   */
  const blueShots = (red, exPos = null) => {
    const st = setup(["野宫", "野宫", "野宫", "野宫", "爱理", "真白"], red)
    // 支援的普技冷却起始 = trigger.turns（爱理 5 / 真白 4），首轮先压住
    for (const u of st.sides[0].supports) u.skillCd = 9999
    let cur = run(st, { type: "pass" }).state // 蓝方先手，先过
    cur.sides[1].cost = 10
    if (exPos !== null) {
      const r = playerTurn(cur, { type: "ex", casts: [{ pos: exPos }] })
      if (r.error) throw new Error(`红 ${exPos + 1} 位放不出 EX：${r.error}`)
      cur = r.state
    }
    // 红方收尾交回合（没放 EX 时这一口「过」就是他整个回合）
    while (cur.activeSide === 1 && cur.phase === "command") cur = playerTurn(cur, { type: "pass" }).state
    for (const u of cur.sides[0].supports) u.skillCd = 0 // 这一轮两个支援都出手
    return shotsOf(playerTurn(cur, { type: "pass" }))
  }

  // 红方：星野(前) 1 位、椿(前) 2 位、两个野宫(后) 3·4 位。
  // 进攻支援默认后 → 中 → 前，同排号位小，因此先锁 3 位野宫；椿的场地嘲讽拉不走支援。
  const RED = ["星野", "椿", "野宫", "野宫"]
  const calm = blueShots(RED)
  check("对照组·无嘲讽：主力各打各的战场", [calm["1普"], calm["2普"], calm["3普"], calm["4普"]],
    ["1", "2", "3", "4"])
  check("对照组·无嘲讽：爱理按后排优先打 3 位", calm["5技"], "3")
  check("对照组·无嘲讽：真白从后排主目标铺开打 3·4", calm["6技"], "34")

  const taunt = blueShots(RED, 1)
  check("四个主力被椿全拉走（说明这一轮嘲讽确实生效）",
    [taunt["1普"], taunt["2普"], taunt["3普"], taunt["4普"]], ["2", "2", "2", "2"])
  check("爱理（单体）不被拉走，照打后排 3 位", taunt["5技"], "3")
  // 「嘲讽把整发吸走」的前提是这一发本来就被拉过来了 —— 支援没被拉，范围技当然照常铺开
  check("真白（2 目标）也不被吸成单体，后排 3·4 都吃到", taunt["6技"], "34")

  /**
   * 集火：切里诺的普技把标记打在**攻击力最高**的红方身上（星野 213 < 野宫 321 → 2 位），
   * 而支援默认打的是后排 3 位野宫 —— 集火落 2 位，两者岔开，才量得出支援是否跟标记。
   * ③-a 是先锁目标再一起结算，所以标记要在**上一轮**打出去。
   */
  {
    const st = setup(["切里诺", "野宫", "野宫", "野宫", "爱理", "真白"], ["星野", "野宫", "野宫", "野宫"])
    for (const u of st.sides[0].supports) u.skillCd = 9999
    st.sides[0].units[0].skillCd = 0 // 切里诺首轮就标出去（她的普技只标记，不带伤害）
    let cur = run(st, { type: "pass" }).state
    cur = run(cur, { type: "pass" }).state // 红方过
    check("切里诺的标记落在攻击力最高的 2 位身上（不是最前面的星野）",
      cur.sides[1].units.map((u) => focusedOf(u)), [false, true, false, false])
    for (const u of cur.sides[0].supports) u.skillCd = 0
    const out = shotsOf(playerTurn(cur, { type: "pass" }))
    check("支援吃集火：爱理改打被点名的 2 位", out["5技"], "2")
    check("真白也锁在被点名的人身上", out["6技"], "2")
  }
}


console.log("\n=== 38b. 爱露分段掩体：直击可挡、爆风无视 ===")
{
  const of = (n) => ROSTER.find((t) => t.name === n)
  check("爱露 EX 主段可挡", of("爱露").ex.block, true)
  check("爱露 EX hitBlocks = [直击可挡, 爆风不可挡]", of("爱露").ex.hitBlocks, [true, false])
  check("爱露 EX splashHitBlocks = [爆风不可挡]", of("爱露").ex.splashHitBlocks, [false])
  check("爱露普技同样分段", of("爱露").skill.hitBlocks, [true, false])
  // 真白追伤两段都是直射 Block=1，别被爱露那条改坏
  check("真白 EX 主段可挡", of("真白").ex.block, true)
  check("真白 EX 追伤也可挡", of("真白").ex.bonus.hitBlocks, [true])

  const cover = (red = ["爱露", "野宫", "野宫", "野宫"], lane = 0,
    blue = ["星野", "白子", "千世", "芹香", "静子", "真白"]) => {
    const st = setup(blue, red, [], { fieldCovers: true })
    for (const s of st.sides) for (const u of s.supports) u.skillCd = 9999
    st.sides[0].cost = 10
    const r = playerTurn(st, { type: "ex", casts: [{ pos: 4 }] })
    const placed = r.state.sides[0].summons.find((s) => s.cover && !s.fieldCover)
    // 移动夹具前先清掉目标路原有掩体，维持「同路最多一个」不变量。
    r.state.sides[0].summons = r.state.sides[0].summons.filter((s) =>
      s === placed || !(s.cover && s.blockIdx === lane))
    placed.idx = placed.blockIdx = lane
    const cur = playerTurn(r.state, { type: "pass" }).state
    cur.sides[1].cost = 10
    return cur
  }
  const shotEvents = (r, pos = 0) => r.events.filter((e) =>
    (e.type === "damage" || e.type === "miss") && e.source?.side === 1 && e.source?.pos === pos)
  const landed = (e) => e.target.summon ? "掩体" : String(e.target.pos + 1)
  const skillCover = (st) => st.sides[0].summons.find((s) => s.cover && !s.fieldCover)
  const oldRate = CFG.COVER_BLOCK_RATE
  CFG.COVER_BLOCK_RATE = 1

  try {
    // 同一 strike 内，Block=1 直击由掩体承伤，Block=0 爆风仍落在角色。
    const r = playerTurn(cover(), { type: "ex", casts: [{ pos: 0 }] })
    const ev = shotEvents(r)
    check("爱露 EX：Block=1 直击由掩体承伤，Block=0 爆风打原目标", ev.map(landed), ["掩体", "1"])
    check("爱露 EX：只有掩体承伤事件记录 BLOCK", ev.map((e) => e.blocked || 0), [1, 0])
    check("部分挡只把角色实际承伤画在原目标，并合并 BLOCK 段数",
      [ev[1]?.visualBlocked, ev[1]?.visualHits, ev[1]?.visualLanded], [1, 2, 1])
    const mixedHtml = buildBattleHtml(r.state, r.events)
    check("部分挡的掩体段不另起数字，角色处只保留实际伤害 + BLOCK",
      [(mixedHtml.match(/class="fxstack"/g) || []).length,
        mixedHtml.includes(`<b>${ev[1]?.totalAmount}</b>`), mixedHtml.includes(">BLOCK</i>")],
      [1, true, true])
    const actionEv = r.events.find((e) => e.type === "action" && e.action === "ex" && e.source?.side === 1 && e.source?.pos === 0)
    check("随机格挡不改索敌记录：战场图出手线只指向自动目标",
      actionEv.targets.map((t) => t.summon ? "掩体" : String(t.pos + 1)), ["1"])

    // 所有 EX 共用同一条输入边界：即使目标已倒下，也先因携带 target 字段被拒绝。
    const c = cover(["爱露", "野宫", "野宫", "野宫"], 1)
    c.sides[0].units[0].alive = false
    c.sides[0].units[0].hp = 0
    const action = { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: 0 } }] }
    check("爱露 EX 携带目标字段：直接判非法", validateAction(c, action), "EX 不能指定目标，只能选择释放者")
    const invalid = playerTurn(c, action)
    check("非法 EX 不扣费、不产生事件", [invalid.error?.includes("不能指定目标"), invalid.events?.length || 0], [true, 0])

    // 普技走 ③-a 同时锁定，也必须由 strike 按自己的 hitBlocks 分流承伤。
    const skillState = cover()
    skillState.sides[1].units[0].skillCd = 0
    check("爱露普技：直击由掩体承伤，爆风仍打原目标",
      shotEvents(playerTurn(skillState, { type: "pass" })).map(landed), ["掩体", "1"])

    // Block=0 的普通范围技完全越过掩体。
    const bypass = playerTurn(cover(["明里", "野宫", "野宫", "野宫"]), { type: "ex", casts: [{ pos: 0 }] })
    check("明里 EX Block=0：自动选目标后直接打人", shotEvents(bypass).map(landed), ["1"])
    check("明里 EX Block=0：格挡数为 0", shotEvents(bypass)[0]?.blocked || 0, 0)

    // 连发每枪独立判定；掩体够硬时三枪都由它承伤。
    const chain = cover(["伊织", "野宫", "野宫", "野宫"])
    skillCover(chain).hp = skillCover(chain).maxhp = 1e9
    check("伊织 EX 连发：三枪分别进行 Block=1 判定",
      shotEvents(playerTurn(chain, { type: "ex", casts: [{ pos: 0 }] })).map(landed),
      ["掩体", "掩体", "掩体"])

    // 第一枪打碎掩体后，后两枪必须落回角色，不能继续由一堵 0 血墙吸收。
    const broken = cover(["伊织", "野宫", "野宫", "野宫"])
    skillCover(broken).hp = 1
    check("掩体中途被打碎：后续分段/连发立即落回角色",
      shotEvents(playerTurn(broken, { type: "ex", casts: [{ pos: 0 }] })).map(landed),
      ["掩体", "1", "1"])

    // 强化普攻读取 FormChange 自己的 Block；范围不再因为主目标有掩体而退化成单体。
    const charged = cover(["野宫", "野宫", "野宫", "野宫"], 0,
      ["星野", "鹤城", "千世", "芹香", "静子", "真白"])
    skillCover(charged).hp = skillCover(charged).maxhp = 1e9
    charged.sides[1].units[0].charge = {
      hits: [69.355, 69.355], hitBlocks: [true, true], block: true, count: 2, shots: 1,
    }
    const chargedResult = playerTurn(charged, { type: "pass" })
    const chargedEvents = chargedResult.events.filter((e) =>
      (e.type === "damage" || e.type === "miss") && e.source?.side === 1 && e.source?.pos === 0)
    check("Block=1 范围技：被护主目标由掩体承伤，旁边目标仍正常受伤",
      chargedEvents.map(landed), ["掩体", "2"])

    // 绿逐发换目标；1、4 号位各有掩体，各自在轮到该号位时判定。
    const cycle = cover(["绿", "野宫", "野宫", "野宫"])
    for (const sm of cycle.sides[0].summons.filter((s) => s.cover)) sm.hp = sm.maxhp = 1e9
    for (const u of cycle.sides[0].units) u.hp = u.maxhp = 1e9
    check("绿 EX 循环点名：1、4 号位的分段分别由各自掩体承伤",
      shotEvents(playerTurn(cycle, { type: "ex", casts: [{ pos: 0 }] })).map(landed),
      ["掩体", "2", "3", "掩体", "掩体"])

    // 支援先按位置选人，再由那个人同路的掩体判定；掩体本身不参与索敌。
    const karinOpen = cover(["星野", "野宫", "野宫", "野宫", "花凛", "真白"])
    skillCover(karinOpen).hp = skillCover(karinOpen).maxhp = 1e9
    check("花凛 EX 先选中排 2 号：1 路掩体不会改写索敌",
      shotEvents(playerTurn(karinOpen, { type: "ex", casts: [{ pos: 4 }] }), 4).map(landed), ["2"])
    const karinCovered = cover(["星野", "野宫", "野宫", "野宫", "花凛", "真白"], 1)
    skillCover(karinCovered).hp = skillCover(karinCovered).maxhp = 1e9
    check("花凛 EX 锁定 2 号后，由 2 路掩体承伤",
      shotEvents(playerTurn(karinCovered, { type: "ex", casts: [{ pos: 4 }] }), 4).map(landed), ["掩体"])

    // 全体攻击逐个角色判本路掩体，不会被一堵墙吞成单体。
    const all = cover(["日奈", "野宫", "野宫", "野宫"])
    for (const sm of all.sides[0].summons.filter((s) => s.cover)) sm.hp = sm.maxhp = 1e9
    for (const u of all.sides[0].units) u.hp = u.maxhp = 1e9
    check("日奈 EX enemy_all：1、4 路由掩体承伤，2、3 路仍各自受伤",
      shotEvents(playerTurn(all, { type: "ex", casts: [{ pos: 0 }] })).map(landed).sort(),
      ["2", "3", "掩体", "掩体"].sort())

    // Block=0 场地不替人转移；掩体若在圈里，作为独立构造物另吃一份范围伤害。
    const zoneState = cover(["千世", "野宫", "野宫", "野宫"])
    const cast = run(zoneState, { type: "ex", casts: [{ pos: 0 }] })
    const tick = playerTurn(cast.state, { type: "pass" })
    const hit = tick.events
      .filter((e) => (e.type === "damage" || e.type === "miss") && e.dotIcon === "Zone")
      .map(landed)
    check("千世 EX 场地：每跳重扫时被护的 1 位仍受伤", hit.includes("1"), true)
    check("千世 EX 场地：每跳重扫时掩体本身也受伤", hit.includes("掩体"), true)
  } finally {
    CFG.COVER_BLOCK_RATE = oldRate
  }
}


console.log("\n=== 44. 状态 → 持续治疗 → DoT/场地；场地判闪避与暴击 ===")
{
  const timed = (hp, dots, regen) => {
    const st = setup(["野宫", "野宫", "野宫", "野宫"], OUT)
    const u = st.sides[0].units[0]
    u.maxhp = 1000
    u.hp = hp
    u.dots = dots.map(({ icon, amount }) => ({
      icon, amount, turns: 3, period: 1, tick: 0, attackType: "爆发", st: -1,
    }))
    u.regens = [{ amount: regen, turns: 3, period: 1, tick: 0, st: -1 }]
    return playerTurn(st, { type: "pass" })
  }

  // 同一回合固定为治疗先、伤害性状态后。用治疗上限做出可观测差异：
  // 治疗先：min(1000,950+100)-30-40 = 930；DoT 先则会是 980。
  const survived = timed(950, [
    { icon: "Burn", amount: 30 },
    { icon: "Poison", amount: 40 },
  ], 100)
  const order = survived.events
    .filter((e) => e.target?.side === 0 && e.target?.pos === 0 && (e.dot || e.type === "heal"))
    .map((e) => e.dot ? e.dotIcon : "Regen")
  check("同回合固定顺序：持续治疗 → 灼烧 → 中毒", order, ["Regen", "Burn", "Poison"])
  check("持续治疗先抬满、DoT 后扣，最终 930", survived.state.sides[0].units[0].hp, 930)

  // 治疗可以先把人抬出致死线；伤害性状态仍在最后继续扣血。
  const rescued = timed(50, [
    { icon: "Burn", amount: 30 },
    { icon: "Poison", amount: 40 },
  ], 100)
  check("持续治疗先救起，再承受 DoT", [rescued.state.sides[0].units[0].alive, rescued.state.sides[0].units[0].hp], [true, 80])

  // 治疗后仍不够扛住全部 DoT 时照常死亡；治疗事件必须先出现。
  const dead = timed(50, [
    { icon: "Burn", amount: 30 },
    { icon: "Poison", amount: 40 },
  ], 10)
  const deadUnit = dead.state.sides[0].units[0]
  check("治疗后仍被 DoT 击倒", [deadUnit.alive, deadUnit.hp, deadUnit.regens.length], [false, 0, 0])
  check("致死回合治疗事件在 DoT 之前已经发生",
    dead.events.filter((e) => e.target?.side === 0 && e.target?.pos === 0 && (e.dot || e.type === "heal"))
      .map((e) => e.dot ? e.dotIcon : "Regen"), ["Regen", "Burn", "Poison"])

  // 跳动归属是承受者自己的回合；从施加者视角才叫“对面回合结束”。
  {
    const st = setup(["星野", "野宫", "野宫", "野宫"], OUT)
    const u = st.sides[0].units[0]
    u.maxhp = u.hp = 1e9
    u.dots = [{ icon: "Poison", amount: 10, turns: 3, period: 1, tick: 0, attackType: "爆发", st: -1 }]
    u.regens = [{ amount: 10, turns: 3, period: 1, tick: 0, st: -1 }]
    st.activeSide = 1
    const enemyTurn = playerTurn(st, { type: "pass" })
    check("敌方行动回合结束：我方承受者的 DoT / Regen 不跳",
      [enemyTurn.state.sides[0].units[0].dots[0].tick, enemyTurn.state.sides[0].units[0].regens[0].tick], [0, 0])
    const ownTurn = playerTurn(enemyTurn.state, { type: "pass" })
    check("轮到承受者自己的回合结束才一起跳",
      [ownTurn.state.sides[0].units[0].dots[0].tick, ownTurn.state.sides[0].units[0].regens[0].tick], [1, 1])
  }

  // 进行中的旧对局仍是「无伤害参数的 field + 人身上的 Zone DoT」；升级后要照旧结算，不能双跳或崩档。
  {
    const st = setup(["星野", "野宫", "野宫", "野宫"], OUT)
    const u = st.sides[0].units[0]
    u.maxhp = u.hp = 1e9
    u.dots = [{ icon: "Zone", amount: 10, turns: 2, period: 1, tick: 0, attackType: "爆发", st: -1 }]
    st.sides[0].fields = [{ lo: 0, hi: 1, turns: 2, st: -1 }]
    const r = playerTurn(st, { type: "pass" })
    const ev = r.events.find((e) => e.dotIcon === "Zone")
    const field = r.state.sides[0].fields[0]
    check("旧存档的单位 Zone DoT 继续结算，旧 field 只负责圈的倒计时",
      [ev?.totalAmount, field?.turns, field?.icon ?? null], [10, 1, null])
  }

  // 原数据的固定场地是 DMGZone + CriticalCheck:Check：保留每个 HitFrame 的命中 / 暴击判定。
  {
    const chise = ROSTER.find((t) => t.name === "千世")
    const zone = chise.ex.effects.find((e) => e.icon === "Zone")
    check("千世场地保留 11 个原始伤害段，并按 5 秒分成 6+5",
      zone.tickHits.map((x) => x.length), [6, 5])
    check("场地允许闪避和暴击", [zone.canEvade, zone.canCrit, zone.alwaysCrit], [true, true, false])
  }

  // 运行路径：场地能出现部分闪避，也能出现暴击；中毒即使对高闪目标也固定命中且不暴击。
  {
    const chise = ROSTER.find((t) => t.name === "千世")
    const zoneSample = (seed, { crit = false } = {}) => {
      const st = setup(["优香", "野宫", "野宫", "野宫"], ["千世", "野宫", "野宫", "野宫"])
      const src = st.sides[1].units[0]
      const tgt = st.sides[0].units[0]
      for (const s of st.sides) for (const u of s.units) { u.maxhp = 1e9; u.hp = 1e9 }
      // 不让普通行动干扰目标；只读回合末的 Zone 事件。
      for (const s of st.sides) for (const u of s.units) u.skillCd = 9999
      if (crit) src.buffs.push({ stat: "crit", value: 1e6, turns: 99, st: -1 })
      st.sides[0].fields = [{
        lo: 0, hi: 0,
        icon: "Zone", scale: 1, tickHits: [[50, 50, 50, 50, 50, 50]],
        canCrit: true, alwaysCrit: false, canEvade: !crit, applyStability: false,
        turns: 2, period: 1, tick: 0, sourceId: src.id, sourceSide: 1, sourcePos: 0,
        sourceAtk: atkOf(src), sourceAcc: src.acc, sourceCrit: src.crit, sourceCritDmg: src.critDmg,
        sourceDealF: 1, sourceStabilityFloor: 1, sourceBullet: chise.bullet,
        attackType: chise.atkType, st: -1,
      }]
      st.rng = seed >>> 0
      const r = playerTurn(st, { type: "pass" })
      return r.events.find((e) => (e.type === "damage" || e.type === "miss") && e.dotIcon === "Zone")
    }
    let total = 0, landed = 0
    for (let seed = 1; seed <= 120; seed++) {
      const e = zoneSample(seed)
      total += e?.hits || 0
      landed += e?.landed || 0
    }
    check("场地逐段做闪避判定（高闪目标既有命中也有落空）", landed > 0 && landed < total, true)
    const crit = zoneSample(9, { crit: true })
    check("场地逐段允许暴击", [crit?.crit, crit?.critHits, crit?.hits], [true, 6, 6])

    const st = setup(["优香", "野宫", "野宫", "野宫"], ["绿", "野宫", "野宫", "野宫"])
    const src = st.sides[1].units[0]
    const tgt = st.sides[0].units[0]
    for (const s of st.sides) for (const u of s.units) { u.maxhp = 1e9; u.hp = 1e9; u.skillCd = 9999 }
    src.buffs.push({ stat: "crit", value: 1e6, turns: 99, st: -1 })
    tgt.buffs.push({ stat: "dodge", value: 1e6, turns: 99, st: -1 })
    tgt.dots = [{
      icon: "Poison", scale: 1, canCrit: false, canEvade: false, applyStability: false,
      turns: 2, period: 1, tick: 0, sourceId: src.id, sourceSide: 1, sourcePos: 0,
      sourceAtk: atkOf(src), sourceDealF: 1, sourceStabilityFloor: 1,
      sourceBullet: ROSTER.find((t) => t.name === "绿").bullet,
      attackType: ROSTER.find((t) => t.name === "绿").atkType, st: -1,
    }]
    const poison = playerTurn(st, { type: "pass" }).events.find((e) => e.dotIcon === "Poison")
    check("中毒不判闪避且不暴击", [poison?.type, poison?.landed, poison?.crit], ["damage", 1, false])
  }

  // 周期伤害读取结算时的当前攻防 / 增伤减伤，而不是永远用施放瞬间的固定数值。
  {
    const periodicDamage = ({ sourceBuff = null, targetBuff = null } = {}) => {
      const st = setup(["星野", "野宫", "野宫", "野宫"], ["千世", "野宫", "野宫", "野宫"])
      const src = st.sides[1].units[0]
      const tgt = st.sides[0].units[0]
      for (const s of st.sides) for (const u of s.units) { u.maxhp = 1e9; u.hp = 1e9; u.skillCd = 9999 }
      if (sourceBuff) src.buffs.push({ ...sourceBuff, turns: 99, st: -1 })
      if (targetBuff) tgt.buffs.push({ ...targetBuff, turns: 99, st: -1 })
      st.sides[0].fields = [{
        lo: 0, hi: 0,
        icon: "Zone", scale: 1, tickHits: [[100]], canCrit: false, canEvade: false, applyStability: false,
        turns: 2, period: 1, tick: 0, sourceId: src.id, sourceSide: 1, sourcePos: 0,
        sourceAtk: atkOf(src), sourceDealF: 1, sourceStabilityFloor: 1,
        sourceBullet: ROSTER.find((t) => t.name === "千世").bullet,
        attackType: ROSTER.find((t) => t.name === "千世").atkType, st: -1,
      }]
      const r = playerTurn(st, { type: "pass" })
      return r.events.find((e) => e.dotIcon === "Zone")?.totalAmount || 0
    }
    const base = periodicDamage()
    const boosted = periodicDamage({ sourceBuff: { stat: "dmg_deal", value: 1 } })
    const defended = periodicDamage({ targetBuff: { stat: "dfs", value: 1 } })
    check("场地读取当前增伤：+100% 造成约双倍", Math.abs(boosted / base - 2) < 0.02, true)
    check("场地读取当前防御：增防后伤害下降", defended < base, true)
  }

  // 状态格按类型分组：两个灼烧合成一格 ×2，中毒单独一格，不能共用一个火苗。
  {
    const st = setup(["星野", "野宫", "野宫", "野宫"], OUT)
    st.sides[0].units[0].dots = [
      { icon: "Burn", amount: 1, turns: 3, period: 1, tick: 0, st: -1 },
      { icon: "Burn", amount: 1, turns: 2, period: 1, tick: 0, st: -1 },
      { icon: "Poison", amount: 1, turns: 4, period: 1, tick: 0, st: -1 },
    ]
    const burn = statusIconOf("burn")
    const poison = statusIconOf("debuff-poison")
    const html = buildBattleHtml(st)
    const countOf = (x) => x ? html.split(x).length - 1 : 0
    check("灼烧 / 中毒资源都存在且不是同一张", [Boolean(burn), Boolean(poison), burn !== poison], [true, true, true])
    check("战场图各使用一次独立图标", [countOf(burn), countOf(poison)], [1, 1])
    check("只有同类型的两个灼烧合并 ×2", html.split("<s>×2</s>").length - 1, 1)
  }
}

console.log(bad ? `\n✗ ${bad} 条不符` : "\n全部符合")
process.exit(bad ? 1 : 0)
