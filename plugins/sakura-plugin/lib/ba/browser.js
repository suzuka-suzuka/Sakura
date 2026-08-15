/**
 * 战斗图渲染用的 Chromium 单例。
 *
 * 回合制每个回合都要出一张图，每次 launch/close 要 1~2 秒冷启动，体感很差；
 * 这里复用同一个浏览器实例，只按需开关页面。进程退出时自动收尾。
 */
import puppeteer from "puppeteer"

const LAUNCH_ARGS = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--font-render-hinting=none"]

let browserPromise = null

export async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({ args: LAUNCH_ARGS }).catch((error) => {
      browserPromise = null
      throw error
    })
  }
  const browser = await browserPromise
  // 实例被外部杀掉时重开一个，避免整局对战卡死
  if (!browser.connected) {
    browserPromise = null
    return getBrowser()
  }
  return browser
}

/**
 * 渲染一段 HTML 并截图。
 * @param {string} html 完整页面
 * @param {{width:number, height:number, selector?:string, scale?:number}} opts
 * @returns {Promise<Buffer>} PNG
 */
export async function shotHtml(html, { width, height, selector, scale = 1 }) {
  const browser = await getBrowser()
  const page = await browser.newPage()
  try {
    await page.setViewport({ width, height, deviceScaleFactor: scale })
    await page.setContent(html, { waitUntil: "domcontentloaded" })
    // 字体没就位就截图会拿到 fallback 字形
    await page.evaluateHandle("document.fonts.ready").catch(() => null)
    if (selector) {
      const el = await page.$(selector)
      if (!el) throw new Error(`截图节点 ${selector} 不存在`)
      return await el.screenshot({ type: "png" })
    }
    return await page.screenshot({ type: "png" })
  } finally {
    await page.close().catch(() => {})
  }
}

export async function closeBrowser() {
  if (!browserPromise) return
  const p = browserPromise
  browserPromise = null
  await p.then((b) => b.close()).catch(() => {})
}

for (const sig of ["exit", "SIGINT", "SIGTERM"]) {
  process.once(sig, () => { closeBrowser() })
}
