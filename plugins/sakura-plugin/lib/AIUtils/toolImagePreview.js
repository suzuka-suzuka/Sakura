// 画图类工具发图后的工具结果：
// 1. 附一张缩小的预览图，让模型本轮能核对画面（本轮结束即被清掉）；
// 2. 传入发送结果时（目前只有 ImageGenerator），把图片消息 ID 写进文字结果。
//    文字会留在对话历史里，后续轮次可以用它引用这张图继续修改。
import sharp from "sharp";
import { createToolMediaResult } from "./toolResultProtocol.js";

const PREVIEW_MAX_SIDE = 768;
const PREVIEW_JPEG_QUALITY = 80;

/** 缩到长边 768 的 JPEG（动图取第一帧）；失败时返回 null，不影响工具结果。 */
export async function buildToolImagePreview(input) {
  try {
    const buffer = await sharp(input)
      .rotate()
      .resize({
        width: PREVIEW_MAX_SIDE,
        height: PREVIEW_MAX_SIDE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: PREVIEW_JPEG_QUALITY })
      .toBuffer();
    return { inlineData: { mimeType: "image/jpeg", data: buffer.toString("base64") } };
  } catch (error) {
    logger.warn(`[工具预览图] 生成失败：${error.message || error}`);
    return null;
  }
}

/** e.reply 的返回值里取消息 ID；发送失败或协议端返回 0 时为空串。 */
export function getSentMessageId(result) {
  const id = result?.message_id;
  return id == null || String(id) === "0" ? "" : String(id);
}

function describeSentImage(messageId) {
  return messageId
    ? `图片消息 seq:${messageId}。之后要修改这张图，把这个 seq 传给 ImageGenerator 的 seq 参数。`
    : "";
}

/**
 * 发图成功后的工具结果：文字说明 + 缩小预览图。
 * @param {string} message 工具原本的文字结果
 * @param {Buffer} imageBuffer 发出去的原图
 * @param {object} [sendResult] e.reply 的返回值；传入时在文字里写上消息 ID，供后续改图引用
 */
export async function buildSentImageToolResult(message, imageBuffer, sendResult = null) {
  const text = [message, describeSentImage(getSentMessageId(sendResult))]
    .filter(Boolean)
    .join("\n");
  const preview = await buildToolImagePreview(imageBuffer);
  if (!preview) return text;
  return createToolMediaResult(
    { message: `${text}\n预览图已附在本工具结果中，可据此核对画面。` },
    [preview],
  );
}
