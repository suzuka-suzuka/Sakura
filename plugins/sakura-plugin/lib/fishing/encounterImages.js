import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildEncounterHtml } from "./encounterRenderer.js";
import { analyzeEncounterChoices, generateEncounterMaps, validateEncounterInput } from "./encounter.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let fontPromise = null;
let browserPromise = null;
const recentMaps = [];

export function getEncounterFontData() {
  if (!fontPromise) fontPromise = fs.readFile(path.join(pluginRoot, "resources/sign/font/FZFWZhuZiAYuanJWD.ttf")).then(buffer => buffer.toString("base64")).catch(error => { fontPromise = null; throw error; });
  return fontPromise;
}

async function getBrowser() {
  if (!browserPromise) browserPromise = (async () => {
    // 顺序加载 CJS 配置，避免 Node 22 在并行导入时的加载器异常。
    const { default: puppeteer } = await import("puppeteer");
    // 热重载快照复制代码并用 junction 共用资源；从真实资源目录定位项目配置。
    const realResources = await fs.realpath(path.join(pluginRoot, "resources"));
    const { default: config } = await import(pathToFileURL(path.resolve(realResources, "../../..", ".puppeteerrc.cjs")));
    return puppeteer.launch({ headless: true, executablePath: config.executablePath, timeout: 20_000, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"] });
  })().catch(error => { browserPromise = null; throw error; });
  const browser = await browserPromise;
  if (!browser.connected) { browserPromise = null; return getBrowser(); }
  return browser;
}

export async function renderFishingHtml(html, { selector = ".card", width = 900, height = 1500, scale = 2, type = "png", quality } = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  let timeout;
  try {
    await page.setRequestInterception(true);
    page.on("request", request => request.url().startsWith("data:") || request.url() === "about:blank" ? request.continue() : request.abort());
    await page.setViewport({ width, height, deviceScaleFactor: scale });
    const work = (async () => {
      await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(selector => [...document.querySelectorAll(`${selector},.limits,.limit,.directions,.abilities,.reward`)].some(element => element.scrollWidth > element.clientWidth), selector);
      if (overflow) throw new Error("钓鱼图片文字超出布局");
      const element = await page.$(selector);
      if (!element) throw new Error(`钓鱼截图节点不存在：${selector}`);
      return Buffer.from(await element.screenshot({ type, ...(type === "jpeg" ? { quality: quality ?? 92 } : {}) }));
    })();
    return await Promise.race([work, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("钓鱼图片渲染超时")), 25_000); })]);
  } finally {
    clearTimeout(timeout);
    await page.close().catch(() => {});
  }
}

export async function createFishingEncounterImage({ seed = randomUUID() } = {}) {
  const map = generateEncounterMaps({ count: 1, seed, excluded: recentMaps })[0];
  const choices = analyzeEncounterChoices(map);
  if (!choices.hasMeaningfulChoice || choices.routes.some(route => validateEncounterInput(map, route.sequence).success !== (route.actions === map.limits.actions))) throw new Error("遭遇地图校验失败");
  // 先保存布局以避免同时触发的玩家获得同图；只缓存近期布局，不复用图片。
  recentMaps.push(map);
  if (recentMaps.length > 32) recentMaps.shift();
  const fontData = await getEncounterFontData();
  const image = await renderFishingHtml(buildEncounterHtml(map, { fontData }));
  if (image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("遭遇图片不是有效 PNG");
  return { map, image };
}

export async function closeFishingEncounterBrowser() {
  const running = browserPromise;
  browserPromise = null;
  await running?.then(browser => browser.close()).catch(() => {});
}

process.once("exit", () => { void closeFishingEncounterBrowser(); });
