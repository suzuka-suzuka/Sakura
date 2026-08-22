const GOOGLE_HOST_PATTERN = /(^|\.)google\.(?:com|cat|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/i
const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_CONCURRENCY = 4
const DEFAULT_MAX_RESULT_REDIRECTS = 24

function normalizeHttpUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl)
    return /^https?:$/i.test(url.protocol) ? url.href : ''
  } catch {
    return ''
  }
}

function escapeMarkdownUrl(value) {
  return String(value || '').replace(/\)/g, '%29')
}

function replaceResolvedUrl(text, sourceUrl, targetUrl) {
  if (!text || !sourceUrl || !targetUrl || sourceUrl === targetUrl) return text

  const escapedSource = escapeMarkdownUrl(sourceUrl)
  const escapedTarget = escapeMarkdownUrl(targetUrl)
  let output = String(text)

  if (escapedSource !== sourceUrl) {
    output = output.split(escapedSource).join(escapedTarget)
  }

  return output.split(sourceUrl).join(escapedTarget)
}

function extractGoogleGotoUrls(text = '') {
  const matches = String(text).match(/https?:\/\/[^\s<>()\]]+/g) || []
  return matches.filter(isGoogleGotoUrl)
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!items.length) return []

  const results = new Array(items.length)
  let nextIndex = 0

  const worker = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await mapper(items[currentIndex], currentIndex)
    }
  }

  const workerCount = Math.min(
    items.length,
    Math.max(1, Math.floor(Number(concurrency) || DEFAULT_CONCURRENCY))
  )
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

export function isGoogleGotoUrl(value) {
  const normalized = normalizeHttpUrl(value)
  if (!normalized) return false

  const url = new URL(normalized)
  const pathname = url.pathname.replace(/\/+$/, '') || '/'
  return GOOGLE_HOST_PATTERN.test(url.hostname) &&
    pathname === '/goto' &&
    Boolean(url.searchParams.get('url'))
}

export async function resolveGoogleGotoUrl(value, options = {}) {
  const originalUrl = normalizeHttpUrl(value)
  if (!originalUrl || !isGoogleGotoUrl(originalUrl)) return originalUrl || String(value || '')

  const {
    fetchImpl = globalThis.fetch,
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options

  if (typeof fetchImpl !== 'function') return originalUrl

  const controller = new AbortController()
  const safeTimeoutMs = Math.max(0, Number(timeoutMs) || 0)
  const timer = safeTimeoutMs > 0
    ? setTimeout(() => controller.abort(), safeTimeoutMs)
    : null

  try {
    const response = await fetchImpl(originalUrl, {
      method: 'GET',
      redirect: 'manual',
      headers,
      signal: controller.signal,
    })

    if (response.status < 300 || response.status >= 400) return originalUrl

    const location = response.headers?.get?.('location')
    const resolvedUrl = normalizeHttpUrl(location, originalUrl)
    return resolvedUrl && resolvedUrl !== originalUrl ? resolvedUrl : originalUrl
  } catch {
    return originalUrl
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function resolveGoogleSearchRedirects(scrapedData = {}, options = {}) {
  const results = Array.isArray(scrapedData.results) ? scrapedData.results : []
  const aiLinks = Array.isArray(scrapedData.aiLinks) ? scrapedData.aiLinks : []
  const maxResultRedirects = Math.max(
    0,
    Math.floor(Number(options.maxResultRedirects) || DEFAULT_MAX_RESULT_REDIRECTS)
  )

  const candidates = [
    ...results.slice(0, maxResultRedirects).map(item => item?.url),
    ...aiLinks,
    ...extractGoogleGotoUrls(scrapedData.aiText),
  ].filter(isGoogleGotoUrl)

  const uniqueCandidates = [...new Set(candidates)]
  const resolver = options.resolver || resolveGoogleGotoUrl
  const resolverOptions = {
    fetchImpl: options.fetchImpl,
    headers: options.headers,
    timeoutMs: options.timeoutMs,
  }

  const resolvedPairs = await mapWithConcurrency(
    uniqueCandidates,
    options.concurrency,
    async sourceUrl => {
      try {
        const targetUrl = await resolver(sourceUrl, resolverOptions)
        return [sourceUrl, normalizeHttpUrl(targetUrl) || sourceUrl]
      } catch {
        return [sourceUrl, sourceUrl]
      }
    }
  )
  const resolvedByUrl = new Map(resolvedPairs)

  let aiText = String(scrapedData.aiText || '')
  for (const [sourceUrl, targetUrl] of resolvedByUrl) {
    aiText = replaceResolvedUrl(aiText, sourceUrl, targetUrl)
  }

  return {
    ...scrapedData,
    aiText,
    results: results.map(item => ({
      ...item,
      url: resolvedByUrl.get(item?.url) || item?.url,
    })),
  }
}
