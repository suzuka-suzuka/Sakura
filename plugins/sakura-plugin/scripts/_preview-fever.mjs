/**
 * 白热化四格（Cost 回复↑ / 防御↓ / 闪避↓ / 受治疗↓）+ 状态图标对照。
 * 用法：node scripts/_preview-fever.mjs
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createBattle } from "../lib/ba/engine.js"
import { CFG, ROSTER } from "../lib/ba/roster.js"
import { closeBrowser, shotHtml } from "../lib/ba/browser.js"
import { baBattleImageGenerator as G } from "../lib/ba/BaBattleImageGenerator.js"
import { statusIconOf, fontFace, FONT_STACK } from "../lib/ba/htmlAssets.js"

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "_preview")
fs.mkdirSync(dir, { recursive: true })
const id = (n) => ROSTER.find((t) => t.name === n).id

const SHEET = [
  ["heal", "治疗力↑ HEAL"],
  ["heal-down", "治疗力↓"],
  ["rec", "受治疗↑ REC"],
  ["rec-down", "受治疗↓ 减疗"],
  ["cost-regen", "Cost回复↑"],
  ["dfs-down", "防御↓"],
  ["dodge-down", "闪避↓"],
  ["form", "形态转换"],
  ["atk", "攻击↑"],
  ["immortal", "不死"],
  ["ex-discount", "EX 减费"],
  ["stun", "眩晕"],
  ["fear", "恐惧"],
  ["provoke", "嘲讽"],
  ["shield", "护盾"],
  ["regen", "持续治疗"],
  ["burn", "灼烧"],
]

function feverState() {
  const st = createBattle(
    { uid: "a", name: "蓝方", picks: ["星野", "白子", "日奈", "爱露"].map(id) },
    { uid: "b", name: "红方", picks: ["野宫", "芹香", "真纪", "茜"].map(id) },
    { seed: 7, first: 0 },
  )
  st.round = CFG.FEVER_ROUND
  st.fever = true
  for (const s of st.sides) {
    for (const u of s.units) {
      u.skillCd = 99
      if (CFG.FEVER_COST_MULT > 1) {
        u.buffs.push({
          stat: "cost_regen", value: CFG.FEVER_COST_MULT - 1, turns: 9999, st: -1,
          srcSide: u.side, effectKind: "fever", sourceKey: "fever-cost",
        })
      }
      for (const stat of ["dfs", "dodge", "heal_taken"]) {
        u.buffs.push({
          stat, value: -CFG.FEVER_DEBUFF, turns: 9999, st: -1,
          srcSide: u.side, effectKind: "fever", sourceKey: "fever",
        })
      }
    }
  }
  return st
}

function sheetHtml() {
  const cells = SHEET.map(([name, label]) => {
    const uri = statusIconOf(name)
    return `<figure>
      ${uri ? `<img src="${uri}" alt="">` : `<i>?</i>`}
      <figcaption>${label}<br>${name}</figcaption>
    </figure>`
  }).join("")
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><style>
    ${fontFace()}
    body{margin:0;background:#EDF4FB;font-family:${FONT_STACK};color:#22384F}
    #sheet{padding:20px 24px 16px;width:720px;box-sizing:border-box}
    h1{margin:0 0 14px;font-size:16px;font-weight:700}
    .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px 10px}
    figure{margin:0;background:#fff;border-radius:10px;padding:10px 6px 8px;text-align:center}
    figure img{width:44px;height:50px;image-rendering:auto}
    figure i{display:inline-block;width:44px;height:50px;line-height:50px;background:#ddd;border-radius:6px;font-style:normal}
    figcaption{margin-top:6px;font-size:11px;line-height:1.35;color:#4A6078}
  </style></head><body>
  <div id="sheet"><h1>原作状态格（白热化 = Cost↑ / 防御↓ / 闪避↓ / 减疗 REC↓）</h1>
    <div class="grid">${cells}</div>
  </div></body></html>`
}

try {
  const map = await G.generateBattleMap(feverState())
  const mapFile = path.join(dir, "fever.png")
  fs.writeFileSync(mapFile, map)
  console.log(mapFile, map.length)

  const sheet = await shotHtml(sheetHtml(), { width: 720, height: 620, selector: "#sheet", scale: 2 })
  const sheetFile = path.join(dir, "status-sheet.png")
  fs.writeFileSync(sheetFile, sheet)
  console.log(sheetFile, sheet.length)
} finally {
  await closeBrowser()
}
