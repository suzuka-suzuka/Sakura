/**
 * 泉奈的位移：换位前后各出一张图，确认小人真的走到了新的一列、四格仍然一格一人。
 * 用法：node scripts/_preview-swap.mjs
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createBattle, playerTurn } from "../lib/ba/engine.js"
import { ROSTER } from "../lib/ba/roster.js"
import { closeBrowser } from "../lib/ba/browser.js"
import { baBattleImageGenerator as G } from "../lib/ba/BaBattleImageGenerator.js"

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "_preview")
fs.mkdirSync(dir, { recursive: true })
const id = (n) => ROSTER.find((t) => t.name === n).id
const shot = async (name, state, events) => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, await G.generateBattleMap(state, { events }))
  console.log(file, "|", state.sides[0].units.map((u) => ROSTER.find((t) => t.id === u.id).name).join(" "))
}

try {
  // 泉奈站 2 号位：这是唯一跨得过战场分界的那一跳（2 ↔ 3）
  const st = createBattle(
    { uid: "a", name: "蓝方", picks: ["椿", "泉奈", "野宫", "芹香"].map(id) },
    { uid: "b", name: "红方", picks: ["优香", "白子", "日奈", "梓"].map(id) },
    { seed: 7, first: 0 },
  )
  for (const s of st.sides) for (const u of s.units) u.skillCd = 99
  st.sides[0].cost = 10
  await shot("swap-before.png", st, [])

  const r = playerTurn(st, { type: "ex", casts: [{ pos: 1, target: { scope: "ally", idx: 2 } }] })
  console.log(r.log.join("\n"))
  await shot("swap-after.png", r.state, r.events)
} finally {
  await closeBrowser()
}
