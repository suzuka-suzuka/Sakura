/**
 * 抛出佩洛洛：站在敌方前排前面。用法：node scripts/_preview-doll.mjs
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
    { uid: "a", name: "蓝方", picks: ["日富美", "白子", "野宫", "星野"].map(id) },
    { uid: "b", name: "红方", picks: ["椿", "芹香", "日奈", "优香"].map(id) },
    { seed: 7, first: 0 },
  )
  for (const s of st.sides) for (const u of s.units) u.skillCd = 99
  st.sides[0].cost = 10
  const r = playerTurn(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: 0 } }] })
  const file = path.join(dir, "doll-front.png")
  fs.writeFileSync(file, await G.generateBattleMap(r.state, { events: r.events }))
  console.log(file)
} finally {
  await closeBrowser()
}
