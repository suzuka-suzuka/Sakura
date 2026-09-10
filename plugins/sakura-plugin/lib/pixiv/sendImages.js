import { FlipImage } from "../ImageUtils/ImageUtils.js"

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function countValidImages(message) {
  if (Array.isArray(message)) {
    return message.filter(item => item?.type === "image" &&
      [item.data?.file, item.data?.url].some(value => typeof value === "string" && value.trim())).length
  }
  if (typeof message === "string") {
    return (message.match(/\[CQ:image,[^\]]*\]/g) || [])
      .filter(item => /(?:,)(?:file|url)=[^,\]\s]+/.test(item)).length
  }
  return 0
}

async function withTimeout(callback, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(callback),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("消息回查超时")), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// OneBot 的发送回执可能只是本地占位记录；给协议端短暂同步时间后再检查实际图片内容。
export async function verifyImageMessage(e, result, expectedCount, {
  wait = sleep, delays = [400, 1200, 2000], timeoutMs = 3000,
} = {}) {
  if (!result?.message_id || String(result.message_id) === "0") return { ok: false, reason: "未返回有效消息编号" }
  if (typeof e.bot?.getMsg !== "function") return { ok: false, reason: "协议端不支持消息回查" }
  let reason = "未查到消息"
  for (const delay of delays) {
    await wait(delay)
    try {
      const message = await withTimeout(() => e.bot.getMsg(result.message_id), timeoutMs)
      if (!message) { reason = "未查到消息"; continue }
      if (String(message.message_id) !== String(result.message_id) ||
        (message.group_id != null && String(message.group_id) !== String(e.group_id)) ||
        (message.user_id != null && e.self_id != null && String(message.user_id) !== String(e.self_id))) {
        reason = "回查消息与发送目标不符"
        continue
      }
      // SnowLuma 吞图时会返回非零 message_id，但序号为 0 且图片 file/url 为空。
      if (message.message_seq != null && Number(message.message_seq) <= 0) {
        reason = `消息尚未落地，message_seq=${message.message_seq}`
        continue
      }
      const count = countValidImages(message.message ?? message.raw_message)
      if (count < expectedCount) { reason = `有效图片不足，期望 ${expectedCount} 张，实际 ${count} 张`; continue }
      return { ok: true, reason: `已回查到 ${count} 张图片` }
    } catch (error) {
      reason = error.message || "消息回查失败"
    }
  }
  return { ok: false, reason }
}

export async function sendPixivImages(e, {
  imageUrls, originalUrls = imageUrls, pid, initialRecallTime = 0, fallbackRecallTime = 10,
}, { flipImage = FlipImage, verify = verifyImageMessage } = {}) {
  const prefix = `[P站发图][PID:${pid}][目标:${e.group_id || e.user_id}]`
  const send = async (images, recallTime, stage) => {
    if (!images.length) return false
    try {
      const result = await e.reply(images.map(image => segment.image(image)), recallTime, false)
      const checked = await verify(e, result, imageUrls.length)
      logger[checked.ok ? "info" : "warn"](`${prefix} ${stage} message_id=${result?.message_id ?? "无"}：${checked.reason}`)
      return checked.ok
    } catch (error) {
      logger.warn(`${prefix} ${stage}失败：${error.message || error}`)
      return false
    }
  }

  if (await send(imageUrls, initialRecallTime, "原图")) return true

  if (imageUrls.length) {
    await e.reply("图片发送失败，正在尝试翻转后重发...", 10, true)
    const flipped = []
    for (const [index, url] of imageUrls.entries()) {
      let buffer
      for (const source of [...new Set([url, originalUrls[index]].filter(Boolean))]) {
        try { buffer = await flipImage(source) }
        catch (error) { logger.warn(`${prefix} 第 ${index + 1} 张图片翻转失败：${error.message || error}`) }
        if (buffer) break
      }
      if (buffer) flipped.push(buffer)
    }
    if (await send(flipped, fallbackRecallTime, "翻转图片")) return true
  }

  const links = [...new Set([`https://www.pixiv.net/artworks/${pid}`, ...imageUrls])]
  const result = await e.reply("图片最终发送失败，请点击链接查看：\n" + links.join("\n"), 60, false)
  logger[result?.message_id ? "info" : "warn"](`${prefix} 链接兜底 message_id=${result?.message_id ?? "无"}`)
  return !!result?.message_id
}
