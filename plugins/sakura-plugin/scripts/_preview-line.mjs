/**
 * 前/中/后排身位错开。用法：node scripts/_preview-line.mjs
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

try {
  const st = createBattle(
    { uid: "a", name: "蓝方", picks: ["星野", "白子", "野宫", "鹤城"].map(id) },
    { uid: "b", name: "红方", picks: ["椿", "芹香", "日奈", "优香"].map(id) },
    { seed: 7, first: 0 },
  )
  for (const s of st.sides) for (const u of s.units) u.skillCd = 99
  const r = playerTurn(st, { type: "pass" })
  const file = path.join(dir, "line-depth.png")
  fs.writeFileSync(file, await G.generateBattleMap(r.state, { events: r.events }))
  console.log(file)
} finally {
  await closeBrowser()
}
