/**
 * 图鉴总览图的 HTML 模板层。
 *
 * 一张图铺完全部角色，作为图鉴合并转发的**第一条** —— 后面几条按属性分开的
 * 文字节点是技能详情，这张图负责「谁在池子里、什么属性、什么装甲、几费」。
 * 分组口径与文字节点共用 `rosterByAtkType()`，两边顺序必须一致。
 *
 * 沿用角色卡的亮色系；卡片主色走**装甲色**（跟战场图血条同一套），
 * 攻击属性由分组本身表达 —— 一条信息只占一个视觉通道。
 */
import { ROSTER, affinity } from "./roster.js"
import { rosterByAtkType } from "./format.js"
import { artOf, fontFace, FONT_STACK, ATTACK, ARMOR, ARMOR_LABEL, inkOf, esc } from "./htmlAssets.js"

export const GRID_WIDTH = 1280
/** 视口只是画布，真正的高度由 #roster 元素自己撑开（截的是元素不是视口） */
export const GRID_VIEWPORT_HEIGHT = 1700

const COLS = 8
const LINE_LABEL = { 前: "前排", 中: "中排", 后: "后排" }
/** 装甲的固定展示顺序，别按 Set 的遇见顺序走 —— 每段克制条的列序要一致才好横向比 */
const ARMOR_ORDER = ["轻装", "重装", "特殊", "弹力", "复合"]
/** 透明度后缀，跟战场图/角色卡一样用 8 位 hex，不用 color-mix（无头 Chromium 版本不保证） */
const A = { fill: "42", fade: "14", line: "73", chip: "29", chipLine: "8C" }

/** 池子里实际出现的装甲，克制条只列这几种（列一堆池里没有的等于噪音） */
function armorsInPool() {
  const seen = new Set(ROSTER.map((t) => t.defType))
  return ARMOR_ORDER.filter((a) => seen.has(a))
}

/**
 * 色块上的字色。重装的 #F0C44E 太亮，白字压上去几乎糊掉 ——
 * `inkOf()` 管的是「亮色当文字」，这里管的是反过来的「文字压在亮色上」。
 */
function onColor(hex) {
  const n = Number.parseInt(String(hex).replace("#", ""), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.62 ? "#3B2E06" : "#FFFFFF"
}

function card(tmpl) {
  const am = ARMOR[tmpl.defType] || "#8AA0B4"
  const icon = artOf(tmpl.id, "icon")
  return `
  <div class="card" style="border-color:${am}">
    <b class="arm" style="background:${am};color:${onColor(am)}">${esc(tmpl.defType)}</b>
    <b class="cost">${tmpl.ex.cost}</b>
    <div class="face" style="background:linear-gradient(180deg,${am}${A.fill},${am}${A.fade})">${icon
      ? `<img src="${icon}" alt="">`
      : `<span class="ph" style="background:${am}">${esc(tmpl.name[0])}</span>`}</div>
    <div class="bar" style="border-top-color:${am}${A.line}">
      <b>${esc(tmpl.name)}</b>
      <span>${esc(LINE_LABEL[tmpl.line] || tmpl.line)} · ${esc(tmpl.role || "")}</span>
    </div>
  </div>`
}

function section(atk, list) {
  const ac = ATTACK[atk] || "#8AA0B4"
  // 克制系数直接问 affinity()，别在模板里抄一份表 —— 抄的那份迟早跟 roster 对不上
  const chips = armorsInPool().map((armor) => {
    const am = ARMOR[armor]
    return `<i style="background:${am}${A.chip};border-color:${am}${A.chipLine};color:${inkOf(am)}"
      >${esc(ARMOR_LABEL[armor])} ×${affinity(atk, armor).toFixed(1)}</i>`
  }).join("")

  return `
  <section>
    <div class="head" style="border-left-color:${ac}">
      <h2 style="color:${inkOf(ac)}">${esc(atk)}攻击</h2>
      <em>${list.length} 人</em>
      <div class="eff">${chips}</div>
    </div>
    <div class="grid">${list.map(card).join("")}</div>
  </section>`
}

export function buildRosterGridHtml() {
  const groups = rosterByAtkType()

  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><style>
${fontFace()}
*{margin:0;padding:0;box-sizing:border-box}
body{width:${GRID_WIDTH}px;font-family:${FONT_STACK};color:#22384F;-webkit-font-smoothing:antialiased}
#roster{position:relative;width:${GRID_WIDTH}px;overflow:hidden;padding:40px 44px 30px;
  background:radial-gradient(120% 60% at 50% 0%,#FFFFFF 0%,rgba(255,255,255,0) 62%),
    linear-gradient(180deg,#EDF4FB 0%,#DFEAF5 46%,#D4E2F0 100%)}
#roster::before{content:"";position:absolute;inset:0;opacity:.5;
  background:repeating-linear-gradient(115deg,rgba(78,147,232,.09) 0 2px,transparent 2px 74px)}

header{position:relative;display:flex;align-items:flex-end;justify-content:space-between;
  padding-bottom:18px;border-bottom:2px solid rgba(70,120,175,.28)}
header .tab{font-size:15px;letter-spacing:3px;color:#4A80B8}
header h1{font-size:42px;line-height:1.15;margin-top:4px;color:#1E3348}
header .sub{font-size:16px;color:#5D7996;margin-top:6px}
/* 两个角标不写图例就是天书，所以图例跟着图走，别指望玩家去翻攻略 */
header .legend{display:flex;flex-direction:column;gap:7px;align-items:flex-end;font-size:14px;color:#5D7996}
header .legend span{display:flex;align-items:center;gap:8px}
header .legend i{font-style:normal;display:inline-flex;align-items:center;justify-content:center;
  height:22px;padding:0 7px;border-radius:8px;background:#7E93A8;color:#fff;font-size:13px}
header .legend i.round{width:22px;padding:0;border-radius:50%;background:#22384F;font-size:14px}

main{position:relative;margin-top:24px;display:flex;flex-direction:column;gap:22px}
.head{display:flex;align-items:center;gap:12px;padding:0 0 12px 14px;border-left:8px solid;border-radius:4px}
.head h2{font-size:26px;line-height:1}
.head em{font-style:normal;font-size:15px;color:#8397AC}
.eff{margin-left:auto;display:flex;gap:8px}
.eff i{font-style:normal;font-size:14px;line-height:1.2;padding:5px 11px;border-radius:12px;border:1px solid}

.grid{display:grid;grid-template-columns:repeat(${COLS},1fr);gap:12px}
.card{position:relative;background:rgba(255,255,255,.95);border:2px solid;border-radius:16px;
  overflow:hidden;box-shadow:0 2px 8px rgba(40,80,125,.10)}
.face{position:relative;height:122px;display:flex;align-items:flex-end;justify-content:center}
.face img{width:122px;height:122px;object-fit:contain}
.face .ph{width:100%;text-align:center;font-size:54px;line-height:122px;color:#fff}
.bar{padding:7px 6px 9px;text-align:center;border-top:2px solid}
.bar b{display:block;font-size:21px;line-height:1.12;color:#1E3348;white-space:nowrap}
.bar span{display:block;margin-top:2px;font-size:12px;line-height:1.2;color:#8397AC}

.arm{position:absolute;left:5px;top:5px;z-index:2;height:22px;padding:0 7px;border-radius:8px;
  color:#fff;font-size:13px;line-height:22px;font-weight:normal}
.cost{position:absolute;right:5px;top:5px;z-index:2;width:22px;height:22px;border-radius:50%;
  background:#22384F;color:#fff;font-size:14px;line-height:22px;text-align:center;font-weight:normal}

footer{position:relative;margin-top:22px;display:flex;justify-content:space-between;
  font-size:14px;color:#8397AC}
</style></head><body>
<div id="roster">
  <header>
    <div>
      <div class="tab">碧蓝档案 · 回合制群战</div>
      <h1>角色图鉴</h1>
      <div class="sub">${ROSTER.length} 名角色 · 数值与技能照搬原作（等级1 / 无装备 / 统一3★ / 技能1级）</div>
    </div>
    <div class="legend">
      <span><i>轻装</i>装甲 —— 决定被谁克制</span>
      <span><i class="round">4</i>EX 技能 Cost</span>
    </div>
  </header>
  <main>${groups.map(([atk, list]) => section(atk, list)).join("")}</main>
  <footer>
    <span>配队回 4 个角色名，写的顺序就是左起站位</span>
    <span>技能详情见后面几条 · 完整数值发「档案图鉴 星野」</span>
  </footer>
</div>
</body></html>`
}
