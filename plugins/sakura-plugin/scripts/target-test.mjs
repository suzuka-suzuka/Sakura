/**
 * 战场分割与对线锁定的规则回归。
 *
 * 这几条规则很容易在改目标选择时被悄悄改坏，而压测只看不变量、看不出「打错人」，
 * 所以单独写成断言。改 laneTarget / expandAdjacent / resolveTargets 之后必跑：
 *
 *   node scripts/target-test.mjs
 */
import { createBattle, playerTurn } from "../lib/ba/engine.js"
import { ROSTER } from "../lib/ba/roster.js"

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
  const r = playerTurn(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx } }] })
  return r.events.find((e) => e.type === "action" && e.action === "ex").targets.map((t) => t.pos + 1)
}
check("指定红3 → 波及红4", pickIdx(setup(TANK1, OUT), 2), [3, 4])
check("指定红1 → 波及红2，不碰 3·4", pickIdx(setup(TANK1, OUT), 0), [1, 2])
check("红4 已阵亡，指定红3 → 退化成单体", pickIdx(setup(TANK1, OUT, [[1, 3]]), 2), [3])

console.log("\n=== 6. 野宫全体技能仍然打 4 个 ===")
const allSt = setup(["野宫", "星野", "野宫", "野宫"], OUT)
const rAll = playerTurn(allSt, { type: "ex", casts: [{ pos: 0 }] })
check("敌方全体命中数",
  rAll.events.find((e) => e.type === "action" && e.action === "ex").targets.length, 4)

console.log("\n=== 7. 3 目标技能走「以主目标为中心的固定窗口」（睦月）===")
const mutsuki = (idx) => {
  const st = setup(["睦月", "野宫", "野宫", "野宫"], OUT)
  const r = playerTurn(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx } }] })
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
  playerTurn(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: blockIdx } }] })
  let cur = playerTurn(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: blockIdx } }] }).state
  if (skipTaunt) {
    cur = playerTurn(cur, { type: "pass" }).state // 红方（嘲讽期）
    cur = playerTurn(cur, { type: "pass" }).state // 蓝方
  }
  const r = playerTurn(cur, { type: "pass" })
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
  const r = playerTurn(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: pickIdx } }] })
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

console.log(bad ? `\n✗ ${bad} 条不符` : "\n全部符合")
process.exit(bad ? 1 : 0)
