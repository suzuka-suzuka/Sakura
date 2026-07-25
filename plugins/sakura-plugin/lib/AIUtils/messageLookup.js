import { getMessageIdentifier } from "./messageIdentifiers.js";

const FALLBACK_HISTORY_COUNT = 120;

function matchesIdentifier(msg, identifier) {
  if (!msg) return false;
  const target = String(identifier);
  return [msg.message_id, msg.message_seq, msg.real_seq, msg.seq].some(
    (value) => value != null && String(value) === target
  );
}

/**
 * 按标识符获取消息详情。
 * 协议端（如 SnowLuma）的 get_msg 只认 message_id（哈希值），
 * 当 AI 传来的是真实 message_seq 时 get_msg 会查不到，
 * 此时回退到最近历史消息里按 seq/message_id 匹配。
 * @param {object} e 事件对象
 * @param {number|string} identifier message_id 或 message_seq
 * @returns {Promise<object|null>} 消息详情（含 message / message_id 字段）
 */
export async function fetchMessageByIdentifier(e, identifier) {
  const id = getMessageIdentifier(identifier);
  if (!id) return null;

  let msg = null;
  try {
    msg = await e.getMsg(id);
  } catch {}
  if (msg?.message) return msg;

  try {
    const history = await e.getMsgHistory(FALLBACK_HISTORY_COUNT);
    return history.find((item) => matchesIdentifier(item, id)) || null;
  } catch {
    return null;
  }
}
