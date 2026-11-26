import db from "../Database.js";
import { decryptSecret, encryptSecret, maskSecret } from "./secret.js";
import {
  sanitizeConversationHistory,
  trimConversationHistoryByRounds,
} from "../AIUtils/ConversationHistory.js";

// 清空历史（网页按钮、改人设）时加一，正在生成的回复据此放弃写回旧历史
const historyEpochs = new Map();

export function getHistoryEpoch(userId) {
  return historyEpochs.get(String(userId)) || 0;
}

function bumpHistoryEpoch(userId) {
  historyEpochs.set(String(userId), getHistoryEpoch(userId) + 1);
}

function getRow(userId) {
  return db.prepare("SELECT * FROM private_chat_users WHERE user_id = ?").get(String(userId)) || null;
}

function ensureRow(userId, now = Date.now()) {
  db.prepare(`
    INSERT INTO private_chat_users (user_id, created_at, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO NOTHING
  `).run(String(userId), now, now);
}

function readApiKey(row) {
  if (!row?.api_key) return "";
  try {
    return decryptSecret(row.api_key);
  } catch (error) {
    logger.warn(`[私聊AI] 用户 ${row.user_id} 的 API Key 解密失败：${error.message}`);
    return "";
  }
}

/** 给对话用：人设 + 完整的接口配置（含明文 Key） */
export function getChatProfile(userId) {
  const row = getRow(userId);
  if (!row) return null;
  return {
    userId: row.user_id,
    persona: row.persona,
    baseURL: row.api_base_url,
    model: row.api_model,
    apiKey: readApiKey(row),
  };
}

/** 给网页用：Key 只给打码后的样子 */
export function getPublicProfile(userId) {
  const row = getRow(userId);
  const apiKey = readApiKey(row);
  return {
    userId: String(userId),
    persona: row?.persona || "",
    baseURL: row?.api_base_url || "",
    model: row?.api_model || "",
    hasApiKey: Boolean(apiKey),
    apiKeyHint: maskSecret(apiKey),
    historyRounds: row ? countRounds(row.history) : 0,
    updatedAt: row?.updated_at || null,
  };
}

/**
 * 保存网页提交的设置。apiKey 为 undefined 时保留原来的 Key。
 * 人设有变化时清空对话历史，免得新人设接着旧人设的话说。
 */
export function saveProfile(userId, { persona, baseURL, model, apiKey }) {
  const now = Date.now();
  return db.transaction(() => {
    ensureRow(userId, now);
    const before = getRow(userId);
    const personaChanged = before.persona !== persona;
    const nextKey = apiKey === undefined ? before.api_key : encryptSecret(apiKey);
    db.prepare(`
      UPDATE private_chat_users
      SET persona = ?, api_base_url = ?, api_model = ?, api_key = ?,
          history = CASE WHEN ? THEN '[]' ELSE history END,
          updated_at = ?
      WHERE user_id = ?
    `).run(persona, baseURL, model, nextKey, personaChanged ? 1 : 0, now, String(userId));
    if (personaChanged) bumpHistoryEpoch(userId);
    return { personaChanged };
  }).immediate();
}

export function loadHistory(userId) {
  const row = getRow(userId);
  if (!row?.history) return [];
  try {
    const parsed = JSON.parse(row.history);
    return Array.isArray(parsed) ? sanitizeConversationHistory(parsed) : [];
  } catch {
    return [];
  }
}

export function saveHistory(userId, history, maxRounds) {
  const trimmed = trimConversationHistoryByRounds(sanitizeConversationHistory(history), maxRounds);
  db.prepare("UPDATE private_chat_users SET history = ? WHERE user_id = ?")
    .run(JSON.stringify(trimmed), String(userId));
}

export function clearHistory(userId) {
  bumpHistoryEpoch(userId);
  return db.prepare("UPDATE private_chat_users SET history = '[]' WHERE user_id = ?")
    .run(String(userId)).changes > 0;
}

function countRounds(historyText) {
  try {
    const history = JSON.parse(historyText || "[]");
    return Array.isArray(history) ? history.filter((item) => item?.role === "user").length : 0;
  } catch {
    return 0;
  }
}
