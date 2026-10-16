import sharp from "sharp";
import { FORTUNE_BAG_IMAGE_LIMIT } from "./fortuneBagRules.js";

export async function downloadFortuneBagImage(url, fetchImage = globalThis.fetch) {
  if (!/^https?:\/\//iu.test(String(url || ""))) throw new Error("图片读取失败，请重新发送图片后再试。");
  const response = await fetchImage(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok || !response.body) throw new Error("图片读取失败，请重新发送图片后再试。");
  const reader = response.body.getReader();
  try {
    if (Number(response.headers.get("content-length")) > FORTUNE_BAG_IMAGE_LIMIT) {
      throw new Error("福袋图片不能超过2MB。");
    }
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > FORTUNE_BAG_IMAGE_LIMIT) throw new Error("福袋图片不能超过2MB。");
      chunks.push(Buffer.from(value));
    }
    const image = Buffer.concat(chunks, size);
    try {
      const metadata = await sharp(image).metadata();
      if (!metadata.width || !metadata.height || !["jpeg", "png", "gif", "webp"].includes(metadata.format)) {
        throw new Error("图片格式不支持");
      }
    } catch {
      throw new Error("请使用有效的 PNG、JPEG、GIF 或 WebP 图片。");
    }
    return image;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function readFortuneBagImage(e) {
  let images = (e.message || []).filter(item => item.type === "image");
  if (!images.length && e.reply_id) {
    const replied = await e.getReplyMsg();
    images = (replied?.message || []).filter(item => item.type === "image");
  }
  if (images.length > 1) throw new Error("每个福袋最多放一张图片。");
  if (!images.length) return null;
  return downloadFortuneBagImage(images[0].data?.url);
}
