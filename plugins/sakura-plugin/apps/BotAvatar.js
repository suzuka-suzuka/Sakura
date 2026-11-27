import sharp from "sharp";

// QQ 头像展示最大 640，再大也会被压缩
const AVATAR_SIZE = 640;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

function collectImageUrls(segments) {
  if (!Array.isArray(segments)) return [];
  return segments
    .filter((segment) => segment?.type === "image")
    .map((segment) => segment.data?.url || segment.data?.file)
    .filter((url) => typeof url === "string" && /^https?:\/\//i.test(url));
}

async function findImageUrl(e) {
  const direct = collectImageUrls(e.message);
  if (direct.length > 0) return direct[0];
  if (!e.reply_id) return null;

  const replied = await e.getReplyMsg().catch(() => null);
  return collectImageUrls(replied?.message)[0] || null;
}

async function downloadImage(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    throw new Error(`下载图片失败 HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD_BYTES) {
    throw new Error("图片超过 20MB");
  }
  return buffer;
}

// 居中裁成正方形（动图只取第一帧），边长不超过 640、不放大，统一转成 PNG
async function toSquareAvatar(buffer) {
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) {
    throw new Error("无法识别的图片");
  }
  // EXIF 方向 5~8 会在 rotate() 后宽高互换，但取短边不受影响
  const side = Math.min(meta.width, meta.height, AVATAR_SIZE);
  return sharp(buffer, { animated: false })
    .rotate()
    .resize(side, side, { fit: "cover", position: "centre" })
    .png()
    .toBuffer();
}

export class BotAvatar extends plugin {
  constructor() {
    super({
      name: "换头像",
      event: "message",
      priority: 1135,
    });
  }

  /**
   * 主人发 #换头像 并附带一张图片（或引用一张图片），把当前账号的 QQ 头像换成它。
   * 群聊和私聊都可以用。
   */
  changeAvatar = Command(
    /^#换头像$/,
    { permission: "master", allowPrivate: true },
    async (e) => {
      const url = await findImageUrl(e);
      if (!url) {
        await e.reply("发 #换头像 时带上一张图片，或者引用一张图片再发");
        return true;
      }

      let file;
      try {
        file = `base64://${(await toSquareAvatar(await downloadImage(url))).toString("base64")}`;
      } catch (err) {
        logger.error(`[换头像] 处理图片失败: ${err.message}`);
        await e.reply(`处理图片失败：${err.message}`);
        return true;
      }

      try {
        // 直接走 ws.send：代理的 sendRequest 失败时只返回 null，主人需要看到协议端给的错误
        await e.bot.ws.send("set_qq_avatar", { file }, { selfId: e.self_id });
      } catch (err) {
        logger.error(`[换头像] 设置头像失败: ${err.message}`);
        await e.reply(`换头像失败：${err.message}`);
        return true;
      }

      // 成功不回复，群里靠框架的自动回应表情提示已处理
      logger.info(`[换头像] 账号 ${e.self_id} 已更换头像`);
      return true;
    }
  );
}
