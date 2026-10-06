import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENCOUNTER_RULE_VERSION, generateEncounterMaps, solveEncounter, analyzeEncounterChoices, validateEncounterInput, createEncounterAttempt, submitEncounterAttempt, encounterFingerprint } from "../lib/fishing/encounter.js";
import { buildEncounterHtml } from "../lib/fishing/encounterRenderer.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(pluginRoot, "../..");
const options = new Map();
const switches = new Set(["--verify", "--help"]);
const valueOptions = new Set(["--seed", "--count", "--out", "--preview", "--check", "--answer", "--elapsed"]);
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  if (switches.has(key)) { options.set(key, true); continue; }
  if (!valueOptions.has(key) || process.argv[index + 1] === undefined) throw new Error(`未知参数或缺少参数值：${key}`);
  options.set(key, process.argv[++index]);
}
if (options.has("--help")) {
  process.stdout.write("离线生成钓鱼遭遇：\n  node plugins/sakura-plugin/scripts/generate-fishing-encounters.mjs --seed 任意种子 --count 5\n  --out 输出目录，--preview 总览图片路径\n  --verify 只校验现有关卡与 PNG，不启动浏览器\n  --check 关卡编号 --answer 操作串 --elapsed 毫秒：校验输入与奖励倍率\n");
  process.exit(0);
}
const outputDir = path.resolve(options.get("--out") || path.join(pluginRoot, "resources/fish/encounters"));
const manifestPath = path.join(outputDir, "levels.json");

if (options.has("--check") || options.has("--verify")) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.version !== ENCOUNTER_RULE_VERSION) throw new Error("关卡清单不是当前 A/B 行动成本版本，请先重新生成地图");
  if (options.has("--check")) {
    const map = manifest.maps.find(entry => entry.id === options.get("--check"));
    if (!map) throw new Error("找不到指定关卡");
    const elapsedMs = Number(options.get("--elapsed") ?? 0);
    const result = submitEncounterAttempt(createEncounterAttempt(map, 0), options.get("--answer") || "", elapsedMs);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    const fingerprints = new Set();
    const results = [];
    for (const map of manifest.maps) {
      const routes = solveEncounter(map);
      if (!routes.length || routes.some(route => !validateEncounterInput(map, route.sequence).success)) throw new Error(`关卡校验失败：${map.id}`);
      const choices = analyzeEncounterChoices(map);
      if (!choices.hasMeaningfulChoice) throw new Error(`关卡缺少有效路线取舍：${map.id}`);
      if (choices.routes.some(route => validateEncounterInput(map, route.sequence).success !== (route.actions === map.limits.actions))) throw new Error(`路线行动数判定不一致：${map.id}`);
      const fingerprint = encounterFingerprint(map);
      if (fingerprints.has(fingerprint)) throw new Error(`关卡或左右镜像重复：${map.id}`);
      fingerprints.add(fingerprint);
      const png = await fs.readFile(path.join(outputDir, `${map.id}.png`));
      if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error(`图片不是 PNG：${map.id}`);
      results.push({ id: map.id, ...choiceSummary(map, choices), width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
    }
    process.stdout.write(JSON.stringify({ verified: results }, null, 2) + "\n");
  }
  process.exit(0);
}

const seed = options.get("--seed") || "sakura-fishing-20261006";
const count = Number(options.get("--count") || 5);
const maps = generateEncounterMaps({ count, seed }).map((map, index) => ({ ...map, id: `encounter-${String(index + 1).padStart(2, "0")}`, name: `浅湾 ${index + 1}` }));
const fontData = (await fs.readFile(path.join(pluginRoot, "resources/sign/font/FZFWZhuZiAYuanJWD.ttf"))).toString("base64");
await fs.mkdir(outputDir, { recursive: true });
const profilePath = path.join(repoRoot, ".cache/fishing-encounters-chrome");
await fs.mkdir(profilePath, { recursive: true });
// 仅渲染时顺序加载浏览器依赖，纯校验不依赖 Chrome。
const { default: puppeteer } = await import("puppeteer");
const { default: chromeConfig } = await import("../../../.puppeteerrc.cjs");
const browser = await puppeteer.launch({ headless: true, executablePath: chromeConfig.executablePath, userDataDir: profilePath, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"] });
try {
  const page = await browser.newPage();
  // 禁止页面访问外网；字体和所有地图图形都已内嵌。
  await page.setRequestInterception(true);
  page.on("request", request => request.url().startsWith("data:") || request.url() === "about:blank" ? request.continue() : request.abort());
  await page.setViewport({ width: 900, height: 1500, deviceScaleFactor: 2 });
  const results = [];
  for (const map of maps) {
    await page.setContent(buildEncounterHtml(map, { fontData }), { waitUntil: "domcontentloaded" });
    await page.evaluate(() => document.fonts.ready);
    const layout = await page.evaluate(() => ({ height: document.querySelector(".card").getBoundingClientRect().height, overflow: [...document.querySelectorAll(".card,.limits,.limit")].some(element => element.scrollWidth > element.clientWidth) }));
    if (layout.overflow) throw new Error(`地图文字溢出：${map.id}`);
    await (await page.$(".card")).screenshot({ path: path.join(outputDir, `${map.id}.png`), type: "png" });
    const choices = analyzeEncounterChoices(map);
    results.push({ id: map.id, ...choiceSummary(map, choices), logicalSize: [900, layout.height] });
  }
  // 清单保存地形与限制；运行时可直接读清单并发送对应本地 PNG。
  await fs.writeFile(manifestPath, JSON.stringify({ version: ENCOUNTER_RULE_VERSION, seed, maps }, null, 2) + "\n", "utf8");
  if (options.has("--preview")) {
    const previewPath = path.resolve(options.get("--preview"));
    await fs.mkdir(path.dirname(previewPath), { recursive: true });
    const images = await Promise.all(maps.map(async map => `<div class="item"><div class="label">${map.id}</div><img src="data:image/png;base64,${(await fs.readFile(path.join(outputDir, `${map.id}.png`))).toString("base64")}"></div>`));
    await page.setViewport({ width: 1380, height: 1500, deviceScaleFactor: 1.5 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#e6ece1;font-family:'Microsoft YaHei',sans-serif;color:#47624f}.overview{width:1380px;padding:24px;display:grid;grid-template-columns:repeat(3,1fr);gap:22px}.item{background:#f6f6eb;padding:10px;border-radius:14px}.label{font-size:21px;text-align:center;margin:2px 0 12px}img{display:block;width:100%;height:auto}</style></head><body><main class="overview">${images.join("")}</main></body></html>`, { waitUntil: "load" });
    await (await page.$(".overview")).screenshot({ path: previewPath, type: "png" });
  }
  process.stdout.write(JSON.stringify({ seed, outputDir, maps: results }, null, 2) + "\n");
} finally { await browser.close(); }

function choiceSummary(map, choices) {
  return {
    requiredActions: map.limits.actions,
    geometricRoutes: choices.routes.length,
    validRoutes: choices.validRoutes.length,
    underRoutes: choices.underRoutes.length,
    overRoutes: choices.overRoutes.length,
    actionCounts: choices.actionCounts,
    hasMovementObstacleTradeoff: choices.tradeoffPairs.length > 0,
  };
}
