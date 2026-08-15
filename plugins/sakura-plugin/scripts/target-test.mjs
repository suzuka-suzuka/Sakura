/**
 * 战场分割与对线锁定的规则回归。
 *
 * 这几条规则很容易在改目标选择时被悄悄改坏，而压测只看不变量、看不出「打错人」，
 * 所以单独写成断言。改 laneTarget / expandAdjacent / resolveTargets 之后必跑：
 *
 *   node scripts/target-test.mjs
 */
import { createBattle, playerTurn, validateAction, exCastableOf, exWaitOf } from "../lib/ba/engine.js"
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
check("嘲讽过后扔在 1 号位：只有红1 打人偶", withDoll(0, true), ["1→偶", "2→2", "3→3", "4→4"])
check("嘲讽过后扔在 3 号位：只有红3 打人偶", withDoll(2, true), ["1→1", "2→2", "3→偶", "4→4"])

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
// 睦月在 2 位 → 主目标 2、窗口 {1,2,3}：人偶落在窗口里就全接走，隔一位也算
check("睦月 3 目标 · 无人偶", skillVsDoll("睦月", 1, null).sort(), [1, 2, 3])
check("睦月 3 目标 · 人偶挡 1 位（隔一位）", skillVsDoll("睦月", 1, 0), ["偶"])
check("睦月 3 目标 · 人偶挡 3 位（隔一位）", skillVsDoll("睦月", 1, 2), ["偶"])
check("睦月 3 目标 · 人偶挡 4 位（窗口外）", skillVsDoll("睦月", 1, 3).sort(), [1, 2, 3])
// 白子在 1 位 → 2 目标，覆盖面是战场 {1,2}：只有同战场的人偶拦得住
check("白子 2 目标 · 人偶挡 2 位（同战场）", skillVsDoll("白子", 0, 1), ["偶"])
check("白子 2 目标 · 人偶挡 3 位（另一战场）", skillVsDoll("白子", 0, 2).sort(), [1, 2])

console.log("\n=== 10. 伊织 EX 三发各自锁目标（不能和上一发相同）===")
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
check("指定同战场的 1 位 → 1·2·1", iori(0), [1, 2, 1])
check("指定另一战场的 3 位 → 3 后回到本战场对位再换人", iori(2), [3, 1, 2])
check("本战场只剩 1 位 → 后两发继续打它", iori(0, [1]), [1, 1, 1])
check("人偶挡 1 位（同路）→ 第 2 发被接走，第 3 发换回人", iori(0, [], 0), [1, "偶", 1])
// 连发对人偶是**按战场**拦，不是按号位 —— 挡 2 位一样接得住伊织（她在 1 位）
check("人偶挡 2 位（同战场不同路）→ 照样接走第 2 发", iori(0, [], 1), [1, "偶", 1])
check("人偶挡 3 位（另一战场）→ 本战场还有人时不接", iori(0, [], 2), [1, 2, 1])
check("本战场打空 + 人偶在本战场 → 后两发全打人偶", iori(2, [0, 1], 0), [3, "偶", "偶"])
check("本战场打空 + 人偶在另一战场 → 先拆墙再打人", iori(2, [0, 1], 2), [3, "偶", 3])
// 战场图按 action.targets 画线：必须是实际打到的人，不能只写 resolveTargets 给出的第一发
{
  const st = setup(["伊织", "日富美", "野宫", "芹香"], FOE)
  st.sides[0].cost = 10
  const r = run(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: 0 } }] })
  const ev = r.events.find((e) => e.type === "action" && e.action === "ex" && e.source.pos === 0)
  check("伊织三发换人后 action.targets 含 1 和 2",
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
check("野宫单体普攻 · 人偶挡 2 位 → 不管（只挡对位那一路）", autoVsDoll("野宫", 0, 1), [1])

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

console.log(bad ? `\n✗ ${bad} 条不符` : "\n全部符合")
process.exit(bad ? 1 : 0)
