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

const BLUE = ["千世", "星野", "野宫", "芹香"].map(id)
const RED = ["白子", "真纪", "日奈", "爱露"].map(id)

const battle = (blue, red, first) => {
  const st = createBattle(
    { uid: "a", name: "蓝方", picks: blue },
    { uid: "b", name: "红方", picks: red },
    { seed: 7, first },
  )
  for (const s of st.sides) for (const u of s.units) u.skillCd = 99
  st.sides[first].cost = 10
  return st
}

const save = async (name, state, events) => {
  const buf = await G.generateBattleMap(state, { events })
  const file = path.join(dir, name)
  fs.writeFileSync(file, buf)
  console.log(file)
}

try {
  // 蓝方千世打红方 1·2：圈在上方
  const top = playerTurn(battle(BLUE, RED, 0), { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: 0 } }] })
  await save("zone-red.png", top.state, top.events)

  // 红方千世打蓝方 1·2：圈在下方
  const bot = playerTurn(battle(RED, BLUE, 1), { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: 0 } }] })
  await save("zone-blue.png", bot.state, bot.events)
} finally {
  await closeBrowser()
}
