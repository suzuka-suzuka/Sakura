/**
 * 形态转换黄底格 vs 芹香加攻。用法：node scripts/_preview-form.mjs
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

function afterEx(name) {
  const st = createBattle(
    { uid: "a", name: "蓝方", picks: [name, "野宫", "野宫", "野宫"].map(id) },
    { uid: "b", name: "红方", picks: ["星野", "白子", "日奈", "爱露"].map(id) },
    { seed: 7, first: 0 },
  )
  for (const s of st.sides) for (const u of s.units) u.skillCd = 99
  st.sides[0].cost = 10
  return playerTurn(st, { type: "ex", casts: [{ pos: 0 }] }).state
}

try {
  for (const name of ["鹤城", "瞬", "芹香"]) {
    const buf = await G.generateBattleMap(afterEx(name))
    const file = path.join(dir, `form-${name}.png`)
    fs.writeFileSync(file, buf)
    console.log(file, buf.length)
  }
} finally {
  await closeBrowser()
}
