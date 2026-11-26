import Setting from "../setting.js";
import { getAIWithChannel } from "../AIUtils/getAI.js";
import { guardedFetch } from "./endpoint.js";
import {
  getChatProfile,
  getHistoryEpoch,
  loadHistory,
  saveHistory,
} from "./store.js";

// 每个用户一个队列：连发的几条消息等静默一小段时间后合成一次请求；
// 生成期间新来的消息留到下一轮，不丢、不并发。
const queues = new Map();

const MAX_PENDING_MESSAGES = 20;
const MAX_TURN_CHARS = 4000;
const MAX_REPLY_MESSAGES = 5;
const ERROR_TEXT_LIMIT = 300;

export const DEFAULT_PRIVATE_CHAT_CONFIG = {
  basePrompt: "",
  mergeSeconds: 3,
  historyRounds: 20,
  timeoutSeconds: 120,
  splitMessage: true,
};

export function getPrivateChatConfig(selfId) {
  return { ...DEFAULT_PRIVATE_CHAT_CONFIG, ...Setting.getConfig("PrivateChat", { selfId }) };
}

export function isProfileReady(profile) {
  return Boolean(profile?.persona?.trim() && profile.baseURL && profile.model && profile.apiKey);
}

export function buildChannel(profile, config) {
  return {
    name: `私聊AI:${profile.userId}`,
    baseURL: profile.baseURL,
    apiKey: profile.apiKey,
    model: profile.model,
    stream: false,
    timeoutMs: Math.max(10, Number(config.timeoutSeconds) || 120) * 1000,
    fetch: guardedFetch,
  };
}

function buildPrompt(config, persona, e) {
  const nickname = e.sender?.nickname || "";
  return [
    String(config.basePrompt || "").trim(),
    `【人设】\n${persona.trim()}`,
    nickname ? `对方的 QQ 昵称：${nickname}` : "",
  ].filter(Boolean).join("\n\n");
}

/** 去掉部分模型混在正文里的思考过程 */
export function cleanReplyText(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, "")
    .trim();
}

/** 按换行拆成几条发，像真人聊天；行数太多时把剩下的并到最后一条 */
export function splitReply(text, maxMessages = MAX_REPLY_MESSAGES) {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length <= maxMessages) return lines;
  return [...lines.slice(0, maxMessages - 1), lines.slice(maxMessages - 1).join("\n")];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendReply(e, text, split) {
  const messages = split ? splitReply(text) : [text];
  for (let index = 0; index < messages.length; index++) {
    if (index > 0) await sleep(Math.min(2000, 400 + messages[index].length * 40));
    await e.reply(messages[index]);
  }
}

function truncate(text, limit) {
  const value = String(text || "");
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

async function runTurn(e, texts) {
  const userId = String(e.user_id);
  const config = getPrivateChatConfig(e.self_id);
  const profile = getChatProfile(userId);
  if (!isProfileReady(profile)) return;

  const epoch = getHistoryEpoch(userId);
  const history = loadHistory(userId);
  const queryParts = [{ text: truncate(texts.join("\n"), MAX_TURN_CHARS) }];

  const result = await getAIWithChannel(
    buildChannel(profile, config),
    e,
    queryParts,
    buildPrompt(config, profile.persona, e),
    history,
    { includeCurrentTime: true }
  );

  if (typeof result === "string") {
    logger.warn(`[私聊AI] 用户 ${userId} 请求失败：${result}`);
    await e.reply(`AI 请求失败：${truncate(result, ERROR_TEXT_LIMIT)}\n请检查设置页面里的接口地址、模型和 Key。`);
    return;
  }

  const text = cleanReplyText(result.text);
  if (!text) {
    await e.reply("AI 没有返回内容，换个说法再试试吧。");
    return;
  }

  // 生成期间清空过历史或改了人设，就不把这一轮接到旧历史上
  if (getHistoryEpoch(userId) === epoch) {
    history.push({ role: "user", parts: queryParts }, { role: "model", parts: [{ text }] });
    saveHistory(userId, history, config.historyRounds);
  }
  await sendReply(e, text, config.splitMessage !== false);
}

function schedule(key, state) {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  if (state.running) return;
  const config = getPrivateChatConfig(state.event.self_id);
  const delayMs = Math.max(0, Number(config.mergeSeconds) || 0) * 1000;
  state.timer = setTimeout(() => flush(key, state), delayMs);
}

async function flush(key, state) {
  state.timer = null;
  if (state.running || state.pending.length === 0) return;
  state.running = true;
  const texts = state.pending.splice(0);
  const event = state.event;
  try {
    await runTurn(event, texts);
  } catch (error) {
    logger.error(`[私聊AI] 处理用户 ${event.user_id} 的消息出错：${error.stack || error.message}`);
    try {
      await event.reply("出错了，请稍后再试。");
    } catch {}
  } finally {
    state.running = false;
    if (state.pending.length > 0) {
      schedule(key, state);
    } else if (queues.get(key) === state) {
      queues.delete(key);
    }
  }
}

/** 收下一条私聊消息，静默 mergeSeconds 秒后和前后几条一起交给 AI */
export function enqueuePrivateMessage(e, text) {
  const key = `${e.self_id}:${e.user_id}`;
  let state = queues.get(key);
  if (!state) {
    state = { pending: [], timer: null, running: false, event: e };
    queues.set(key, state);
  }
  state.event = e;
  state.pending.push(text);
  if (state.pending.length > MAX_PENDING_MESSAGES) {
    state.pending.splice(0, state.pending.length - MAX_PENDING_MESSAGES);
  }
  schedule(key, state);
}

/** 网页“测试连接”用：发一句话看接口能不能用 */
export async function testChannel(profile, config) {
  const result = await getAIWithChannel(
    buildChannel(profile, config),
    null,
    [{ text: "你好，请用一句话回复。" }],
    "",
    []
  );
  if (typeof result === "string") return { ok: false, error: truncate(result, ERROR_TEXT_LIMIT) };
  return { ok: true, reply: truncate(cleanReplyText(result.text), 200) };
}
