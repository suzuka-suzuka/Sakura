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

const st = createBattle(
  { uid: "a", name: "蓝方", picks: ["日富美", "星野", "野宫", "芹香"].map(id) },
  { uid: "b", name: "红方", picks: ["白子", "真纪", "日奈", "爱露"].map(id) },
  { seed: 7, first: 0 },
)
for (const s of st.sides) for (const u of s.units) u.skillCd = 99
st.sides[0].cost = 10
const r = playerTurn(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: 0 } }] })
const buf = await G.generateBattleMap(r.state, { events: r.events })
const file = path.join(dir, "peroro-dur.png")
fs.writeFileSync(file, buf)
console.log(file, r.state.sides[0].summons[0])
await closeBrowser()
