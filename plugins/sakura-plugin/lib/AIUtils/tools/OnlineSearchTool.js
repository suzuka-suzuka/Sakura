import { AbstractTool } from './AbstractTool.js'
import Setting from '../../setting.js'
import { getAI } from '../getAI.js'
import { modelKey, normalizeModelList } from '../aiModels.js'
import { formatBeijingDateTime } from '../currentTime.js'

const MAX_LISTED_SOURCES = 10

function scopeOf(e) {
  return e?.self_id == null ? {} : { selfId: e.self_id }
}

/**
 * 搜索模型列表里只保留开启了自带联网搜索的对话模型，其余跳过并提示。
 */
export function resolveSearchModels(e) {
  const scope = scopeOf(e)
  const configured = normalizeModelList(Setting.getConfig('AI', scope)?.searchModels)
  if (configured.length === 0) return []

  const entries = Setting.getConfig('Models', scope)?.models || []
  const usable = []
  const skipped = []
  for (const name of configured) {
    const entry = entries.find((item) => modelKey(item) === name && (item.type || 'chat') === 'chat')
    if (entry?.nativeWebSearch === true) usable.push(name)
    else skipped.push(name)
  }
  if (skipped.length > 0) {
    logger.warn(`[OnlineSearch] 搜索模型未开启联网搜索或不存在，已跳过：${skipped.join('、')}`)
  }
  return usable
}

// 当前时间由 getAI 追加在系统提示词末尾（调用时传 includeCurrentTime）
export function buildSearchPrompt() {
  return [
    '你是联网检索助手。',
    '用你的联网搜索能力查找问题相关的最新信息，然后给出整理后的结论。',
    '要求：',
    '1. 只陈述搜索到的信息，不编造；查不到就直接说明没有找到可靠信息。',
    '2. 注明关键信息的时间，区分已证实的事实与传言、个人观点或社交平台上的说法；引用社交平台内容时注明发布者和日期。',
    '3. 用简洁的中文回答，直接给结论和要点，不要寒暄。',
  ].join('\n')
}

// Gemini 的来源是这个域名下的跳转链接：很长、会过期、看不出原网站，不给用户。
const GEMINI_REDIRECT_HOST = 'vertexaisearch.cloud.google.com'
// 这些平台的链接第一段路径是账号名，用账号作来源名称比域名更有信息量。
const ACCOUNT_PATH_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.twitter.com'])
const NON_ACCOUNT_PATHS = new Set(['i', 'search', 'hashtag', 'home', 'explore'])

function parseSourceUrl(url) {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/** 标题有时直接就是链接（例如 Grok 的来源），这种标题当作没有。 */
function meaningfulTitle(title) {
  const text = String(title || '').replace(/\s+/g, ' ').trim()
  if (!text || /^(?:https?:\/\/|www\.)\S*$/i.test(text)) return ''
  return text
}

function sourceNameFromUrl(parsed) {
  const host = parsed.hostname.replace(/^www\./, '')
  if (ACCOUNT_PATH_HOSTS.has(host)) {
    const account = parsed.pathname.split('/').filter(Boolean)[0]
    if (account && !NON_ACCOUNT_PATHS.has(account.toLowerCase())) return `@${account}`
  }
  return host
}

/**
 * 整理来源：名称优先用标题，标题缺失或本身是链接时，X/Twitter 用账号、其余用域名；按名称去重。
 * 跳转链接只保留名称，不保留 URL。
 */
export function summarizeSources(citations = []) {
  const sources = []
  const seen = new Set()
  for (const citation of Array.isArray(citations) ? citations : []) {
    const parsed = parseSourceUrl(citation?.url)
    const isRedirect = parsed?.hostname === GEMINI_REDIRECT_HOST
    const fallbackName = parsed && !isRedirect ? sourceNameFromUrl(parsed) : ''
    const name = meaningfulTitle(citation?.title) || fallbackName
    if (!name || seen.has(name)) continue
    seen.add(name)
    sources.push({ name, url: parsed && !isRedirect ? citation.url : '' })
    if (sources.length >= MAX_LISTED_SOURCES) break
  }
  return sources
}

export function formatSearchResult(result, { includeLinks = false, now = new Date() } = {}) {
  const text = String(result?.text || '').trim()
  const sources = summarizeSources(result?.citations)
  // 结果会留在对话历史里，记下检索时间，之后的对话能判断这条结果新不新
  const lines = [`检索时间：${formatBeijingDateTime(now)}（北京时间）`, text || '（搜索模型没有返回内容）']
  if (sources.length === 0) return lines.join('\n')

  if (!includeLinks) {
    lines.push('', `来源：${sources.map((source) => source.name).join('、')}`)
    return lines.join('\n')
  }

  lines.push('', '来源：')
  sources.forEach((source, index) => {
    lines.push(`${index + 1}. ${source.name}${source.url ? ` — ${source.url}` : '（无可用链接）'}`)
  })
  return lines.join('\n')
}

export class OnlineSearchTool extends AbstractTool {
  name = 'OnlineSearch'
  progressText = '联网搜索'
  progressDetail = 'query'

  description = '联网搜索实时或最新信息时使用'

  parameters = {
    properties: {
      query: {
        type: 'string',
        description: '要查什么，用一句完整的问题描述',
      },
      includeLinks: {
        type: 'boolean',
        description: '是否返回来源链接。默认只返回来源名称；只有用户明确要链接或出处时才设为 true',
      },
    },
    required: ['query'],
  }

  /** 没有可用的搜索模型时不提供这个工具。 */
  isAvailable(e) {
    return normalizeModelList(Setting.getConfig('AI', scopeOf(e))?.searchModels).length > 0
  }

  func = async function (opts, e) {
    const query = String(opts?.query || '').trim()
    if (!query) return '需要提供要搜索的问题。'

    const models = resolveSearchModels(e)
    if (models.length === 0) {
      return '联网搜索不可用：AI 设定里没有选择开启了“联网搜索”的搜索模型。'
    }

    // 不带群聊上下文、历史和任何工具，只用模型自带的联网搜索，避免搜索模型再调用本工具。
    const result = await getAI(
      models,
      e,
      [{ text: query }],
      buildSearchPrompt(),
      false,
      false,
      [],
      { includeCurrentTime: true }
    )
    if (typeof result === 'string') {
      return `联网搜索失败：${result}`
    }
    return formatSearchResult(result, { includeLinks: opts?.includeLinks === true })
  }
}
