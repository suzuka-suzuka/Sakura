/**
 * 战场分割与对线锁定的规则回归。
 *
 * 这几条规则很容易在改目标选择时被悄悄改坏，而压测只看不变量、看不出「打错人」，
 * 所以单独写成断言。改 laneTarget / expandAdjacent / resolveTargets 之后必跑：
 *
 *   node scripts/target-test.mjs
 */
import { createBattle, playerTurn, validateAction, exCastableOf, exWaitOf, exCostOf, tmplOf, provokedBy, exLockedOf, exSealedOf } from "../lib/ba/engine.js"
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

const OUT = ["野宫", "野宫", "野宫", "野宫"]        // 全输出，排除坦克干扰
const TANK1 = ["星野", "野宫", "野宫", "野宫"]      // 1 位坦克

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

console.log("\n=== 4. 坦克领先一个站位：红1 是坦克 ===")
const tank = autoPairs(setup(OUT, TANK1))
check("蓝1 打坦克", tank.find((p) => p.from === 1).to, [1])
check("蓝2 也打坦克（同战场）", tank.find((p) => p.from === 2).to, [1])
check("蓝3 不受坦克影响", tank.find((p) => p.from === 3).to, [3])
check("蓝4 不受坦克影响", tank.find((p) => p.from === 4).to, [4])

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
// 嘲讽过期之后它仍然是**那半边战场的坦克**：扔进 1·2 就把 1·2 两路的刀全接了
check("嘲讽过后扔进 1·2 战场：红1 红2 都打人偶", withDoll(0, true), ["1→偶", "2→偶", "3→3", "4→4"])
check("嘲讽过后扔进 3·4 战场：红3 红4 都打人偶", withDoll(2, true), ["1→1", "2→2", "3→偶", "4→偶"])
// 「视为坦克，且排在真坦克前面」：同战场有星野也照样先打人偶
{
  const st = setup(["日富美", "野宫", "野宫", "野宫"], TANK1)
  st.sides[0].cost = 10
  let cur = run(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: 0 } }] }).state
  cur = run(cur, { type: "pass" }).state // 红方（嘲讽期）
  cur = run(cur, { type: "pass" }).state // 蓝方
  const r = run(cur, { type: "pass" })
  check("人偶优先于本战场的真坦克",
    r.events.filter((e) => e.type === "action" && e.action === "normal")
      .map((e) => `${e.source.pos + 1}→${(e.targets || []).map((t) => (t.summon ? "偶" : t.pos + 1)).join("")}`),
    ["1→偶", "2→偶", "3→3", "4→4"])
}

console.log("\n=== 9. 范围技撞上人偶：整发被接走，覆盖面按各自的规则算 ===")
const FOE = ["白子", "野宫", "芹香", "睦月"] // 全输出，避免坦克优先把主目标拉偏
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
// 有坦克就后两发都落坦克身上（敌 1 位放星野，伊织在 1 位）
check("同战场有坦克 → 后两发都打坦克", (() => {
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
 * 瞬站蓝 1 位，敌方 [茜(120) 星野(213坦克) 鹤城(471) 野宫(321)]：
 * 常规对线会打同战场的坦克（红2），强化后要越过战场分割去点全场最高攻的红3。
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
  check("未强化 → 照常打同战场的坦克（红2）", (ev?.targets || []).map((t) => t.pos + 1), [2])
}
check("强化后 → 越过战场分割和坦克，打全场最高攻的红3", shunShot(), [3])
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
check("队友不受影响，照常打同战场的坦克", (() => {
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

  // 6 轮存续，施放那轮她忙着放 EX 没普攻 → 实际打出 5 发强化普攻
  let r = run(setup(["瞬", "野宫", "野宫", "野宫"], SHUN_FOE), { type: "ex", casts: [{ pos: 0 }] })
  check("施放回合她不普攻",
    r.events.some((e) => e.type === "action" && e.action === "normal" && e.source.pos === 0), false)
  check("施放回合末已跳掉 1 轮", r.state.sides[0].units[0].charge.turns, 5)
  let boosted = 0
  for (let i = 0; i < 8; i++) {
    r = run(r.state, { type: "pass" })
    r = run(r.state, { type: "pass" })
    boosted += r.log.filter((l) => /瞬 强化普攻/.test(l)).length
  }
  check("累计打出 5 发强化普攻", boosted, 5)
  check("到期后 charge 清干净", r.state.sides[0].units[0].charge, null)
}

console.log("\n=== 19. 鹤城的换弹强化仍然按发数走 ===")
{
  let r = run(setup(["鹤城", "野宫", "野宫", "野宫"], SHUN_FOE), { type: "ex", casts: [{ pos: 0 }] })
  check("施放回合立即换弹并打出第 1 发",
    r.log.filter((l) => /鹤城 强化普攻/.test(l)).length, 1)
  check("按发数存续，不带 turns", r.state.sides[0].units[0].charge, { hits: [69.355, 69.355], count: 2, shots: 1 })
  r = run(run(r.state, { type: "pass" }).state, { type: "pass" })
  check("下个己方回合打出第 2 发", r.log.filter((l) => /鹤城 强化普攻/.test(l)).length, 1)
  check("两发打完就没了", r.state.sides[0].units[0].charge, null)
  // 强化普攻的倍率与分段照抄 Skills.Normal.FormChange，不是「基础普攻 × 描述里的倍率」
  const ex = ROSTER.find((t) => t.name === "鹤城").ex.effects.find((e) => e.type === "charge")
  check("鹤城强化普攻合计 138.71% 分 2 段", [ex.hits.reduce((a, b) => a + b, 0).toFixed(2), ex.hits.length], ["138.71", 2])
  check("鹤城不带索敌变更", ex.targeting ?? null, null)
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
  const st = setup(["纯子", "野宫", "野宫", "野宫"], SHUN_FOE)
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
    check("集火那个标现在没人亮（池里还没有集火角色）",
      [...cur.sides[0].units, ...cur.sides[1].units].some((u) => u.tauntKind === "focus"), false)
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

console.log(bad ? `\n✗ ${bad} 条不符` : "\n全部符合")
process.exit(bad ? 1 : 0)
