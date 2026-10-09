import { buildEncounterHtml } from "./encounterRenderer.js";
import { ENCOUNTER_TIME_LIMIT_MS, ENCOUNTER_FULL_REWARD_MS, validateEncounterInput } from "./encounter.js";

export const FISHING_ENCOUNTER_GUIDE_FILE = "05-waterway-encounter.jpg";

export function buildEncounterGuideHtml({ fontData, backgroundData = "" } = {}) {
  const example = { id: "guide-example", rows: ["#S###", "#A..#", "###B#", "###.#", "###G#"], limits: { actions: 9 } };
  if (!validateEncounterInput(example, "AxyyBxxx").success) throw new Error("遭遇攻略示例与规则不一致");
  const sampleSvg = buildEncounterHtml(example).match(/<svg[\s\S]*?<\/svg>/)[0];
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
@font-face{font-family:Guide;src:url(data:font/ttf;base64,${fontData}) format('truetype')}
*{box-sizing:border-box}body{margin:0;color:#523b49;font-family:Guide,'Microsoft YaHei',sans-serif}
.guide{width:1200px;padding:64px 64px 48px;background:#f9edf2 ${backgroundData ? `url(data:image/png;base64,${backgroundData}) center/cover` : ""}}
.header,.panel{background:rgba(255,255,255,.94);border:2px solid #ead1dc;border-radius:28px;padding:32px;margin-bottom:24px}
.header{padding:30px 36px}.tag{font-size:24px;color:#b83e70}h1{margin:14px 0 10px;font-size:52px}h2{font-size:32px;margin:0 0 20px;color:#b83e70}p{font-size:25px;line-height:1.65;margin:12px 0}.lead{font-size:27px}.accent{color:#b83e70;font-weight:bold}
table{width:100%;border-collapse:collapse;font-size:27px}th,td{padding:16px;text-align:left;border-bottom:1px solid #eadce4}th{color:#806575;font-size:24px}td:last-child{font-weight:bold;color:#3b7054}.keys{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.key{background:#f7eef2;border-radius:14px;padding:16px;text-align:center;font-size:29px}.key span{color:#b83e70}
.example{display:grid;grid-template-columns:330px 1fr;gap:32px;align-items:center}.example .map{width:330px;display:block;border:5px solid #a4c8b4;border-radius:14px}.code{font-family:'Microsoft YaHei',sans-serif;font-size:32px;letter-spacing:2px;color:#3b7054}.reward{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.reward div{padding:16px;background:#f2f8f2;border-radius:16px;text-align:center;font-size:25px}.reward strong{display:block;font-size:35px;color:#3b7054;margin-top:10px}.foot{font-size:22px;line-height:1.5;margin:0;text-align:center;color:#806575}
</style></head><body><main class="guide">
<header class="header"><div class="tag">钓鱼攻略 · 水路遭遇</div><h1>看清路线，恰好用完行动</h1><p class="lead">普通鱼、异色鱼、噩梦与宝藏通过重量判定后，有 10% 概率触发；成功后再判定困难度。好运护符与首领不触发。鱼在上方，收鱼点在下方；每次重新生成小地图与规定行动数。</p></header>
<section class="panel"><h2>仅匹配纯操作串</h2><div class="keys"><div class="key">左 <span>z</span></div><div class="key">右 <span>y</span></div><div class="key">上 <span>s</span></div><div class="key">下 <span>x</span></div></div><p>一次发送整套操作，只含「上下左右」和「zysxab」，支持混写，字母不区分大小写。请连续输入，不夹杂空格、说明或标点；每个方向移动一格，不能斜走或进入岸壁。</p><p class="accent">其他聊天或空消息不计作答，倒计时照常继续。首次纯操作串就是答案；动作语法、地形或路线错误直接失败，不能重试。</p></section>
<section class="panel"><h2>A/B 与移动分开计数</h2><table><thead><tr><th>目标地形</th><th>输入</th><th>行动消耗</th></tr></thead><tbody><tr><td>普通水路</td><td>方向，例如 x</td><td>1 次</td></tr><tr><td>水草</td><td>A＋方向，例如 Ax</td><td>A 1＋移动 1＝2 次</td></tr><tr><td>漂木</td><td>B＋方向，例如 Bx</td><td>B 2＋移动 1＝3 次</td></tr></tbody></table><p>B 只输入一个字母，系统按两次技能行动计数。A/B 必须紧接方向并匹配地形，普通水路不能乱加 A/B。</p><p class="accent">到达终点时，总行动数必须恰好等于“行动 = N”，少用或多用都失败。任何格子都不能重复经过，包括起点，到终点后不能还有操作。</p></section>
<section class="panel"><h2>输入示例：规定 9，实际 9</h2><div class="example">${sampleSvg}<div><p class="code">AxyyBxxx</p><p>分段：Ax / y / y / Bx / x / x</p><p>移动 6 格，使用 A 一次、B 一次。</p><p class="accent">6＋1＋2＝9，恰好用完，成功！</p><p>若地图规定 10 次行动，这条路线只用 9 次，即使到达终点也会失败。所有恰好用完规定行动数的合法路线都接受。</p></div></div></section>
<section class="panel"><h2>${ENCOUNTER_TIME_LIMIT_MS / 1000} 秒内完成，越快奖励越高</h2><div class="reward"><div>${ENCOUNTER_FULL_REWARD_MS / 1000} 秒内<strong>×2</strong></div><div>45 秒<strong>×1.5</strong></div><div>接近 60 秒<strong>趋近 ×1</strong></div></div><p>计时从图片发送成功开始，到收到首次答案为止。30 秒后倍率线性递减，奖励取整。普通鱼与异色鱼增加金币和钓鱼经验；噩梦与宝藏只增加经验，噩梦效果与宝箱数量照旧。熟练度与图鉴记录按原规则结算。水路遭遇不算完美收竿，不叠加完美收竿经验奖励。</p><p class="accent">首次答错或到 60 秒整，鱼逃走，本次按钓鱼失败结算。遭遇不会额外扣鱼饵或体力，先前已经产生的装备损伤保留。</p></section>
<p class="foot" style="background:rgba(255,255,255,.94);padding:16px;border-radius:14px">只有满足地形、路线、行动数与时限要求才算成功 · 鱼雷事件不触发</p>
</main></body></html>`;
}
