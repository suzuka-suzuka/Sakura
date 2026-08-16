/**
 * 战斗内核压测：随机配队跑满整局，逐回合检查不变量。
 *
 * 改动 engine.js / roster.js 之后必跑。基线（20 人池，2000 局）：
 *   0 错误 · 平均 8.7 轮 · 中位 8 轮 · 先手胜率 ≈50%
 *
 * 中位 7 轮意味着白热化（第 36 轮）基本打不到 —— 与原作一致，多数 PvP 在此之前就结束了。
 * 2000 局里有几局打满 48 轮走时限结算、十来局摸到白热化 —— 都是正常路径不是卡死。
 * 佳代子进池之后才出现：群控让战斗明显拉长。
 *
 * 先手胜率 500 局的标准误就有 ±2.2%，别拿一次 500 局的结果判断偏移，要看就跑 2000 局。
 *
 * 约 9% 的局全程一个普通技能都没放出来，这是对的不是 bug：冷却 5~6 轮 = 25~30 秒，
 * 而中位局只打 7 轮 = 35 秒，原作里 25 秒的技能在这么短的战斗里同样只放得出一发。
 *
 * 注意本脚本只查不变量，查不出「打错人」——目标选择的规则回归在 target-test.mjs。
 *
 * 其中「全员被冷却锁死」是 EX 冷却机制的核心不变量：冷却长度 = 存活数−2，
 * 最多锁得住最近 n−2 个施放者，所以可放的人永远不少于 2。
 *
 * 用法：node scripts/stress-test.mjs [局数]
 */
import { createBattle, playerTurn, validateAction, exAvailableOf, exCastableOf, exWaitOf, exLockLenOf } from "../lib/ba/engine.js"
import { ROSTER, CFG } from "../lib/ba/roster.js"

const GAMES = Number(process.argv[2]) || 500
/** 死循环保护：一轮两回合，每回合最多几次 EX + 一次过，再留余量 */
const GUARD_MAX = CFG.MAX_ROUND * 2 * 6 + 16
const ids = ROSTER.map((t) => t.id)
/** 固定序列的伪随机，保证复现 */
const rnd = (seed) => { let x = seed; return () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) }

let games = 0, errors = 0, turnsTotal = 0
const winner = { 0: 0, 1: 0, "-1": 0 }
const endRound = []
const fail = (msg) => { errors++; console.log("  ✗ " + msg) }

for (let seed = 1; seed <= GAMES; seed++) {
  const R = rnd(seed)
  const pick = () => Array.from({ length: 4 }, () => ids[Math.floor(R() * ids.length)])
  let st
  try {
    st = createBattle(
      { uid: "a", name: "A", picks: pick() },
      { uid: "b", name: "B", picks: pick() },
      { seed, first: R() < 0.5 ? 0 : 1 }
    )
  } catch (e) { fail(`seed ${seed} 建局失败: ${e.message}`); continue }

  // 上限从 CFG 推导，别写死：一局最多 MAX_ROUND 轮 = ×2 回合，写死的数字会在改 MAX_ROUND 后
  // 悄悄把「打满时限正常结算」的局误报成「未收敛」
  let guard = 0
  while (st.phase === "command" && guard < GUARD_MAX) {
    const side = st.sides[st.activeSide]
    const hand = exCastableOf(st, st.activeSide)
    let action = { type: "pass" }

    if (R() < 0.75 && hand.length) {
      const p = hand[Math.floor(R() * hand.length)]
      // 故意混入非法目标：越界索引、友敌错配
      const roll = R()
      let target
      if (roll < 0.2) target = { scope: "foe", idx: Math.floor(R() * 4) }
      else if (roll < 0.3) target = { scope: "ally", idx: Math.floor(R() * 4) }
      else if (roll < 0.35) target = { scope: "foe", idx: 9 }
      action = { type: "ex", casts: [{ pos: p, target }] }
      if (validateAction(st, action)) action = { type: "pass" }
    }

    let r
    try { r = playerTurn(st, action) }
    catch (e) { fail(`seed ${seed} 回合${guard} 崩溃: ${e.message}`); break }
    if (r.error) r = playerTurn(st, { type: "pass" })

    for (const s of r.state.sides) {
      if (s.cost < 0 || s.cost > CFG.COST_MAX) fail(`seed ${seed} Cost 越界 ${s.cost}`)
      // 号位不变量：`units[i].idx === i`。resolveCasts / resolveTargets / validateAction
      // 全都拿号位当下标索引，泉奈的位移换位要是只换了一半，这里就该炸
      for (const [i, u] of s.units.entries()) {
        if (u.idx !== i) fail(`seed ${seed} 号位错位：units[${i}].idx = ${u.idx}`)
        if (u.side !== s.side) fail(`seed ${seed} 阵营错位：units[${i}].side = ${u.side}`)
      }
      for (const u of s.units) {
        if (u.hp < 0 || u.hp > u.maxhp) fail(`seed ${seed} HP 越界 ${u.hp}/${u.maxhp}`)
        if (u.alive && u.hp <= 0) fail(`seed ${seed} 血空但存活`)
        if (!u.alive && u.hp > 0) fail(`seed ${seed} 已死但有血`)
        if (u.shield < 0) fail(`seed ${seed} 负护盾`)
      }
      const h = exAvailableOf(r.state, s.side)
      const aliveN = s.units.filter((u) => u.alive).length
      if (new Set(h).size !== h.length) fail(`seed ${seed} 可用EX重复`)
      if (h.some((p) => !s.units[p].alive)) fail(`seed ${seed} 可用EX含阵亡角色`)
      for (const u of s.units) {
        if (u.alive && exWaitOf(s, u) > exLockLenOf(s)) fail(`seed ${seed} EX冷却超出上限`)
      }
      // 反死锁：冷却长度 = 存活数−2，最多只锁得住最近 n−2 个施放者，
      // 所以任何时刻可放的人都不该少于 2（不足 2 人时按存活数算）
      if (aliveN > 0 && h.length < Math.min(2, aliveN)) {
        fail(`seed ${seed} 全员被冷却锁死（存活 ${aliveN}，可放 ${h.length}）`)
      }
    }
    st = r.state
    guard++
  }
  if (st.phase !== "done") fail(`seed ${seed} 未收敛（${guard} 回合）`)
  games++
  turnsTotal += guard
  endRound.push(st.round)
  winner[String(st.winner)]++
}

endRound.sort((a, b) => a - b)
console.log(`\n=== ${games} 局压测 ===`)
console.log(`错误 / 不变量违例：${errors}`)
console.log(`平均 ${(turnsTotal / games).toFixed(1)} 回合 / ${(endRound.reduce((a, b) => a + b, 0) / games).toFixed(1)} 轮`)
console.log(`结束轮数：最短 ${endRound[0]}　中位 ${endRound[Math.floor(games / 2)]}　最长 ${endRound[games - 1]}`)
// 白热化不是「异常路径」，但它该是少数 —— 摸到的比例明显上去了，说明伤害口径出问题了
console.log(`摸到白热化（第 ${CFG.FEVER_ROUND} 轮起）：${endRound.filter((r) => r >= CFG.FEVER_ROUND).length} 局`)
console.log(`打满 ${CFG.MAX_ROUND} 轮：${endRound.filter((r) => r >= CFG.MAX_ROUND).length} 局`)
console.log(`先手胜 ${winner[0]}　后手胜 ${winner[1]}　平局 ${winner["-1"]}`)
process.exit(errors ? 1 : 0)
