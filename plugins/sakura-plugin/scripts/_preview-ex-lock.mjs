/**
 * 渲染「被嘲讽 / 被恐惧时 EX 卡压灰」的战场图，给人工看效果。
 * 用法：node scripts/_preview-ex-lock.mjs
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

function setup(blue, red) {
  const st = createBattle(
    { uid: "a", name: "蓝方", picks: blue.map(id) },
    { uid: "b", name: "红方", picks: red.map(id) },
    { seed: 7, first: 0 },
  )
  for (const s of st.sides) for (const u of s.units) u.skillCd = 99
  st.sides[0].cost = 10
  st.sides[1].cost = 10
  return st
}

function run(st, action) {
  let r = playerTurn(st, action)
  while (!r.error && r.state.phase === "command" && r.state.turnOpen) {
    r = playerTurn(r.state, { type: "pass" })
  }
  return r.state
}

/** 蓝方过 → 红方放指定 EX → 交回合，停在蓝方 command */
function afterRedEx(blue, red, pos) {
  let st = setup(blue, red)
  st = run(st, { type: "pass" })
  st.sides[1].cost = 10
  return run(st, { type: "ex", casts: [{ pos }] })
}

const blue = ["星野", "白子", "野宫", "伊织"]
try {
  const taunt = afterRedEx(blue, ["椿", "优香", "日奈", "爱露"], 0)
  const fear = afterRedEx(blue, ["佳代子", "优香", "日奈", "爱露"], 0)
  const tauntBuf = await G.generateBattleMap(taunt)
  const fearBuf = await G.generateBattleMap(fear)
  fs.writeFileSync(path.join(dir, "ex-lock-taunt.png"), tauntBuf)
  fs.writeFileSync(path.join(dir, "ex-lock-fear.png"), fearBuf)
  console.log(path.join(dir, "ex-lock-taunt.png"), tauntBuf.length)
  console.log(path.join(dir, "ex-lock-fear.png"), fearBuf.length)
} finally {
  await closeBrowser()
}
