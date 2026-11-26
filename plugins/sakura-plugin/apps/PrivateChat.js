import { createLoginCode, LOGIN_CODE_TTL_SECONDS, shouldSendSetupHint } from "../lib/privateChat/auth.js";
import {
  enqueuePrivateMessage,
  getPrivateChatConfig,
  isProfileReady,
} from "../lib/privateChat/conversation.js";
import { clearHistory, getChatProfile } from "../lib/privateChat/store.js";
import { ensurePrivateChatWebServer, normalizePublicUrl } from "../lib/privateChat/webServer.js";

const MAX_MESSAGE_CHARS = 2000;
const SETUP_HINT = "还没设置好私聊 AI：需要先填人设和你自己的 API。\n发送 #设置 获取设置页面的登录链接。";

// 消息段 → 发给 AI 的文字。模型看不到图片等内容，只给个占位让它知道对方发了什么。
const PLACEHOLDERS = {
  image: "[图片]",
  face: "[表情]",
  mface: "[表情]",
  record: "[语音]",
  video: "[视频]",
  file: "[文件]",
  json: "[卡片消息]",
  forward: "[聊天记录]",
};

function buildMessageText(e) {
  const parts = [];
  for (const segment of e.message || []) {
    if (segment.type === "text") {
      parts.push(segment.data?.text || "");
    } else if (PLACEHOLDERS[segment.type]) {
      parts.push(PLACEHOLDERS[segment.type]);
    }
  }
  const text = parts.join("").trim();
  return text.length > MAX_MESSAGE_CHARS ? text.slice(0, MAX_MESSAGE_CHARS) : text;
}

/**
 * 私聊 AI：私聊里唯一的聊天入口（loader 只把私聊消息交给 system 插件和这里）。
 * 只回好友，临时会话不回；每个用户用自己在设置页面里填的人设和 API。
 */
export class PrivateChat extends plugin {
  constructor() {
    super({
      name: "私聊AI",
      event: "message.private",
      priority: 4000,
      allowPrivate: true,
      ack: false,
      configWatch: "PrivateChat",
    });
  }

  async init() {
    try {
      await ensurePrivateChatWebServer();
    } catch (error) {
      logger.error(`[私聊AI] 启动设置页面失败：${error.message}`);
    }
  }

  isActive(e) {
    return getPrivateChatConfig(e.self_id).enable === true && e.sub_type === "friend";
  }

  openSettings = Command(/^#(?:人设)?设置(?:人设)?$/, async (e) => {
    if (!this.isActive(e)) return false;
    const publicUrl = normalizePublicUrl(getPrivateChatConfig(e.self_id).publicUrl);
    if (!publicUrl) {
      await e.reply("管理员还没配置设置页面的地址，暂时不能设置。");
      return true;
    }
    const code = await createLoginCode(e.user_id);
    const minutes = Math.round(LOGIN_CODE_TTL_SECONDS / 60);
    await e.reply([
      `私聊 AI 设置页面（${minutes} 分钟内有效，只能用一次）：`,
      `${publicUrl}/#code=${code}`,
      "",
      `链接打不开的话，用浏览器打开 ${publicUrl} 输入登录码：${code}`,
    ].join("\n"));
    return true;
  });

  resetConversation = Command(/^#(?:清空|重置)对话$/, async (e) => {
    if (!this.isActive(e)) return false;
    clearHistory(e.user_id);
    await e.reply("对话记录已清空。");
    return true;
  });

  // 放在最后：system 插件的指令和上面两条都没接住的消息才交给 AI
  chat = OnEvent("message.private", { priority: Number.MAX_SAFE_INTEGER }, async (e) => {
    if (!this.isActive(e)) return false;
    if (String(e.user_id) === String(e.self_id)) return false;

    const text = buildMessageText(e);
    // 以 # 开头的多半是打错或私聊里不支持的指令，不当成聊天
    if (!text || text.startsWith("#")) return false;

    if (!isProfileReady(getChatProfile(e.user_id))) {
      if (await shouldSendSetupHint(e.user_id)) await e.reply(SETUP_HINT);
      return true;
    }

    enqueuePrivateMessage(e, text);
    return true;
  });
}
