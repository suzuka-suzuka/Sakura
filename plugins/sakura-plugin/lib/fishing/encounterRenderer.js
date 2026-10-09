import { assertEncounterMap, ENCOUNTER_FULL_REWARD_MS } from "./encounter.js";

const grass = `<ellipse cx="60" cy="77" rx="39" ry="24" fill="#78ab77" opacity=".32"/>
<path d="M29 85 Q17 59 25 39 Q42 62 37 87 M44 86 Q31 43 42 23 Q55 44 53 85 M58 89 Q55 53 68 29 Q76 65 69 87 M72 87 Q76 54 94 41 Q95 72 83 90" fill="#4f916d"/>
<path d="M25 39 Q32 65 34 85 M42 23 Q46 51 48 85 M68 29 Q62 62 62 87 M94 41 Q84 70 78 87" stroke="#b4d6a0" stroke-width="2" fill="none"/>`;
const log = `<g transform="rotate(-12 60 59)"><path d="M18 54 L89 49 L94 75 L22 80Z" fill="#779b95" opacity=".3" transform="translate(0 5)"/>
<path d="M17 44 L91 39 Q104 49 97 68 L24 74 Q11 63 17 44" fill="#916944"/><ellipse cx="22" cy="59" rx="11" ry="15" fill="#cba574"/><ellipse cx="22" cy="59" rx="6" ry="10" fill="none" stroke="#9f7950" stroke-width="2"/>
<path d="M35 47 L90 43 M37 59 L87 53 M38 68 L83 64" stroke="#6d4c34" stroke-width="2.8" stroke-linecap="round"/><path d="M67 44 L71 26 L82 22 L77 44 M43 72 L54 87 L62 88 L54 69" fill="#916944"/></g>`;
const fish = `<circle cx="60" cy="57" r="42" fill="#fff4d8" stroke="#cfae73" stroke-width="3"/>
<path d="M60 35 L44 22 L44 41 L60 45 L76 41 L76 22Z" fill="#c77954"/><ellipse cx="60" cy="57" rx="17" ry="26" fill="#dd9968"/><path d="M44 49 L30 59 L44 63 M76 49 L90 59 L76 63" fill="#c77954"/>
<path d="M56 39 Q51 59 57 74" fill="none" stroke="#efba82" stroke-width="3"/><circle cx="51" cy="67" r="3" fill="#4c5443"/><circle cx="69" cy="67" r="3" fill="#4c5443"/>`;
const net = `<circle cx="60" cy="55" r="42" fill="#f5fae7" stroke="#7d9d67" stroke-width="3"/>
<ellipse cx="60" cy="50" rx="27" ry="24" fill="#d7e4bc"/><path d="M38 37 L82 62 M34 50 L75 74 M44 26 L87 50 M40 69 L72 26 M52 75 L83 34 M33 57 L59 26" stroke="#8ba77a" stroke-width="1.8"/>
<ellipse cx="60" cy="50" rx="27" ry="24" fill="none" stroke="#637b52" stroke-width="3"/><path d="M60 75 V99" stroke="#916944" stroke-width="5" stroke-linecap="round"/>`;

function tileBackground(x, y, type) {
  if (type !== "#") {
    const rippleY = 21 + ((x * 7 + y * 13) % 24);
    return `<rect x="3" y="3" width="114" height="114" rx="12" fill="${type === "G" ? "#cce9d6" : "#b9e4e4"}"/>
<path d="M13 ${rippleY} q10 -5 20 0 t20 0 M62 ${rippleY + 24} q10 -5 20 0 t18 0 M23 95 q10 -5 20 0 t20 0" fill="none" stroke="#89c6ce" stroke-width="2.8" opacity=".62"/>
<path d="M20 67 q9 -4 18 0" fill="none" stroke="#eaf9f4" stroke-width="3" opacity=".85"/>`;
  }
  const variants = [
    '<path d="M18 26 q21 -15 34 9 q-4 24 -25 25 q-21 -5 -9 -34" fill="#bbbda9"/><path d="M65 65 q26 -15 32 11 q0 19 -22 24 q-25 -7 -10 -35" fill="#c4c6b3"/>',
    '<path d="M20 60 q6 -28 31 -26 q21 8 18 33 q-19 22 -40 13z" fill="#bdc0ad"/><path d="M75 18 q17 -5 23 14 q-4 22 -24 18 q-16 -16 1 -32" fill="#c8cab9"/>',
    '<path d="M30 17 q23 -10 37 11 q9 19 -9 26 q-27 7 -37 -14z" fill="#bdc0ad"/><path d="M55 73 q19 -14 34 0 q13 16 -4 26 q-28 13 -34 -9z" fill="#c7cab6"/>',
  ];
  return `<rect x="3" y="3" width="114" height="114" rx="12" fill="#d6dac5"/>${variants[(x + y) % 3]}
<path d="M11 105 l3 -10 l4 10 M94 58 l2 -9 l4 10" stroke="#8b9a75" stroke-width="2.2" fill="none" opacity=".7"/>`;
}

function shore(width, height, goalX) {
  const top = height * 120, center = goalX * 120 + 60;
  return `<g transform="translate(0 ${top})"><rect width="${width * 120}" height="90" fill="#e3d8b9"/><path d="M0 4 H${width * 120}" stroke="#c5b78f" stroke-width="3"/>
<path d="M25 35 l4 -13 l6 14 M126 65 l4 -10 l5 11 M${width * 120 - 130} 28 l3 -12 l6 13" stroke="#a5ab79" stroke-width="3" fill="none"/><ellipse cx="54" cy="65" rx="15" ry="7" fill="#c7bea2"/>
<g transform="translate(${center - 540} 0)"><rect x="501" width="78" height="90" fill="#b28a60"/><path d="M506 19 H574 M506 39 H574 M506 59 H574 M506 79 H574" stroke="#d2ad7d" stroke-width="2"/>
<path d="M552 52 L586 -9" stroke="#614d35" stroke-width="3" stroke-linecap="round"/><path d="M586 -9 Q589 -31 565 -49" stroke="#718d78" stroke-width="1.5" fill="none"/>
<path d="M531 65 V80 M548 65 V80" stroke="#485e58" stroke-width="7" stroke-linecap="round"/><rect x="525" y="42" width="30" height="26" rx="8" fill="#578c99"/><path d="M552 49 L562 45" stroke="#ebc5a0" stroke-width="6" stroke-linecap="round"/>
<circle cx="540" cy="35" r="11" fill="#ebc5a0"/><ellipse cx="540" cy="28" rx="23" ry="6" fill="#e2bc77"/><path d="M526 26 Q527 10 540 10 Q553 10 554 26Z" fill="#d2a962"/></g></g>`;
}

export function buildEncounterHtml(map, { fontData = "" } = {}) {
  const { width, height, goal } = assertEncounterMap(map);
  const overlays = { A: grass, B: log, S: fish, G: net };
  const cells = map.rows.flatMap((row, y) => [...row].map((type, x) =>
    `<g transform="translate(${x * 120} ${y * 120})">${tileBackground(x, y, type)}${overlays[type] || ""}</g>`)).join("");
  const embeddedFont = fontData ? `@font-face{font-family:Encounter;src:url(data:font/ttf;base64,${fontData}) format('truetype')}` : "";
  // 地图下方仅补充按键与双倍奖励提示，不展示关卡答案。
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
${embeddedFont}
*{box-sizing:border-box}body{margin:0;background:#f6f6eb;color:#325b4d;font-family:Encounter,'Microsoft YaHei',sans-serif}
.card{width:900px;padding:16px;background:#f6f6eb}.map{display:block;width:100%;height:auto;border:7px solid #a4c8b4;border-radius:20px;background:#93c6c4;overflow:hidden}
.limits{display:flex;justify-content:center;padding:20px 20px 9px;font-size:36px;line-height:1.35;font-weight:700}
.limit{display:flex;align-items:center;justify-content:center;gap:14px;white-space:nowrap}.count{color:#325b4d;font-size:40px}
.controls{margin-top:10px;padding:14px 8px 4px;border-top:2px solid #d4dfcf;text-align:center;font-size:25px;line-height:1.5}
.directions,.abilities{display:flex;justify-content:center;align-items:center;gap:30px;white-space:nowrap}.directions{margin-bottom:8px}.directions span{display:flex;align-items:center;gap:9px}
kbd{display:inline-block;min-width:34px;padding:0 8px;border:2px solid #a4c8b4;border-radius:7px;background:#fffdf3;font:700 25px/1.4 'Microsoft YaHei',sans-serif}.abilities{gap:32px;font-size:23px}.reward{margin-top:12px;color:#477c50;font-size:28px;font-weight:700}
</style></head><body><main class="card"><svg class="map" viewBox="0 0 ${width * 120} ${height * 120 + 90}" role="img" aria-label="钓鱼水路">${cells}${shore(width, height, goal[0])}</svg>
<div class="limits"><div class="limit">行动 = <span class="count">${map.limits.actions}</span></div></div>
<div class="controls"><div class="directions"><span>上 <kbd>s</kbd></span><span>下 <kbd>x</kbd></span><span>左 <kbd>z</kbd></span><span>右 <kbd>y</kbd></span></div>
<div class="abilities"><span><kbd>A</kbd>＋方向：水草（2行动）</span><span><kbd>B</kbd>＋方向：漂木（3行动）</span></div>
<div class="reward">${ENCOUNTER_FULL_REWARD_MS / 1000}秒内通过，双倍奖励</div></div></main></body></html>`;
}
