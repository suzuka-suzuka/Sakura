/**
 * 四类图渲染冒烟：改 HTML/CSS 模板或改动 CFG 文案之后跑一遍。
 * 只验证「渲染不报错、出得来字节数」，不比对像素。
 *
 * 用法：node scripts/render-smoke.mjs
 */
import { createBattle, playerTurn } from "../lib/ba/engine.js"
import { ROSTER } from "../lib/ba/roster.js"
import { closeBrowser } from "../lib/ba/browser.js"
import { baBattleImageGenerator as G } from "../lib/ba/BaBattleImageGenerator.js"

const kb = (b) => (b ? `${(b.length / 1024).toFixed(0)} KB` : "空")
const t0 = Date.now()
const step = async (label, fn) => {
  const t = Date.now()
  const out = await fn()
  const size = Array.isArray(out) ? out.map(kb).join(" + ") : kb(out)
  console.log(`✓ ${label.padEnd(10)} ${size}　(${Date.now() - t}ms)`)
  return out
}

try {
  const picks = ROSTER.map((t) => t.id)
  let st = createBattle(
    { uid: "a", name: "红方", picks },
    { uid: "b", name: "蓝方", picks },
    { seed: 99, first: 0 }
  )
  const r = playerTurn(st, { type: "pass" })
  st = r.state

  await step("战场图", () => G.generateBattleMap(st, { events: r.events }))
  await step("角色卡", () => G.generateCharacterCard(ROSTER[0]))
  await step("攻略页", () => G.generateGuidePages())
  await step("图鉴卡", () => G.generateRosterCards())
  console.log(`\n全部渲染成功（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
} catch (e) {
  console.error("渲染失败:", e)
  process.exitCode = 1
} finally {
  await closeBrowser()
}
