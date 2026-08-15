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

console.log(bad ? `\n✗ ${bad} 条不符` : "\n全部符合")
process.exit(bad ? 1 : 0)
