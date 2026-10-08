import { FISHING_LOCATIONS, FISHING_LOCATION_UNLOCK_COUNT } from "./rules.js";
import { getEncounterFontData, renderFishingHtml } from "./encounterImages.js";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export function buildFishingLocationHtml({ currentId, unlocks, fontData = "" }) {
  const statuses = new Map(unlocks.map(status => [status.locationId, status]));
  const rows = Object.entries(FISHING_LOCATIONS).map(([id, location]) => {
    const status = statuses.get(id);
    if (!status) throw new Error(`钓点解锁状态缺失：${id}`);
    const current = id === currentId;
    const state = current ? "current" : status.unlocked ? "available" : "locked";
    const label = current ? "当前" : status.unlocked ? "已解锁" : "未解锁";
    const previous = FISHING_LOCATIONS[status.requiredLocationId];
    const collected = Math.min(status.required, Math.max(0, Math.floor(status.collected)));
    const requirement = previous
      ? `${escapeHtml(previous.name)}图鉴 <b>${collected} / ${status.required}</b> 种`
      : "初始开放";
    return `<section class="location ${state}">
      <div class="icon">${escapeHtml(location.emoji)}</div>
      <div class="info"><h2>${escapeHtml(location.name)}</h2><p>${requirement}</p></div>
      <span class="status">${label}</span>
    </section>`;
  }).join("");

  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><style>
${fontData ? `@font-face{font-family:LocationCard;src:url(data:font/ttf;base64,${fontData}) format('truetype')}` : ""}
*{box-sizing:border-box}body{margin:0;background:#fff8fb;color:#523b49;font-family:LocationCard,'Microsoft YaHei',sans-serif}
.card{width:820px;padding:32px;background:#fff8fb}header{margin-bottom:24px}h1{margin:0 0 10px;font-size:38px;line-height:1.25}header p{margin:0;color:#806575;font-size:21px;line-height:1.5}
.locations{display:flex;flex-direction:column;gap:10px}.location{display:flex;align-items:center;gap:18px;padding:18px 20px;border:1px solid #eadde3;border-radius:16px;background:#fff;min-height:100px}
.icon{display:flex;align-items:center;justify-content:center;flex:0 0 48px;height:48px;font-family:'Segoe UI Emoji','Microsoft YaHei',sans-serif;font-size:31px}.info{flex:1;min-width:0}h2{margin:0 0 7px;font-size:28px;line-height:1.25}.info p{margin:0;font-size:20px;line-height:1.4;color:#806575;white-space:nowrap}.info b{font-weight:700;color:#654756}
.status{flex-shrink:0;padding:7px 14px;border-radius:9px;font-size:20px;line-height:1.3;background:#f2f1f3;color:#8c8288}.available .status{background:#eef7ef;color:#4c815b}.current{border-color:#e6abc2;background:#fff0f6}.current .status{background:#e9c0d1;color:#884760}
footer{margin-top:25px;padding-top:20px;border-top:1px solid #eadde3}footer p{margin:0;font-size:18px;line-height:1.5;color:#806575}.command{margin-top:10px;font-size:23px;color:#654756}.command strong{font-weight:700}
</style></head><body><main class="card">
<header><h1>钓点一览</h1><p>前一钓点收录 ${FISHING_LOCATION_UNLOCK_COUNT} 种专属鱼，解锁下一站</p></header>
<div class="locations">${rows}</div>
<footer><p>仅计成功收录 · 含跨钓点鱼 · 通用鱼不计</p><div class="command">切换：<strong>#前往钓点 钓点名</strong></div></footer>
</main></body></html>`;
}

export async function createFishingLocationImage(data) {
  const fontData = await getEncounterFontData();
  return renderFishingHtml(buildFishingLocationHtml({ ...data, fontData }), { width: 820 });
}
