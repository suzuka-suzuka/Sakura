/**
 * 战场分割与对线锁定的规则回归。
 *
 * 这几条规则很容易在改目标选择时被悄悄改坏，而压测只看不变量、看不出「打错人」，
 * 所以单独写成断言。改 laneTarget / expandAdjacent / resolveTargets 之后必跑：
 *
 *   node scripts/target-test.mjs
 */
import { createBattle, playerTurn, validateAction, exCastableOf, exWaitOf, exCostOf, tmplOf, provokedBy, focusedOf, exLockedOf, exSealedOf, autoProcChance } from "../lib/ba/engine.js"
import { ROSTER } from "../lib/ba/roster.js"
import { describeEffect } from "../lib/ba/format.js"

const id = (n) => ROSTER.find((t) => t.name === n).id

/** 建一局并按 kill 列表把人打死（kill 是 [side, idx] 列表） */
function setup(bluePicks, redPicks, kills = []) {
  const st = createBattle(
    { uid: "a", name: "蓝", picks: bluePicks.map(id) },
    { uid: "b", name: "红", picks: redPicks.map(id) },
    { seed: 11, first: 0 }
  )
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
const pickIdx = (st, idx) => {
  const r = run(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx } }] })
  return r.events.find((e) => e.type === "action" && e.action === "ex").targets.map((t) => t.pos + 1)
}
check("指定红3 → 波及红4", pickIdx(setup(TANK1, OUT), 2), [3, 4])
check("指定红1 → 波及红2，不碰 3·4", pickIdx(setup(TANK1, OUT), 0), [1, 2])
check("红4 已阵亡，指定红3 → 退化成单体", pickIdx(setup(TANK1, OUT, [[1, 3]]), 2), [3])

console.log("\n=== 6. 野宫全体技能仍然打 4 个 ===")
const allSt = setup(["野宫", "星野", "野宫", "野宫"], OUT)
const rAll = run(allSt, { type: "ex", casts: [{ pos: 0 }] })
check("敌方全体命中数",
  rAll.events.find((e) => e.type === "action" && e.action === "ex").targets.length, 4)

console.log("\n=== 7. 3 目标技能走「以主目标为中心的固定窗口」（睦月）===")
const mutsuki = (idx) => {
  const st = setup(["睦月", "野宫", "野宫", "野宫"], OUT)
  const r = run(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx } }] })
  return r.events.find((e) => e.type === "action" && e.action === "ex").targets
    .map((t) => t.pos + 1).sort()
}
check("指定 1 号位 → 越界那发浪费，只炸 2 个", mutsuki(0), [1, 2])
check("指定 2 号位 → 炸满 3 个且跨战场", mutsuki(1), [1, 2, 3])
check("指定 3 号位 → 炸满 3 个且跨战场", mutsuki(2), [2, 3, 4])
check("指定 4 号位 → 只炸 2 个", mutsuki(3), [3, 4])
// 2 目标技能的战场分割限制不受影响，第 5 组已经断言过，这里再钉一次边界
check("2 目标技能仍然不跨战场（星野指定 2 位）", pickIdx(setup(TANK1, OUT), 1).sort(), [1, 2])

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
check("星野 EX 指中排 · 前+中 → 越过去只打中排", pickIdx(setup(["星野", "野宫", "野宫", "野宫"], ["星野", "白子", "野宫", "野宫"]), 1), [2])
check("千世普攻 · 两个后排 → 两个都打", chiseAA(OUT), [1, 2])
check("千世普攻 · 前+中 → 只打前排", chiseAA(["星野", "白子", "野宫", "野宫"]), [1])
check("千世普攻 · 中+后 → 只打中排", chiseAA(["白子", "野宫", "野宫", "野宫"]), [1])
{
  const mutsukiMix = (red, idx) => {
    const st = setup(["睦月", "野宫", "野宫", "野宫"], red)
    const r = run(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx } }] })
    return r.events.find((e) => e.type === "action" && e.action === "ex").targets
      .map((t) => t.pos + 1).sort()
  }
  // 指定中排 2 位，窗口 {1,2,3}：前 / 中 / 前 → 只打被点的那一层中排
  check("睦月 3 目标 · 指定中排 → 越过前排只打中排",
    mutsukiMix(["星野", "白子", "鹤城", "野宫"], 1), [2])
  // 指定前排 2 位，窗口里两个前排夹一个中排
  check("睦月 3 目标 · 指定前排 · 窗口两个前排 → 打两个前排",
    mutsukiMix(["星野", "鹤城", "春香", "野宫"], 1), [1, 2, 3])
  // 指定前排，窗口里只有她一个前排
  check("睦月 3 目标 · 指定前排 · 旁边都是中后 → 退化成单体",
    mutsukiMix(["星野", "白子", "芹香", "野宫"], 0), [1])
}

console.log("\n=== 5c. 直线贯穿 / 场地盖战场 / 堇连发 ===")
function exHits(who, red, idx) {
  const st = setup([who, "野宫", "野宫", "野宫"], red)
  st.sides[0].cost = 10
  const r = run(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx } }] })
  return (r.events.find((e) => e.type === "action" && e.action === "ex")?.targets || [])
    .map((t) => (t.summon ? "偶" : t.pos + 1))
}
check("晴奈直线 · 前+中 指定前 → 两个都打",
  exHits("晴奈", ["星野", "白子", "野宫", "野宫"], 0).sort(), [1, 2])
check("纯子直线 · 窗口前/中/前 → 三个都打",
  exHits("纯子", ["星野", "白子", "鹤城", "野宫"], 1).sort(), [1, 2, 3])
check("爱露二段 · 前+中 指定前 → 不同层吃不到溅射",
  exHits("爱露", ["星野", "白子", "野宫", "野宫"], 0).sort(), [1])
check("爱露二段 · 两个前排 → 第二人吃溅射",
  exHits("爱露", ["星野", "鹤城", "野宫", "野宫"], 0).sort(), [1, 2])
check("日富美 EX · 指定中排 · 前中前 → 横向只打中排",
  exHits("日富美", ["星野", "白子", "鹤城", "野宫"], 1).sort(), [2])
{
  const st = setup(["千世", "野宫", "野宫", "野宫"], ["星野", "白子", "野宫", "野宫"])
  st.sides[0].cost = 10
  const r = run(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: 0 } }] })
  const burned = r.state.sides[1].units
    .map((u, i) => (u.dots.some((d) => d.icon === "Zone") ? i + 1 : null))
    .filter(Boolean)
  check("千世场地 · 前+中 同战场两路都烧", burned, [1, 2])
}
function sumireShots(pickIdx) {
  const st = setup(["堇", "野宫", "野宫", "野宫"], OUT)
  st.sides[0].cost = 10
  const r = run(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: pickIdx } }] })
  return r.events.filter((e) => e.type === "damage" && e.source?.side === 0 && e.source.pos === 0)
    .map((e) => e.target.pos + 1)
}
check("堇 EX 连发 · 指定 1 位 → 三发全在 1", sumireShots(0), [1, 1, 1])
check("堇 EX 连发 · 指定另一战场 → 后两发回本战场对位", sumireShots(2), [3, 1, 1])

console.log("\n=== 8. 召唤物挡刀（日富美的佩洛洛人偶）===")
/** 蓝1 = 日富美，EX 把人偶扔向红方 blockIdx 号位，返回随后红方普攻的 源→目标 */
function withDoll(blockIdx, skipTaunt) {
  const st = setup(["日富美", "野宫", "野宫", "野宫"], OUT)
  run(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: blockIdx } }] })
  let cur = run(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: blockIdx } }] }).state
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
check("嘲讽过后扔进 3·4 战场：红3 红4 都打人偶", withDoll(2, true), ["1→1", "2→1", "3→偶", "4→偶"])
// 人偶比前排还靠前：同战场有星野也照样先打人偶
{
  const st = setup(["日富美", "野宫", "野宫", "野宫"], TANK1)
  st.sides[0].cost = 10
  let cur = run(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: 0 } }] }).state
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
// 睦月指 4 位 → 窗口 {3,4} 只在 3·4 战场，1·2 那边的墙够不着
check("睦月 3 目标 · 指 4 位、人偶在 1·2 战场 → 拦不住", skillVsDoll("睦月", 3, 0).sort(), [3, 4])
// 白子在 1 位 → 2 目标，覆盖面就是主目标那个战场
check("白子 2 目标 · 人偶挡 2 位（同战场）", skillVsDoll("白子", 0, 1), ["偶"])
check("白子 2 目标 · 人偶挡 3 位（另一战场）", skillVsDoll("白子", 0, 2).sort(), [1, 2])

console.log("\n=== 10. 伊织 EX：只有第一发听指挥，后两发按普攻规则重锁 ===")
/** 伊织在 1 位，指定 pickIdx；kill 是开局就打死的号位，doll 是人偶挡的号位 */
function iori(pickIdx, kill = [], doll = null) {
  const st = setup(["伊织", "日富美", "野宫", "芹香"], FOE, kill.map((k) => [1, k]))
  st.sides[0].cost = 10
  if (doll != null) {
    st.sides[1].summons = [{
      summon: true, id: 40002, side: 1, idx: doll, blockIdx: doll,
      hp: 99999, maxhp: 99999, shield: 0, shieldMax: 0, shieldTurns: 0,
      buffs: [], regens: [], stun: 0, taunt: 0, turns: 6, st: -1, sourceKey: "x", alive: true,
    }]
  }
  const r = run(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: pickIdx } }] })
  return r.events.filter((e) => e.type === "damage" && e.source.side === 0 && e.source.pos === 0)
    .map((e) => (e.target.summon ? "偶" : e.target.pos + 1))
}
// 后两发不再「不能和上一发相同」：普攻锁谁就锁谁，锁定的人没死就连吃三发
check("指定同战场的 1 位 → 三发全在 1（对位）", iori(0), [1, 1, 1])
check("指定另一战场的 3 位 → 后两发回到本战场对位", iori(2), [3, 1, 1])
check("本战场只剩 1 位 → 后两发继续打它", iori(0, [1]), [1, 1, 1])
check("人偶在本战场 → 后两发全被它接走", iori(0, [], 0), [1, "偶", "偶"])
check("人偶挡另一路（同战场）→ 一样接走后两发", iori(0, [], 1), [1, "偶", "偶"])
check("人偶在另一战场 → 本战场还有人时不接", iori(0, [], 2), [1, 1, 1])
check("本战场打空 + 人偶在本战场 → 后两发全打人偶", iori(2, [0, 1], 0), [3, "偶", "偶"])
check("本战场打空 + 人偶在另一战场 → 越界前先拆墙，后两发都在墙上", iori(2, [0, 1], 2), [3, "偶", "偶"])
// 有前排就后两发都落前排身上（敌 1 位放星野，伊织在 1 位）
check("同战场有前排 → 后两发都打前排", (() => {
  const st = setup(["伊织", "日富美", "野宫", "芹香"], TANK1)
  st.sides[0].cost = 10
  const r = run(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: 1 } }] })
  return r.events.filter((e) => e.type === "damage" && e.source?.side === 0 && e.source.pos === 0)
    .map((e) => e.target.pos + 1)
})(), [2, 1, 1])
// 打死锁定的人会自动换目标：这条机制还在
check("对位被打死 → 后面的发数换成同战场另一个", (() => {
  const st = setup(["伊织", "日富美", "野宫", "芹香"], FOE)
  st.sides[0].cost = 10
  st.sides[1].units[0].hp = 1 // 第一发就能打死红1
  const r = run(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: 0 } }] })
  return r.events.filter((e) => e.type === "damage" && e.source?.side === 0 && e.source.pos === 0)
    .map((e) => e.target.pos + 1)
})(), [1, 2, 2])
// 战场图按 action.targets 画线：必须是实际打到的人，不能只写 resolveTargets 给出的第一发
{
  const st = setup(["伊织", "日富美", "野宫", "芹香"], FOE)
  st.sides[0].cost = 10
  st.sides[1].units[0].hp = 1
  const r = run(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: 0 } }] })
  const ev = r.events.find((e) => e.type === "action" && e.action === "ex" && e.source.pos === 0)
  check("换过目标后 action.targets 两个人都在",
    (ev?.targets || []).map((t) => t.pos + 1).sort(), [1, 2])
}

console.log("\n=== 11. 千世场地：盖在生效范围，人死不转移 ===")
function chiseCast(kills = [], pick = 0) {
  const st = setup(["千世", "野宫", "野宫", "野宫"], OUT, kills)
  st.sides[0].cost = 10
  return run(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: pick } }] })
}
const zoneOn = (side) => side.units
  .filter((u) => (u.dots || []).some((d) => d.icon === "Zone"))
  .map((u) => u.idx + 1)
const kill = (st, idx) => {
  const u = st.sides[1].units[idx]
  u.alive = false
  u.hp = 0
  u.dots = []
}

const drop = chiseCast()
check("指定红1 → 地上的圈盖住 1·2 整个战场", drop.state.sides[1].fields, [{ lo: 0, hi: 1, turns: 2, st: drop.state.turnId }])
check("指定红1 → 当时站在里面的 1·2 挨烧", zoneOn(drop.state.sides[1]), [1, 2])
check("指定红1 → 另一战场的 3·4 没有场地", zoneOn(drop.state.sides[1]).includes(3) || zoneOn(drop.state.sides[1]).includes(4), false)

const emptyNeighbor = chiseCast([[1, 1]])
check("红2 已死再打红1 → 圈仍盖 1·2（生效范围，不缩成单体）",
  emptyNeighbor.state.sides[1].fields.map((f) => [f.lo, f.hi]), [[0, 1]])
check("红2 已死再打红1 → 只有红1 身上有 DoT", zoneOn(emptyNeighbor.state.sides[1]), [1])

const afterKill = chiseCast()
kill(afterKill.state, 0)
const afterRed = playerTurn(afterKill.state, { type: "pass" })
check("场里红1 死后，圈还在原处 1·2", afterRed.state.sides[1].fields.map((f) => [f.lo, f.hi]), [[0, 1]])
check("场里红1 死后，不会把 DoT 转给 3·4", zoneOn(afterRed.state.sides[1]), [2])

const bothDead = chiseCast()
kill(bothDead.state, 0)
kill(bothDead.state, 1)
const afterEmpty = playerTurn(bothDead.state, { type: "pass" })
check("场里两人都死后，圈仍留在 1·2", afterEmpty.state.sides[1].fields.map((f) => [f.lo, f.hi]), [[0, 1]])
check("场里两人都死后，3·4 不会走进空场地", zoneOn(afterEmpty.state.sides[1]), [])
check("EX 不是 debuff：身上不加 buff", drop.state.sides[1].units.every((u) => !(u.buffs || []).length), true)
check("EX 不是 debuff：不发 debuff 事件", drop.events.some((e) => e.type === "debuff"), false)
check("EX 的持续伤害标成 Zone，不是灼烧",
  drop.state.sides[1].units.filter((u) => (u.dots || []).length)
    .every((u) => u.dots.every((d) => d.icon === "Zone")), true)

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

console.log("\n=== 13. 指定目标已死：按施法者同战场对线，空了越界打最近 ===")
/** 真纪 1 位 + 茜 4 位都点名打红1。kills 是开局已死的红方号位（0-based） */
function stackedEx(kills = [], hp0 = 1) {
  const st = setup(["真纪", "野宫", "野宫", "茜"], ["白子", "星野", "日奈", "爱露"], kills.map((i) => [1, i]))
  if (st.sides[1].units[0].alive) st.sides[1].units[0].hp = hp0
  const first = playerTurn(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: 0 } }] })
  const second = playerTurn(first.state, { type: "ex", casts: [{ pos: 3, target: { scope: "foe", idx: 0 } }] })
  const akane = second.events.find((e) => e.type === "action" && e.action === "ex" && e.source.pos === 3)
  return (akane?.targets || []).map((t) => t.pos + 1)
}
check("红1 被真纪秒了，茜仍点红1 → 打茜自己同战场的红4", stackedEx(), [4])
// 只放茜，避免真纪先把红2 也打掉。红1 已死、茜这边 3·4 也空，只剩红2
const onlyAkane = (() => {
  const st = setup(["野宫", "野宫", "野宫", "茜"], ["白子", "星野", "日奈", "爱露"], [[1, 0], [1, 2], [1, 3]])
  const r = playerTurn(st, { type: "ex", casts: [{ pos: 3, target: { scope: "foe", idx: 0 } }] })
  const ev = r.events.find((e) => e.type === "action" && e.action === "ex" && e.source.pos === 3)
  return (ev?.targets || []).map((t) => t.pos + 1)
})()
check("红1 已死且茜这边 3·4 也空 → 越界打最近的红2", onlyAkane, [2])

const two = setup(["真纪", "野宫", "野宫", "茜"], ["白子", "星野", "日奈", "爱露"])
const rejected = playerTurn(two, {
  type: "ex",
  casts: [
    { pos: 0, target: { scope: "foe", idx: 0 } },
    { pos: 3, target: { scope: "foe", idx: 0 } },
  ],
})
check("一条指令两个 EX 被拒绝", Boolean(rejected.error), true)
check("放完一个 EX 且还能再放时回合还开着",
  playerTurn(setup(["真纪", "野宫", "野宫", "茜"], ["白子", "星野", "日奈", "爱露"]), {
    type: "ex", casts: [{ pos: 3, target: { scope: "foe", idx: 0 } }],
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
  const first = playerTurn(leftover(2), { type: "ex", casts: [{ pos: 0 }] })
  check("剩 2 人放完茜，回合还开着", first.state.turnOpen, true)
  check("剩 2 人放完茜，茜仍在可放名单", exCastableOf(first.state, 0).includes(0), true)
  const second = playerTurn(first.state, { type: "ex", casts: [{ pos: 0 }] })
  check("剩 2 人同一人连放不报错", Boolean(second.error), false)
  check("剩 2 人第二发仍是茜的 EX",
    second.events.some((e) => e.type === "action" && e.action === "ex" && e.source.pos === 0), true)
}
{
  const first = playerTurn(leftover(1), { type: "ex", casts: [{ pos: 0 }] })
  check("剩 1 人放完回合还开着", first.state.turnOpen, true)
  check("剩 1 人放完仍能再放", exCastableOf(first.state, 0).includes(0), true)
  const second = playerTurn(first.state, { type: "ex", casts: [{ pos: 0 }] })
  check("剩 1 人连放不报错", Boolean(second.error), false)
}
{
  const first = playerTurn(leftover(3), { type: "ex", casts: [{ pos: 0 }] })
  check("剩 3 人放完 1 不能立刻再放 1", exCastableOf(first.state, 0).includes(0), false)
  const second = playerTurn(first.state, { type: "ex", casts: [{ pos: 1 }] })
  check("剩 3 人放完 1→2 之后 1 解锁", exCastableOf(second.state, 0).includes(0), true)
  const third = playerTurn(second.state, { type: "ex", casts: [{ pos: 0 }] })
  check("剩 3 人 1→2→1 不报错", Boolean(third.error), false)
  check("剩 3 人第三发仍是 1 的 EX",
    third.events.some((e) => e.type === "action" && e.action === "ex" && e.source.pos === 0), true)
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
  check("先手带瞬 → 开局 Cost 0+2", st.sides[0].cost, 2)
  check("对面没瞬 → 只有后手补偿 2", st.sides[1].cost, 2)
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
  check("按发数存续，不带 turns", afterPass.state.sides[0].units[0].charge, { hits: [69.355, 69.355], count: 2, shots: 1 })
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
  const r = run(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: 1 } }] })
  check("按当前生命扣 25.7%", Math.round(before - J(r.state).hp), Math.round(before * 0.257))
  const ev = r.events.find((e) => e.type === "damage" && !e.source)
  check("自伤事件不带施法者（战场图不画连线），走持续伤害那套配色",
    ev && [ev.source, ev.dot, ev.attackType], [null, true, "自伤"])
  check("直线 3 目标以主目标为中心，主目标排第一",
    r.events.find((e) => e.type === "action" && e.action === "ex").targets.map((x) => x.pos + 1), [2, 1, 3])

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
    check("椿接手之后人偶身上的嘲讽已清零", cur.sides[1].summons[0].taunt, 0)
    check("同一方同时只有一个嘲讽目标",
      cur.sides[1].units.filter((u) => u.taunt > 0).length + cur.sides[1].summons.filter((s) => s.taunt > 0).length, 1)
  }

  // 嘲讽压过挡刀：人偶还杵在 1 号位，但椿后放，刀就该落在椿身上
  {
    const st = setup(OUT, ["椿", "日富美", "野宫", "野宫"])
    st.sides[1].cost = 10
    let cur = run(st, { type: "pass" }).state
    cur = playerTurn(cur, { type: "ex", casts: [{ pos: 1, target: { scope: "foe", idx: 0 } }] }).state
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
  check("蓝方可放名单是空的", exCastableOf(taunted, 0), [])
  check("全员被封（提示用）", exSealedOf(taunted, 0), true)
  check("点名放 EX 会被拦", validateAction(taunted, { type: "ex", casts: [{ pos: 0 }] }),
    "野宫 被嘲讽，放不出 EX")
  check("「过」仍然合法", validateAction(taunted, { type: "pass" }), null)

  const afterPass = playerTurn(taunted, { type: "pass" })
  check("被嘲讽的那一轮普通技能和普攻照跑（不进 stun）",
    afterPass.events.some((e) => e.type === "action" && e.action === "normal" && e.source.side === 0), true)
  check("发「过」才交回合", [afterPass.state.activeSide, afterPass.state.turnOpen], [1, false])

  const doll = handoff(["日富美", "野宫", "野宫", "野宫"], 0)
  check("人偶入场嘲讽同样封 EX", exSealedOf(doll, 0), true)
  check("人偶嘲讽下也放不出", validateAction(doll, { type: "ex", casts: [{ pos: 2 }] }),
    "野宫 被嘲讽，放不出 EX")

  const feared = handoff(["佳代子", "野宫", "野宫", "野宫"], 0)
  check("佳代子 EX 恐惧也封 EX", feared.sides[0].units.map((u) => exLockedOf(feared, u)),
    ["恐惧", "恐惧", "恐惧", "恐惧"])
  check("恐惧下全员被封", exSealedOf(feared, 0), true)
  check("恐惧下点名放 EX 会被拦", validateAction(feared, { type: "ex", casts: [{ pos: 0 }] }),
    "野宫 被恐惧，放不出 EX")
  const fearedPass = playerTurn(feared, { type: "pass" })
  check("恐惧那一轮普攻被跳过",
    fearedPass.events.some((e) => e.type === "action" && e.action === "normal" && e.source.side === 0), false)
}

console.log("\n=== 28. 攻速只乘普攻，不乘 EX / 普通技能 ===")
{
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
  check("普攻吃攻速层（+100% 正好翻倍）", [aa0, aa1], [aa0, aa0 * 2])

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

console.log("\n=== 32. 泉奈的位移：与相邻一格的队友交换站位 ===")
{
  // 号位不变量：units[i].idx === i。换位必须同时换数组槽和 idx，否则下标索引全乱
  const order = (st) => st.sides[0].units.map((u) => tmplOf(u).name)
  const idxOk = (st) => st.sides[0].units.every((u, i) => u.idx === i)
  const cast = (st, to) => run(st, { type: "ex", casts: [{ pos: st.sides[0].units.findIndex((u) => u.id === id("泉奈")), ...(to ? { target: { scope: "ally", idx: to } } : {}) }] })

  const base = () => setup(["泉奈", "椿", "野宫", "茜"], ["茜", "茜", "茜", "茜"])

  const a = cast(base(), 1)
  check("跟 2 号位换：站位互调", order(a.state), ["椿", "泉奈", "野宫", "茜"])
  check("units[i].idx === i 仍成立", idxOk(a.state), true)
  check("同战场内换，两人都还在 1 战场", [a.state.sides[0].units[0].idx, a.state.sides[0].units[1].idx], [0, 1])

  // 2 号位 → 3 号位是唯一跨得过战场分界的那一跳
  const st2 = setup(["椿", "泉奈", "野宫", "茜"], ["茜", "茜", "茜", "茜"])
  const b = cast(st2, 2)
  check("站 2 号位跳 3 号位：跨过战场分界", order(b.state), ["椿", "野宫", "泉奈", "茜"])
  check("日志写明跨了战场", b.log.some((l) => /跨过战场分界/.test(l)), true)

  // 不相邻的要在校验层就拦下来，别扣了 Cost 才发现没动
  const st3 = base()
  check("换到不相邻的一格：直接报错，不扣 Cost",
    validateAction(st3, { type: "ex", casts: [{ pos: 0, target: { scope: "ally", idx: 3 } }] }),
    "茜 不在 泉奈 隔壁，位移只能跟相邻的一格换")
  check("不指定就不动", order(cast(base(), null).state), ["泉奈", "椿", "野宫", "茜"])

  // turnEx 是按号位记的：不跟着换的话，换完位的泉奈会被当成没放过 EX 而多打一枪
  const c = playerTurn(base(), { type: "ex", casts: [{ pos: 0, target: { scope: "ally", idx: 1 } }] })
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
  const cyclePairs = (bluePicks, redPicks, kills = [], target) => {
    const st = setup(bluePicks, redPicks, kills)
    for (const s of st.sides) for (const u of s.units) { u.maxhp = 9e6; u.hp = 9e6 }
    const pos = st.sides[0].units.findIndex((u) => u.id === id("绿"))
    noMiss(st.sides[0].units[pos])
    const r = playerTurn(st, { type: "ex", casts: [{ pos, ...(target ? { target } : {}) }] })
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
  check("指定目标无效，落点仍由自己的号位定",
    cyclePairs(["椿", "绿", "椿", "椿"], FOUR, [], { scope: "foe", idx: 3 }), [2, 3, 4, 1, 2])
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

console.log("\n=== 36. 小春：一个圈，敌方那两路挨打、己方那两路回血 ===")
{
  const st = setup(["小春", "野宫", "野宫", "野宫"], ["椿", "椿", "椿", "椿"])
  for (const u of st.sides[0].units) { u.hp = Math.round(u.maxhp / 2) }
  noMiss(st.sides[0].units[0])
  st.sides[0].cost = 10
  const r = playerTurn(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: 2 } }] })
  const hurt = r.events.filter((e) => e.type === "damage" && e.target.side === 1).map((e) => e.target.pos + 1)
  const healed = r.events.filter((e) => e.type === "heal" && e.target.side === 0).map((e) => e.target.pos + 1)
  check("伤害落在指定的敌方 3·4 路", hurt, [3, 4])
  check("治疗落在**己方**同两路，不是敌方", healed, [3, 4])
  check("治疗的 scope 是 ally_mirror",
    ROSTER.find((t) => t.name === "小春").ex.effects[0].scope, "ally_mirror")
  // 她的单奶：排除自己、且只挑血量 ≤50% 的
  const koharu = ROSTER.find((t) => t.name === "小春")
  // 原文只写「不高于 50%」没说「最低」，所以是 ally_hurt（按站位就近）而不是 ally_lowest
  check("普技是单体奶、按站位就近，不是群奶", [koharu.skill.target, koharu.skill.exceptSelf, koharu.skill.hpMax],
    ["ally_hurt", true, 0.5])
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

console.log(bad ? `\n✗ ${bad} 条不符` : "\n全部符合")
process.exit(bad ? 1 : 0)
