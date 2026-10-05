import { sanitizeConversationHistory } from "./ConversationHistory.js";

export const MIMIC_HISTORY_TTL_SECONDS = 20 * 60;
const PREFIX = "sakura:mimic-history:v1";

async function resolveRedis(redis) {
  if (redis) return redis;
  const { getRedis } = await import("../../../../src/utils/redis.js");
  return getRedis();
}

export function getMimicHistoryKey(e) {
  return `${PREFIX}:${e.self_id}:${e.group_id || "private"}:${e.user_id}`;
}

export async function loadMimicHistory(e, { redis = null } = {}) {
  const client = await resolveRedis(redis);
  const value = await client.get(getMimicHistoryKey(e));
  if (!value) return [];
  try {
    return sanitizeConversationHistory(JSON.parse(value));
  } catch (error) {
    throw new Error(`拟态历史格式无效：${error.message}`);
  }
}

export async function saveMimicHistory(e, history, { redis = null } = {}) {
  const client = await resolveRedis(redis);
  await client.set(getMimicHistoryKey(e), JSON.stringify(sanitizeConversationHistory(history)), "EX", MIMIC_HISTORY_TTL_SECONDS);
}

export async function touchMimicHistory(e, { redis = null } = {}) {
  const client = await resolveRedis(redis);
  await client.expire(getMimicHistoryKey(e), MIMIC_HISTORY_TTL_SECONDS);
}

export async function clearMimicHistory(e, { redis = null } = {}) {
  const client = await resolveRedis(redis);
  if (e?.self_id != null) return client.del(getMimicHistoryKey(e));
  let cursor = "0";
  do {
    const [next, keys] = await client.scan(cursor, "MATCH", `${PREFIX}:*:${e.group_id || "private"}:${e.user_id}`, "COUNT", 100);
    if (keys.length > 0) await client.del(...keys);
    cursor = next;
  } while (cursor !== "0");
}

export async function clearAllMimicHistories({ redis = null } = {}) {
  const client = await resolveRedis(redis);
  let cursor = "0";
  do {
    const [next, keys] = await client.scan(cursor, "MATCH", `${PREFIX}:*`, "COUNT", 100);
    if (keys.length > 0) await client.del(...keys);
    cursor = next;
  } while (cursor !== "0");
}
