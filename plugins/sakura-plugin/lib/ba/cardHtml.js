/**
 * 角色卡与攻略页的 HTML 模板层。
 *
 * 角色卡走原作的亮色系（白底 + 浅蓝灰面板 + 深蓝字），攻略页沿用战场的深色系。
 * 纯函数，产出完整 HTML；截图由 browser.js 负责。
 */
import { CFG, ROSTER, combatRoleOf } from "./roster.js"
import { describeEffect } from "./format.js"
import { guidePages } from "./guideContent.js"
import { artOf, fontFace, FONT_STACK, ATTACK, ARMOR, ARMOR_LABEL, inkOf, esc } from "./htmlAssets.js"

export const CARD_WIDTH = 900
export const CARD_HEIGHT = 1280
export const GUIDE_WIDTH = 1200
export const GUIDE_HEIGHT = 1800

/** 普通技能的触发条件标签 */
function triggerLabel(tr) {
  if (!tr) return "被动"
  const uses = tr.maxUses ? ` · 每场${tr.maxUses}次` : ""
  if (tr.type === "hp_below") return `生命≤${Math.round(tr.value * 100)}%${uses}`
  if (tr.type === "on_auto") {
    // 泉奈是「每 N 枪」，没有概率也没有冷却
    if (tr.every) return `每${tr.every}枪${uses}`
    return `普攻${Math.round((tr.chance ?? 1) * 100)}% · CD${tr.turns}${uses}`
  }
  if (tr.type === "on_kill") return tr.turns ? `击杀 · CD${tr.turns}${uses}` : `击杀${uses}`
  if (tr.type === "battle_start") return "战斗开始时"
  return `CD${tr.turns}${uses}`
}

// ---------------- 角色卡 ----------------

export function buildCardHtml(tmpl) {
  const ac = ATTACK[tmpl.atkType] || "#8AA"
  const armorColor = ARMOR[tmpl.defType] || "#8AA"
  const ink = inkOf(ac)
  const portrait = artOf(tmpl.id, "portrait")
  const autoPct = tmpl.autoAttack.hits.reduce((a, b) => a + b, 0)

  const stat = (label, value, accent = false) => `
    <div class="cell${accent ? " accent" : ""}"><label>${label}</label><b>${esc(value)}</b></div>`

  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><style>
${fontFace()}
*{margin:0;padding:0;box-sizing:border-box}
body{width:${CARD_WIDTH}px;height:${CARD_HEIGHT}px;font-family:${FONT_STACK};-webkit-font-smoothing:antialiased}
#card{position:relative;width:${CARD_WIDTH}px;height:${CARD_HEIGHT}px;overflow:hidden;color:#22384F;
  background:linear-gradient(135deg,#FFF 0%,#F1F6FB 42%,${ac}22 100%);
  border:13px solid ${ac};border-radius:34px}
#card::before{content:"";position:absolute;inset:0;opacity:.07;
  background:repeating-linear-gradient(115deg,${ac} 0 2px,transparent 2px 74px)}
#card::after{content:"";position:absolute;right:-120px;top:-40px;width:620px;height:620px;border-radius:50%;
  background:radial-gradient(circle,${ac}30,transparent 70%)}
.inner{position:absolute;inset:13px;border:2px solid rgba(255,255,255,.85);border-radius:22px;pointer-events:none}

.art{position:absolute;right:16px;top:96px;width:520px;height:680px;display:flex;align-items:flex-end;justify-content:center}
.art img{max-width:100%;max-height:100%;object-fit:contain}
.art .ph{width:300px;height:300px;border-radius:50%;background:${ac};display:flex;align-items:center;
  justify-content:center;font-size:120px;color:#fff}
.artfade{position:absolute;right:0;left:330px;top:600px;height:230px;
  background:linear-gradient(180deg,rgba(244,248,252,0),rgba(244,248,252,.98))}

.name{position:absolute;left:48px;top:96px;font-size:56px;line-height:1;color:#1E3348}
.tags{position:absolute;left:48px;top:178px;display:flex;gap:8px}
.tags span{padding:6px 13px;border-radius:16px;font-size:16px;line-height:1.2;border:1px solid}
.tags .role{background:rgba(255,255,255,.92);color:${ink};border-color:${ac}99}
.tags .atk{background:${ac}22;color:${ink};border-color:${ac}AA}
.tags .arm{background:${armorColor}22;color:${inkOf(armorColor)};border-color:${armorColor}AA}

.stats{position:absolute;left:48px;top:248px;width:318px;display:grid;grid-template-columns:1fr 1fr;gap:10px}
.cell{background:rgba(255,255,255,.94);border:1.5px solid rgba(120,150,180,.28);border-radius:16px;padding:11px 14px}
.cell.wide{grid-column:1 / -1}
.cell label{display:block;font-size:15px;color:#8397AC}
.cell b{font-size:24px;line-height:1.25}
.cell.accent b{color:${ink}}

.panel{position:absolute;left:48px;width:804px;background:rgba(255,255,255,.96);
  border:1.5px solid ${ac}66;border-radius:20px;padding:16px 22px 16px 38px}
.panel::before{content:"";position:absolute;left:14px;top:14px;bottom:14px;width:8px;border-radius:4px;background:${ac}}
.panel h3{font-size:20px;font-weight:bold;color:${ink};margin-bottom:9px}
.panel p{font-size:19px;line-height:1.45;color:#3D5468}
#skill{top:748px;min-height:190px}
#ex{top:970px;min-height:230px}
</style></head><body>
<div id="card">
  <div class="art">${portrait ? `<img src="${portrait}" alt="">` : `<div class="ph">${esc(tmpl.name[0])}</div>`}</div>
  <div class="artfade"></div>
  <div class="name">${esc(tmpl.name)}</div>
  <div class="tags">
    <span class="role">${esc({ 前: "前排", 中: "中排", 后: "后排" }[tmpl.line] || "")}</span>
    <span class="role">${esc(combatRoleOf(tmpl))}</span>
    <span class="atk">${esc(tmpl.atkType)}攻击</span>
    <span class="arm">${esc(ARMOR_LABEL[tmpl.defType] || tmpl.defType)}</span>
  </div>
  <div class="stats">
    ${stat("生命", tmpl.hp).replace('class="cell"', 'class="cell wide"')}
    ${stat("攻击", tmpl.atk)}${stat("防御", tmpl.dfs)}
    ${stat("命中", tmpl.acc)}${stat("闪避", tmpl.dodge)}
    ${stat("暴击", tmpl.crit)}${stat("暴伤", (tmpl.critDmg / 10000).toFixed(1) + "x")}
    ${stat("治疗", tmpl.healPower)}${stat("EX Cost", tmpl.ex.cost, true)}
  </div>
  <div class="panel" id="skill">
    <h3>普通技能 · ${esc(tmpl.skill?.name || "无")} · ${triggerLabel(tmpl.skill?.trigger)}</h3>
    <p>${esc(describeEffect(tmpl.skill))}</p>
  </div>
  <div class="panel" id="ex">
    <h3>EX 技能 · ${esc(tmpl.ex.name)} · ${tmpl.ex.cost} Cost</h3>
    <p>${esc(describeEffect(tmpl.ex))}</p>
    <p style="margin-top:8px;color:#8397AC;font-size:16px">普攻 ${autoPct.toFixed(0)}% 分 ${tmpl.autoAttack.hits.length} 段${tmpl.autoAttack.count > 1 ? ` · ${tmpl.autoAttack.depth === "through" ? "直线贯穿" : "同战场同身位"} ${tmpl.autoAttack.count} 人` : ""}</p>
  </div>
  <div class="inner"></div>
</div>
</body></html>`
}

// ---------------- 攻略页 ----------------

export function buildGuideHtml(page, index, total) {
  // 强调色都是按深色底挑的，攻略页跟战场图一起转亮色后一律过 inkOf() 压暗
  const sections = page.sections.map((sec) => `
    <section style="--ac:${inkOf(sec.accent)}">
      <h3>${esc(sec.title)}</h3>
      <dl>${sec.items.map((it) => `
        <div class="item">
          <dt style="${it.color ? `color:${inkOf(it.color)}` : ""}">${esc(it.label)}</dt>
          <dd>${esc(it.text)}</dd>
        </div>`).join("")}
      </dl>
    </section>`).join("")

  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><style>
${fontFace()}
*{margin:0;padding:0;box-sizing:border-box}
body{width:${GUIDE_WIDTH}px;font-family:${FONT_STACK};
  color:#22384F;-webkit-font-smoothing:antialiased}
/* 高度随内容走：截的是 #guide 元素而不是视口，页短就短，不留一大片白 */
#guide{position:relative;width:${GUIDE_WIDTH}px;min-height:820px;overflow:hidden;padding:44px 48px 78px;
  background:radial-gradient(120% 70% at 50% 0%,#FFFFFF 0%,rgba(255,255,255,0) 62%),
    linear-gradient(180deg,#EDF4FB 0%,#DFEAF5 46%,#D4E2F0 100%)}
#guide::before{content:"";position:absolute;inset:0;opacity:.5;
  background:repeating-linear-gradient(115deg,rgba(78,147,232,.09) 0 2px,transparent 2px 74px)}
header{position:relative;display:flex;align-items:flex-end;justify-content:space-between;
  padding-bottom:20px;border-bottom:2px solid rgba(70,120,175,.28)}
header .tab{font-size:15px;letter-spacing:3px;color:#4A80B8}
header h1{font-size:44px;line-height:1.15;margin-top:4px;color:#1E3348}
header .sub{font-size:16px;color:#5D7996;margin-top:6px}
header .pg{font-size:15px;color:#8397AC}
main{position:relative;margin-top:26px;display:flex;flex-direction:column;gap:20px}
section{background:rgba(255,255,255,.93);border:1px solid rgba(70,120,175,.18);border-radius:18px;
  padding:20px 26px;border-left:7px solid var(--ac);box-shadow:0 2px 10px rgba(40,80,125,.08)}
section h3{font-size:24px;color:var(--ac);margin-bottom:14px}
.item{display:grid;grid-template-columns:170px 1fr;gap:16px;padding:7px 0}
.item+.item{border-top:1px solid rgba(40,80,125,.1)}
dt{font-size:18px;color:#33506B}
dd{font-size:18px;line-height:1.5;color:#4A6480}
footer{position:absolute;left:48px;right:48px;bottom:22px;display:flex;justify-content:space-between;
  font-size:13px;color:#8397AC}
</style></head><body>
<div id="guide">
  <header>
    <div><div class="tab">${esc(page.tab)}</div><h1>${esc(page.title)}</h1>
      <div class="sub">${esc(page.subtitle)}</div></div>
    <div class="pg">${index + 1} / ${total}</div>
  </header>
  <main>${sections}</main>
  <footer><span>碧蓝档案 · 回合制群战</span><span>#档案攻略</span></footer>
</div>
</body></html>`
}

export { guidePages }
