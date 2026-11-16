import AdmZip from "adm-zip"
import sharp from "sharp"
import { getPixivClient } from "./api.js"
import { resolvePixivImageUrl } from "./imageUrls.js"
import { downloadImage } from "../ImageUtils/ImageUtils.js"

// QQ 对大图容易发送失败，超过这个体积就按比例缩小重编码一次。
const MAX_GIF_BYTES = 10 * 1024 * 1024

// App API 返回 type="ugoira"，网页排行榜返回 illust_type="2"。
export function isUgoira(illust) {
  return illust?.type === "ugoira" || String(illust?.illust_type ?? "") === "2"
}

async function encodeGif(frames, delays, scale = 1) {
  if (scale < 1) {
    // 拼成动图后再 resize 会塌成单帧，只能逐帧先缩。
    const { width } = await sharp(frames[0]).metadata()
    const target = Math.max(1, Math.round(width * scale))
    frames = await Promise.all(frames.map(frame => sharp(frame).resize({ width: target }).toBuffer()))
  }
  // effort 4 与默认的 7 肉眼看不出差别，但编码快一倍多。
  return sharp(frames, { join: { animated: true } })
    .gif({ delay: delays, loop: 0, effort: 4 })
    .toBuffer()
}

/**
 * P站动图不是 GIF 文件，而是逐帧图片的 zip 加每帧间隔，这里合成为 GIF。
 * 用 600x600 档的 zip：原尺寸档下载和编码都要慢好几倍，在聊天里也看不出区别。
 * @returns {Promise<Buffer>}
 */
export async function buildUgoiraGif(illustId, { proxy = "", download = downloadImage, maxBytes = MAX_GIF_BYTES } = {}) {
  const pixivCli = await getPixivClient()
  const res = await pixivCli.ugoiraMetadata({ illustId: Number(illustId) })
  const meta = res?.data?.ugoira_metadata
  if (!meta?.zip_urls?.medium || !meta.frames?.length) throw new Error("未取到动图元数据")

  const zipBuffer = await download(resolvePixivImageUrl(meta.zip_urls.medium, proxy))
  if (!Buffer.isBuffer(zipBuffer) || !zipBuffer.length) throw new Error("动图压缩包下载失败")

  const zip = new AdmZip(zipBuffer)
  const frames = meta.frames.map(frame => {
    const entry = zip.getEntry(frame.file)
    if (!entry) throw new Error(`压缩包缺少帧 ${frame.file}`)
    return entry.getData()
  })
  const delays = meta.frames.map(frame => frame.delay)

  let gif = await encodeGif(frames, delays)
  let scale = 1
  // GIF 体积大致与面积成正比，但像素画缩小后抖动噪点变多，一次不一定压得下来，最多再试三次。
  for (let attempt = 0; attempt < 3 && gif.length > maxBytes; attempt++) {
    scale *= Math.sqrt(maxBytes / gif.length) * 0.9
    logger.info(`[P站动图][PID:${illustId}] GIF ${(gif.length / 1048576).toFixed(1)}MB 过大，缩放到 ${Math.round(scale * 100)}% 重编码`)
    gif = await encodeGif(frames, delays, scale)
  }
  return gif
}
