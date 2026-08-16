/**
 * 第二批的三样新表达：Fury 格 / 能量充能格 / 12 段起改印「Nhits」。
 * 用法：node scripts/_preview-states.mjs
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
    { uid: "a", name: "蓝方", picks: ["妮露", "爱丽丝", "琴里", "小春"].map(id) },
    { uid: "b", name: "红方", picks: ["野宫", "白子", "日奈", "梓"].map(id) },
    { seed: 3, first: 0 },
  )
  for (const s of st.sides) for (const u of s.units) u.skillCd = 99
  st.sides[0].cost = 10
  // 摆出状态：妮露带 Fury（EX 翻倍）、爱丽丝满充、命中拉满免得糊成一片 MISS
  Object.assign(st.sides[0].units[0], { fury: 4 })
  Object.assign(st.sides[0].units[1], { energy: 2 })
  for (const u of st.sides[0].units) {
    u.buffs.push({ stat: "acc", value: 50, turns: 999, st: -1, effectKind: "buff", sourceKey: "p:acc", srcSide: 0, srcPos: u.idx })
  }
  // 妮露的 EX 是 60 段 —— 数字下面该印「60hits」而不是六十条短横
  const r = playerTurn(st, { type: "ex", casts: [{ pos: 0, target: { scope: "foe", idx: 0 } }] })
  console.log(r.log.join("\n"))
  const file = path.join(dir, "states.png")
  fs.writeFileSync(file, await G.generateBattleMap(r.state, { events: r.events }))
  console.log(file)
} finally {
  await closeBrowser()
}
