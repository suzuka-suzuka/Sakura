import { AbstractTool } from './AbstractTool.js'
import { fetchMessageByIdentifier } from '../messageLookup.js'
import {
  SEARCH_CHANNELS,
  getSearchImageConfig,
  searchImageByUrl,
} from '../../imageSearch/index.js'

export function formatFirstImageSearchResult(item) {
  if (!item || typeof item !== 'object') return ''

  const title = String(item.title || '').replace(/\s+/g, ' ').trim()
  const url = String(item.url || '').trim()
  const matchedText = title || url
  if (!matchedText) return ''

  const lines = [`匹配结果：${matchedText}`]
  if (title && url) lines.push(`链接：${url}`)

  return lines.join('\n')
}

export function stripImageSearchCitationBlock(text = '') {
  return String(text)
    .replace(/\r/g, '')
    .replace(/\n{0,2}(?:引用链接|引用連結|参考链接|參考連結|Reference links?)[:：][\s\S]*$/iu, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function formatImageSearchToolResult(result) {
  const aiText = stripImageSearchCitationBlock(result?.aiText)
  const firstResult = Array.isArray(result?.items) ? result.items[0] : null
  const formattedResult = formatFirstImageSearchResult(firstResult)
  return [aiText, formattedResult].filter(Boolean).join('\n\n')
}

export class ImageSearchTool extends AbstractTool {
  name = 'ImageSearch'

  description = '搜图工具'

  parameters = {
    properties: {
      seq: {
        type: 'integer',
        description: '图片或动画表情的消息seq',
      },
    },
    required: ['seq'],
  }

  func = async function (opts, e) {
    const { seq } = opts || {}

    if (!seq) {
      return '你必须提供包含图片的消息 seq。'
    }

    let imageUrl
    try {
      const targetMsg = await fetchMessageByIdentifier(e, seq)
      const image = targetMsg?.message?.find((m) => m.type === 'image')
      if (!image?.data?.url) {
        return '未能从该消息中提取到图片。'
      }
      imageUrl = image.data.url
      await e.react(128076, targetMsg.message_id ?? seq)
    } catch (err) {
      logger.error(`[ImageSearchTool] 获取消息 seq: ${seq} 失败:`, err)
      return `获取消息失败: ${err.message}`
    }

    try {
      const searchConfig = getSearchImageConfig()
      const result = await searchImageByUrl(imageUrl, {
        channel: SEARCH_CHANNELS.GOOGLE,
        googleLogin: searchConfig.googleLogin,
      })

      const formattedResult = formatImageSearchToolResult(result)
      if (!formattedResult) {
        return '未找到结果。'
      }

      return formattedResult
    } catch (error) {
      logger.error('[ImageSearchTool] 执行失败:', error)
      return `搜图失败: ${error.message}`
    }
  }
}
