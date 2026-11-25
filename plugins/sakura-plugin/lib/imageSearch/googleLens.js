import path from 'path'
import fs from 'fs'
import { connect } from 'puppeteer-real-browser'
import { plugindata } from '../path.js'
import { SEARCH_CHANNELS } from './constants.js'
import { delay, dedupeBy, sanitizeGoogleAiText } from './helpers.js'
import { resolveGoogleSearchRedirects } from './googleRedirect.js'

const LENS_ENTRY_LABELS = [
  'Search by image',
  'Search by Image',
  'Search with an image',
  'Google Lens',
  'Google レンズ',
  'Google レンズで画像を検索',
  '画像で検索',
  '画像検索',
  '按图搜索',
  '按图片搜索',
  '以图搜索',
  '以图片搜索',
  '搜尋圖片',
  '按圖搜尋',
  '按圖片搜尋',
  '以圖搜尋',
  '以圖片搜尋',
]

const LENS_ENTRY_SELECTORS = [
  '[data-is-images-mode="true"]',
  'div[jsname="R5mgy"]',
  '[aria-label="Search by image"]',
  '[aria-label="画像で検索"]',
  '[aria-label*="Search by image" i][role="button"]',
  '[aria-label*="Google Lens" i][role="button"]',
  '[aria-label*="画像"][role="button"]',
  '[aria-label*="按图"][role="button"]',
  '[aria-label*="按图片"][role="button"]',
  '[aria-label*="以图"][role="button"]',
  '[aria-label*="搜尋"][role="button"]',
  '[aria-label*="按圖片"][role="button"]',
]

// 弹窗里"上传文件"按钮的文字，按整段文字精确匹配，避免命中"将图片放到此处或上传文件"这类外层容器
const LENS_UPLOAD_BUTTON_LABELS = [
  '上传文件',
  '上傳檔案',
  '上傳文件',
  'upload a file',
  'upload file',
  'ファイルをアップロード',
]

const GOOGLE_LENS_LANGUAGE = 'zh-CN'
const GOOGLE_LENS_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8'
const GOOGLE_IMAGES_URL = 'https://images.google.com/?hl=zh-CN&gl=CN'
const LENS_POPUP_TIMEOUT = 10000
const LENS_FILE_CHOOSER_TIMEOUT = 10000
const LENS_DEBUG_SCREENSHOT = 'google-lens-debug.png'
// 结果页：结果约 1 秒出来，AI 概览要再过 2~8 秒才开始流式输出，而且不一定有
const LENS_RESULTS_TIMEOUT = 15000
const LENS_AI_OVERVIEW_WAIT = 10000
const LENS_AI_OVERVIEW_SETTLE = 2000
const LENS_RESULTS_MAX_WAIT = 30000
// 被 Google 限流（/sorry 页，HTTP 429）时换新浏览器会话重试，间隔按次数翻倍：3s、6s
const GOOGLE_BLOCKED_RETRIES = 2
const GOOGLE_BLOCKED_RETRY_DELAY = 3000

class GoogleBlockedError extends Error {
  constructor(message = 'Google 返回了人机验证/异常流量页面，请先在浏览器中完成验证，或更换出口 IP/稍后再试。') {
    super(message)
    this.name = 'GoogleBlockedError'
  }
}

function isGoogleSorryUrl(url) {
  return /\/sorry\//i.test(String(url || ''))
}

async function findLensUploadEntry(page) {
  for (const selector of LENS_ENTRY_SELECTORS) {
    try {
      const element = await page.$(selector)
      if (element) return element
    } catch {
      // 某些 Chromium 版本不支持带 i 标记的属性选择器，忽略后继续走文本匹配
    }
  }

  const handle = await page.evaluateHandle((labels) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
    const normalizedLabels = labels.map(label => normalize(label))
    const candidates = Array.from(document.querySelectorAll('button, a[role="button"], div[role="button"], [aria-label], [title]'))

    return candidates.find(el => {
      const haystack = normalize([
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.textContent,
      ].filter(Boolean).join(' '))

      return normalizedLabels.some(label => haystack.includes(label))
    }) || null
  }, LENS_ENTRY_LABELS)

  const element = handle.asElement()
  if (!element) {
    await handle.dispose()
  }

  return element
}

function toElementOrNull(handle) {
  const element = handle.asElement()
  if (!element) handle.dispose().catch(() => {})
  return element
}

// Lens 的 input 不一定在表单里（目前直接挂在 body 上），也可能藏在 shadow root 里
async function findLensFileInput(page) {
  const handle = await page.evaluateHandle(() => {
    const inputs = []
    const walk = (root) => {
      root.querySelectorAll('input[type="file"]').forEach(el => inputs.push(el))
      root.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) walk(el.shadowRoot)
      })
    }
    walk(document)

    return inputs.find(el => el.name === 'encoded_image') ||
      inputs.find(el => /image/i.test(el.accept || '')) ||
      inputs[0] ||
      null
  })

  return toElementOrNull(handle)
}

async function findLensUploadButton(page) {
  const handle = await page.evaluateHandle((labels) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
    const normalizedLabels = labels.map(label => normalize(label))
    const candidates = Array.from(document.querySelectorAll('[role="button"], button, a, span'))

    return candidates.find(el => {
      const text = normalize(el.textContent || el.getAttribute('aria-label'))
      return normalizedLabels.includes(text) && el.getClientRects().length > 0
    }) || null
  }, LENS_UPLOAD_BUTTON_LABELS)

  return toElementOrNull(handle)
}

// check 抛错（如导航中执行上下文被销毁）按未满足处理，继续轮询
async function pollUntil(check, timeout, interval = 300) {
  const deadline = Date.now() + timeout

  while (true) {
    if (await check().catch(() => false)) return true
    if (Date.now() >= deadline) return false
    await delay(interval)
  }
}

async function waitForLensUploadControl(page, timeout) {
  let control = null

  await pollUntil(async () => {
    const input = await findLensFileInput(page)
    if (input) return (control = { input })

    const button = await findLensUploadButton(page)
    if (button) return (control = { button })

    return false
  }, timeout, 500)

  return control
}

async function openLensUploadControl(page, lensIcon) {
  // 先用 DOM click：坐标点击会被登录提示、推广浮层之类的遮罩吞掉，弹窗就不会打开
  await lensIcon.evaluate(el => el.click())
  const control = await waitForLensUploadControl(page, LENS_POPUP_TIMEOUT)
  if (control) return control

  // 少数情况下入口只响应真实鼠标事件，再试一次
  await lensIcon.click().catch(() => {})
  return waitForLensUploadControl(page, LENS_POPUP_TIMEOUT / 2)
}

async function uploadImageToLens(page, control, imagePath) {
  if (control.input) {
    await control.input.uploadFile(imagePath)
    return
  }

  // 有的版本只在点"上传文件"时才临时创建 input（不挂进 DOM），只能拦截文件选择框
  const [chooser] = await Promise.all([
    page.waitForFileChooser({ timeout: LENS_FILE_CHOOSER_TIMEOUT }),
    control.button.evaluate(el => el.click()),
  ])
  await chooser.accept([imagePath])
}

// 等结果出现；有 AI 概览就等它连续 LENS_AI_OVERVIEW_SETTLE 不再变化（生成完），
// 没有就在结果出现后最多再等 LENS_AI_OVERVIEW_WAIT。被重定向到 /sorry 立即返回
async function waitForLensResults(page) {
  const start = Date.now()
  let resultsAt = 0
  let lastSnapshot = ''
  let stableSince = 0

  while (!isGoogleSorryUrl(page.url())) {
    const now = Date.now()
    if (now - start >= LENS_RESULTS_MAX_WAIT) return

    const state = await page.evaluate(() => {
      const text = document.body?.innerText || ''
      return {
        hasResults: document.querySelectorAll('a[href]:not([href*="google.com"])').length > 3 ||
          Boolean(document.querySelector('a[href*="/goto"]')),
        hasAiOverview: /AI 概览|AI Overview/.test(text),
        snapshot: `${document.querySelectorAll('a[href]').length}|${text.length}`,
      }
    }).catch(() => null)

    if (state?.hasResults) {
      if (!resultsAt) resultsAt = now
      if (state.snapshot !== lastSnapshot) {
        lastSnapshot = state.snapshot
        stableSince = now
      }

      if (state.hasAiOverview ? now - stableSince >= LENS_AI_OVERVIEW_SETTLE : now - resultsAt >= LENS_AI_OVERVIEW_WAIT) {
        return
      }
    } else if (now - start >= LENS_RESULTS_TIMEOUT) {
      return
    }

    await delay(500)
  }
}

async function saveDebugScreenshot(page) {
  const screenshotPath = path.resolve(plugindata, LENS_DEBUG_SCREENSHOT)
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true })
    return screenshotPath
  } catch {
    return ''
  }
}

async function assertGooglePageUsable(page) {
  const pageState = await page.evaluate(() => ({
    url: window.location.href,
    title: document.title || '',
    text: document.body?.innerText?.slice(0, 1200) || '',
    hasCaptcha: Boolean(document.querySelector('#captcha-form, .g-recaptcha, iframe[src*="recaptcha"]')),
  })).catch(() => ({ url: page.url(), title: '', text: '', hasCaptcha: false }))

  if (
    pageState.hasCaptcha ||
    isGoogleSorryUrl(pageState.url) ||
    /unusual traffic|detected unusual traffic|captcha|recaptcha|人机验证|異常なトラフィック/i.test(pageState.text)
  ) {
    throw new GoogleBlockedError()
  }
}

async function getPageBrief(page) {
  return page.evaluate(() => ({
    url: window.location.href,
    title: document.title || '',
    text: document.body?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 200) || '',
  })).catch(() => ({ url: page.url(), title: '', text: '' }))
}

async function prepareChineseGoogleLocale(page) {
  await page.setExtraHTTPHeaders({
    'Accept-Language': GOOGLE_LENS_ACCEPT_LANGUAGE,
  })

  await page.evaluateOnNewDocument((language) => {
    Object.defineProperty(navigator, 'language', { get: () => language })
    Object.defineProperty(navigator, 'languages', { get: () => [language, 'zh', 'en'] })
  }, GOOGLE_LENS_LANGUAGE)
}

export async function searchGoogleLens(imagePath, options = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      // 重试时不再等 120 秒手动登录，第一次已经等过了
      return await runGoogleLensSearch(imagePath, attempt === 0 ? options : { ...options, waitForLogin: false })
    } catch (error) {
      if (error instanceof GoogleBlockedError) {
        if (attempt < GOOGLE_BLOCKED_RETRIES) {
          const wait = GOOGLE_BLOCKED_RETRY_DELAY * 2 ** attempt
          logger.warn(`[ImageSearch][GoogleLens] Google 限流（人机验证/429），${wait / 1000} 秒后重试（${attempt + 1}/${GOOGLE_BLOCKED_RETRIES}）`)
          await delay(wait)
          continue
        }

        logger.error(`[ImageSearch][GoogleLens] Google 连续 ${attempt + 1} 次限流，放弃本次搜图`)
        throw new GoogleBlockedError(`Google 连续 ${attempt + 1} 次返回人机验证/限流页面，请稍后再试，或在浏览器中完成验证/更换出口 IP。`)
      }

      logger.error('[ImageSearch][GoogleLens] 执行过程遭遇异常:', error)
      throw error
    }
  }
}

async function runGoogleLensSearch(imagePath, options = {}) {
  const { googleLogin = true, waitForLogin = googleLogin } = options
  const userDataDir = path.resolve(plugindata, 'google-lens-profile')
  const profileExists = fs.existsSync(userDataDir)
  const useProfile = profileExists || googleLogin

  if (useProfile && !profileExists) {
    fs.mkdirSync(userDataDir, { recursive: true })
  }

  let disableXvfb = false
  if (process.platform === 'linux' && googleLogin && !profileExists) {
    disableXvfb = true // 首次登录时尽量弹出真实浏览器，便于手动完成 Google 登录
  }

  const { browser, page } = await connect({
    headless: false,
    turnstile: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--lang=${GOOGLE_LENS_LANGUAGE}`],
    disableXvfb: disableXvfb,
    customConfig: useProfile ? { userDataDir } : {},
    connectOption: { defaultViewport: null },
  })

  try {
    await prepareChineseGoogleLocale(page)
    await page.goto(GOOGLE_IMAGES_URL, { waitUntil: 'networkidle2' })

    const signInButton = await page.$('a[href^="https://accounts.google.com/ServiceLogin"]')
    if (signInButton) {
      if (waitForLogin) {
        logger.info('[ImageSearch][GoogleLens] 检测到未登录状态，请在弹出的浏览器窗口中手动登录，程序将等待 120秒...')
        try {
          await page.waitForFunction(() => !document.querySelector('a[href^="https://accounts.google.com/ServiceLogin"]'), { timeout: 120000 })
          logger.info('[ImageSearch][GoogleLens] 登录检测完成，继续执行...')
        } catch (e) {
          logger.info('[ImageSearch][GoogleLens] 等待登录超时，将以当前状态继续执行...')
        }
      } else {
        logger.info('[ImageSearch][GoogleLens] 检测到未登录状态，配置为不等待登录，将以当前状态继续执行...')
      }
    }

    await assertGooglePageUsable(page)

    await page.waitForFunction(({ labels, selectors }) => {
      for (const selector of selectors) {
        try {
          if (document.querySelector(selector)) return true
        } catch {
        }
      }

      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
      const normalizedLabels = labels.map(label => normalize(label))
      return Array.from(document.querySelectorAll('button, a[role="button"], div[role="button"], [aria-label], [title]')).some(el => {
        const haystack = normalize([
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.textContent,
        ].filter(Boolean).join(' '))

        return normalizedLabels.some(label => haystack.includes(label))
      })
    }, { timeout: 15000 }, { labels: LENS_ENTRY_LABELS, selectors: LENS_ENTRY_SELECTORS }).catch(() => {})

    const lensIcon = await findLensUploadEntry(page)
    if (!lensIcon) {
      const pageBrief = await getPageBrief(page)
      throw new Error(`无法在谷歌页面中找到 Lens 上传入口。当前页面: ${pageBrief.title || '无标题'} ${pageBrief.url} ${pageBrief.text}`)
    }

    const uploadControl = await openLensUploadControl(page, lensIcon)
    if (!uploadControl) {
      await assertGooglePageUsable(page)
      const pageBrief = await getPageBrief(page)
      const screenshotPath = await saveDebugScreenshot(page)
      if (screenshotPath) {
        logger.warn(`[ImageSearch][GoogleLens] 未找到上传控件，页面截图已保存到 ${screenshotPath}`)
      }
      throw new Error(`弹出区域内没有找到文件上传控件。当前页面: ${pageBrief.title || '无标题'} ${pageBrief.url} ${pageBrief.text}`)
    }

    const urlBeforeUpload = page.url()
    await uploadImageToLens(page, uploadControl, path.resolve(imagePath))

    // 上传后页面会跳转：跨导航的 waitForFunction 在 rebrowser-puppeteer 下等不到新文档，
    // 每次都会白等满超时，所以这里改成在 Node 侧轮询
    await pollUntil(async () => {
      const url = page.url()
      return url !== urlBeforeUpload && (url.includes('/search') || url.includes('lens.google'))
    }, 30000)

    await waitForLensResults(page)

    // 结果页正文可能本来就提到"人机验证"之类的词，这里只认 /sorry 地址，不复用正文匹配
    if (isGoogleSorryUrl(page.url())) {
      throw new GoogleBlockedError()
    }

    const scrapedData = await page.evaluate(() => {
      const GOOGLE_HOST_PATTERN = /(^|\.)google\./i

      const normalizeInlineText = (value) => String(value || '').replace(/\s+/g, ' ').trim()

      const isGoogleHost = (hostname) => GOOGLE_HOST_PATTERN.test(hostname) || hostname === 'lens.google.com'

      const isUnwantedGoogleLink = (url, text = '') => {
        const normalizedText = normalizeInlineText(text).toLowerCase()
        const hostname = String(url.hostname || '').toLowerCase()
        const href = String(url.href || '').toLowerCase()

        return hostname === 'policies.google.com' ||
          hostname === 'accounts.google.com' ||
          hostname === 'myaccount.google.com' ||
          /(^|\.)consent\.google\./i.test(hostname) ||
          /\b(privacy|terms|policy|policies|service[-_ ]?terms)\b/i.test(href) ||
          /(隐私|隱私|隐私权|隱私權|隐私政策|隱私政策|条款|條款|服务条款|服務條款|privacy|terms|policy|policies)/i.test(normalizedText)
      }

      const normalizeHref = (href, allowGoogleLink = false, linkText = '') => {
        if (!href) return ''

        try {
          const url = new URL(href, window.location.href)
          if (!/^https?:$/i.test(url.protocol)) return ''

          if (isGoogleHost(url.hostname)) {
            if (isUnwantedGoogleLink(url, linkText)) return ''

            const nestedKeys = ['url', 'q', 'imgrefurl', 'u']
            for (const key of nestedKeys) {
              const nested = url.searchParams.get(key)
              if (nested && /^https?:\/\//i.test(nested)) {
                try {
                  const nestedUrl = new URL(nested)
                  return isUnwantedGoogleLink(nestedUrl, linkText) ? '' : nestedUrl.href
                } catch {
                  return nested
                }
              }
            }

            const normalizedPath = url.pathname.replace(/\/+$/, '') || '/'
            if (normalizedPath === '/goto' && url.searchParams.get('url')) {
              return url.href
            }

            return allowGoogleLink ? url.href : ''
          }

          return url.href
        } catch {
          return ''
        }
      }

      const escapeMarkdownText = (value) => normalizeInlineText(value)
        .replace(/\\/g, '\\\\')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')

      const escapeMarkdownUrl = (value) => String(value || '').replace(/\)/g, '%29')

      const buildMarkdownLink = (link) => `[${escapeMarkdownText(link.text)}](${escapeMarkdownUrl(link.url)})`

      const appendBeforeGoogleDisclaimer = (content, appendix) => {
        const match = String(content || '').match(/\s*(在 AI 模式下深入探索|AI 的回答未必正确无误，请注意核查)[\s\S]*$/u)
        if (typeof match?.index === 'number') {
          return `${content.slice(0, match.index).trimEnd()}\n\n${appendix}${content.slice(match.index)}`
        }

        return `${content}\n\n${appendix}`
      }

      const stripGoogleAiResultBlock = (text) => {
        const lines = String(text || '').replace(/\u00a0/g, ' ').split('\n')
        const normalizedLines = lines.map(line => normalizeInlineText(line))
        const entries = normalizedLines
          .map((line, index) => ({ line, index }))
          .filter(item => item.line)

        const isPlusCountLine = (line) => /^[+＋]?\s*\d+\s*$/u.test(line)
        const isSourcePlusLine = (line) => /[+＋]\s*\d+\s*$/u.test(line) && !isPlusCountLine(line)
        const isWebsiteCountLine = (line) => /^\d+\s*(?:个网站|個網站|個网站|sites?)$/iu.test(line)
        const isShowAllLine = (line) => /^(全部显示|全部顯示|全部展示|show all)$/iu.test(line)
        const isSearchResultSnippetLine = (line) => /^(?:\d{4}年\d{1,2}月\d{1,2}日|(?:\d+\s*)?(?:秒|分钟|分鐘|小时|小時|天|周|週|个月|個月|年)前|[A-Z][a-z]{2,9}\s+\d{1,2},\s+\d{4})\s*[—-]/u.test(line)

        let cutIndex = -1
        const markCut = (index) => {
          const safeIndex = Math.max(0, index)
          cutIndex = cutIndex === -1 ? safeIndex : Math.min(cutIndex, safeIndex)
        }

        for (let pos = 0; pos < entries.length; pos += 1) {
          const current = entries[pos]
          const previous = entries[pos - 1]
          const previous2 = entries[pos - 2]
          const next = entries[pos + 1]
          const next2 = entries[pos + 2]
          const line = current.line

          if (next && next2 && isPlusCountLine(next.line) && isWebsiteCountLine(next2.line)) {
            markCut(current.index)
            break
          }

          if (next && next2 && isSourcePlusLine(next.line) && isWebsiteCountLine(next2.line)) {
            markCut(next.index)
            break
          }

          if ((isPlusCountLine(line) || isSourcePlusLine(line)) && next && isWebsiteCountLine(next.line)) {
            markCut(isSourcePlusLine(line) ? current.index : (previous?.index ?? current.index))
            break
          }

          if (isWebsiteCountLine(line)) {
            if (previous && (isPlusCountLine(previous.line) || isSourcePlusLine(previous.line))) {
              markCut(isSourcePlusLine(previous.line) ? previous.index : (previous2?.index ?? previous.index))
            } else {
              markCut(previous?.index ?? current.index)
            }
            break
          }

          if (isSearchResultSnippetLine(line) && previous) {
            markCut(previous.index)
            break
          }

          if (isShowAllLine(line)) {
            markCut(current.index)
            break
          }
        }

        return cutIndex === -1 ? String(text || '').trim() : lines.slice(0, cutIndex).join('\n').trim()
      }

      const isNoisyLinkText = (text) => {
        const normalized = normalizeInlineText(text).toLowerCase()
        return !normalized ||
          normalized.length > 80 ||
          normalized.startsWith('http://') ||
          normalized.startsWith('https://') ||
          /(隐私|隱私|隐私权|隱私權|隐私政策|隱私政策|条款|條款|服务条款|服務條款|privacy|terms|policy|policies)/i.test(normalized) ||
          /^(更多|更多内容|反馈|分享|复制链接|打开|查看|访问|搜索|图片|网页|登录|设置|工具|more|feedback|share|copy link|open|visit|search|images|sign in|settings|tools)$/i.test(normalized)
      }

      const collectLinks = (root, allowGoogleLink = false) => {
        const seen = new Set()
        const seenUrls = new Set()
        const links = []

        Array.from(root.querySelectorAll('a[href]')).forEach(a => {
          const text = normalizeInlineText(
            a.innerText ||
            a.textContent ||
            a.getAttribute('aria-label') ||
            a.getAttribute('title') ||
            '链接'
          )
          const url = normalizeHref(a.href, allowGoogleLink, text)

          if (!url || isNoisyLinkText(text)) return

          const key = `${text}|${url}`
          if (seen.has(key) || seenUrls.has(url)) return
          seen.add(key)
          seenUrls.add(url)
          links.push({ text, url })
        })

        return links
      }

      const applyMarkdownLinks = (text, links) => {
        let output = String(text || '').replace(/\r/g, '').trim()
        output = stripGoogleAiResultBlock(output)
        if (!output || !links.length) return output

        const referenceLinks = links.slice(0, 8)
        if (referenceLinks.length > 0) {
          const appendix = `引用链接：\n${referenceLinks.map(link => `- ${buildMarkdownLink(link)}`).join('\n')}`
          output = appendBeforeGoogleDisclaimer(output, appendix)
        }

        return output
      }

      let aiText = ''
      let aiLinks = []
      try {
        const possibleHeaders = Array.from(document.querySelectorAll('h1, h2, h3, span, div')).filter(el => {
          if (!el.innerText) return false
          const text = el.innerText.trim()
          return text === 'AI 概览' || text === 'AI Overview' || text.endsWith('AI 概览') || text.endsWith('AI Overview')
        })

        if (possibleHeaders.length > 0) {
          let header = possibleHeaders[possibleHeaders.length - 1]
          let container = header.parentElement

          for (let index = 0; index < 6; index += 1) {
            if (container && container.innerText && container.innerText.length > header.innerText.length + 30) {
              const collectedLinks = collectLinks(container, true)
              aiLinks = collectedLinks.map(link => link.url)
              aiText = applyMarkdownLinks(container.innerText, collectedLinks)
              break
            }
            if (container) container = container.parentElement
          }
        }
      } catch {}

      const links = Array.from(document.querySelectorAll('a'))
        .map(a => ({ a, url: normalizeHref(a.href, false, a.innerText) }))
        .filter(({ a, url }) => url && a.innerText.trim().length > 0)

      const results = links.map(({ a, url }) => {
        let parent = a
        for (let index = 0; index < 3 && parent; index += 1) {
          parent = parent.parentElement
        }

        let thumb = null
        if (parent) {
          const imgs = Array.from(parent.querySelectorAll('img'))
          imgs.sort((img1, img2) => (img2.width * img2.height) - (img1.width * img1.height))
          if (imgs.length > 0 && imgs[0].width > 30) {
            thumb = imgs[0].src
          }
        }

        if (!thumb) {
          const img = a.querySelector('img')
          thumb = img ? img.src : null
        }

        return {
          title: a.innerText.replace(/\n /g, ' ').trim(),
          url,
          thumb,
        }
      }).filter(item => item.thumb)

      return { aiText, aiLinks, results }
    })

    const googleCookies = await page.cookies('https://www.google.com/').catch(() => [])
    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '')
    const redirectHeaders = {
      'Accept-Language': GOOGLE_LENS_ACCEPT_LANGUAGE,
    }
    if (userAgent) redirectHeaders['User-Agent'] = userAgent
    if (googleCookies.length > 0) {
      redirectHeaders.Cookie = googleCookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    }

    const resolvedData = await resolveGoogleSearchRedirects(scrapedData, {
      headers: redirectHeaders,
    })

    return {
      channel: SEARCH_CHANNELS.GOOGLE,
      aiText: sanitizeGoogleAiText(resolvedData.aiText),
      items: dedupeBy(resolvedData.results, item => `${item.url}|${item.title}`),
    }
  } finally {
    await browser.close()
  }
}
