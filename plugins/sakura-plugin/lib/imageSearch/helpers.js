import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const TEMP_DIR = path.resolve('data', 'temp')

export function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true })
  }
  return TEMP_DIR
}

export async function downloadImageToTemp(imgUrl, prefix = 'image_search') {
  const dataDir = ensureTempDir()
  const tmpFile = path.join(dataDir, `${prefix}_${crypto.randomUUID()}.png`)
  const response = await fetch(imgUrl)

  if (!response.ok) {
    throw new Error(`图片下载失败: HTTP ${response.status}`)
  }

  const buffer = await response.arrayBuffer()
  fs.writeFileSync(tmpFile, Buffer.from(buffer))
  return tmpFile
}

export async function fetchImageBlob(imgUrl) {
  const response = await fetch(imgUrl)
  if (!response.ok) {
    throw new Error(`向源地址请求图片失败: HTTP ${response.status}`)
  }

  const contentType = response.headers.get('content-type') || 'image/jpeg'
  const buffer = await response.arrayBuffer()
  return new Blob([buffer], { type: contentType })
}

export function cleanupTempFile(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }
}

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const GOOGLE_CITATION_HEADER_PATTERN = /^(?:引用链接|引用連結|参考链接|參考連結|Reference links?)[:：]\s*$/iu
const GOOGLE_PLUS_COUNT_PATTERN = /^[+＋]\s*\d+\s*$/u

function normalizeGoogleSourceLabel(value = '') {
  return String(value)
    .replace(/（[\s\S]*$/, '')
    .replace(/\([\s\S]*$/, '')
    .split(/\s[-–—]\s/u)[0]
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function extractGoogleCitationSources(lines) {
  const sources = new Set()

  for (const line of lines) {
    const match = line.match(/^\s*-\s*\[([^\]]+)\]\((https?:\/\/.+)\)\s*$/iu)
    if (!match) continue

    const label = normalizeGoogleSourceLabel(match[1])
    if (label) sources.add(label)

    try {
      const hostname = new URL(match[2]).hostname.toLowerCase().replace(/^www\./, '')
      if (hostname) {
        sources.add(hostname)
        const siteName = hostname.split('.')[0]
        if (siteName) sources.add(siteName)
      }
    } catch {
    }
  }

  return sources
}

function isGoogleSourceBadgeLine(line, knownSources) {
  const normalized = normalizeGoogleSourceLabel(line)
  if (!normalized) return false
  if (knownSources.has(normalized)) return true

  return normalized.length <= 40 &&
    normalized.split(/\s+/).length <= 4 &&
    !/^[-*#]/u.test(normalized) &&
    !/https?:\/\//iu.test(normalized) &&
    !/[。！？!?：:；;，,]/u.test(normalized)
}

function stripGoogleSourceBadgeArtifacts(text = '') {
  const lines = String(text)
    .replace(/(?:&#x0*20;|&#0*32;|&#x0*a0;|&#0*160;|&nbsp;)/giu, ' ')
    .split('\n')
    .map(line => line.trim())
  const citationIndex = lines.findIndex(line => GOOGLE_CITATION_HEADER_PATTERN.test(line))
  const bodyEnd = citationIndex === -1 ? lines.length : citationIndex
  const bodyLines = lines.slice(0, bodyEnd)
  const citationLines = citationIndex === -1 ? [] : lines.slice(citationIndex)
  const knownSources = extractGoogleCitationSources(citationLines)
  const removedIndexes = new Set()

  for (let index = 0; index < bodyLines.length; index += 1) {
    const line = bodyLines[index]
    const normalized = normalizeGoogleSourceLabel(line)

    if (knownSources.has(normalized) && isGoogleSourceBadgeLine(line, knownSources)) {
      removedIndexes.add(index)
      continue
    }

    if (GOOGLE_PLUS_COUNT_PATTERN.test(line)) {
      removedIndexes.add(index)

      let previousIndex = index - 1
      while (previousIndex >= 0 && !bodyLines[previousIndex]) previousIndex -= 1
      if (previousIndex >= 0 && isGoogleSourceBadgeLine(bodyLines[previousIndex], knownSources)) {
        removedIndexes.add(previousIndex)
      }

      let nextIndex = index + 1
      while (nextIndex < bodyLines.length && !bodyLines[nextIndex]) nextIndex += 1
      if (nextIndex < bodyLines.length) {
        const nextLabel = normalizeGoogleSourceLabel(bodyLines[nextIndex])
        const previousLabel = previousIndex >= 0
          ? normalizeGoogleSourceLabel(bodyLines[previousIndex])
          : ''
        if (knownSources.has(nextLabel) || (previousLabel && nextLabel === previousLabel)) {
          removedIndexes.add(nextIndex)
        }
      }
      continue
    }

    const sourceWithCount = line.match(/^(.{1,40}?)\s*[+＋]\s*\d+(?:\s+(.{1,40}))?$/u)
    if (sourceWithCount && isGoogleSourceBadgeLine(sourceWithCount[1], knownSources)) {
      const trailingLabel = normalizeGoogleSourceLabel(sourceWithCount[2])
      const leadingLabel = normalizeGoogleSourceLabel(sourceWithCount[1])
      if (!trailingLabel || trailingLabel === leadingLabel || knownSources.has(trailingLabel)) {
        removedIndexes.add(index)
      }
    }
  }

  const cleanedBody = bodyLines.filter((line, index) => !removedIndexes.has(index))
  const combined = citationLines.length > 0
    ? [...cleanedBody, ...citationLines]
    : cleanedBody

  return combined.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function sanitizeGoogleAiText(text = '') {
  if (!text) return ''

  let normalized = String(text)
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  // 移除开头的 "AI 概览" 或 "AI Overview"（可能带空格或换行）
  normalized = normalized.replace(/^(AI\s*概览|AI\s*Overview)\n?/i, '').trim()

  normalized = normalized
    .replace(/\s*在 AI 模式下深入探索[\s\S]*$/u, '')
    .replace(/\s*AI 的回答未必正确无误，请注意核查[\s\S]*$/u, '')
    .trim()

  return stripGoogleSourceBadgeArtifacts(normalized)
}

export function truncateText(text = '', maxLength = 80) {
  const normalized = String(text).replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized
}

export function dedupeBy(items = [], getKey) {
  const seen = new Set()
  return items.filter(item => {
    const key = getKey(item)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}
