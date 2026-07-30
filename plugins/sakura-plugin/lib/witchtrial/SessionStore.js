/**
 * 审判会话的 Redis 持久化
 *
 * 不用模块级 Map 存局：框架支持插件热重载，父进程还会在子进程崩溃后重启它，
 * 内存态一重载整局就没了。存 Redis 才能跨重启接着跑。
 *
 * 另外维护一份「玩家 → 所在群」的反查索引。这个游戏的绝大多数动作都走私聊
 * （搜到什么、手里有什么牌、要出示什么，都不能公开），索引是必需的。
 */

import { randomUUID } from "node:crypto";

const SESSION_TTL = 7 * 24 * 60 * 60;
const LOCK_TTL_MS = 10 * 60 * 1000;
const LOCK_RENEW_INTERVAL_MS = 60 * 1000;
export const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000;
export const SESSION_VERSION = 8;
const KEY_PREFIX = "sakura:witchtrial";

export const PHASES = {
  RECRUITING: "recruiting",   // 招募
  GENERATING: "generating",   // 生成牢狱与案件
  INVESTIGATE: "investigate", // 调查
  TRIAL: "trial",             // 庭审
  VOTING: "voting",           // 投票
  ENDED: "ended",
};

export const PHASE_LABEL = {
  [PHASES.RECRUITING]: "招募中",
  [PHASES.GENERATING]: "生成中",
  [PHASES.INVESTIGATE]: "调查",
  [PHASES.TRIAL]: "庭审",
  [PHASES.VOTING]: "投票",
  [PHASES.ENDED]: "已结束",
};

/** 本进程正在处理的会话。Redis 锁负责跨进程，这份 Map 用于快速拒绝重入 */
const busySessions = new Map();

function sessionKey(selfId, groupId) {
  return `${KEY_PREFIX}:session:${selfId}:${groupId}`;
}

function userKey(selfId, userId) {
  return `${KEY_PREFIX}:user:${selfId}:${userId}`;
}

function lockKey(selfId, groupId) {
  return `${KEY_PREFIX}:lock:${selfId}:${groupId}`;
}

function cancellationKey(selfId, groupId, sessionId) {
  return `${KEY_PREFIX}:cancelled:${selfId}:${groupId}:${sessionId}`;
}

function sessionIdentity(session) {
  if (typeof session?.sessionId !== "string" || !session.sessionId) {
    throw new TypeError("审判会话缺少 sessionId");
  }
  return session.sessionId;
}

function isCurrentSession(session) {
  return (
    session !== null &&
    typeof session === "object" &&
    session.version === SESSION_VERSION &&
    typeof session.sessionId === "string" &&
    session.sessionId.length > 0
  );
}

function assertCurrentSession(session) {
  if (!isCurrentSession(session)) {
    throw new TypeError(`只接受版本 ${SESSION_VERSION} 的审判会话`);
  }
  return session;
}

function parseCurrentSession(raw) {
  const session = JSON.parse(raw);
  return isCurrentSession(session) ? session : null;
}

export class SessionCancelledError extends Error {
  constructor(session) {
    super(`审判会话 ${session?.groupId || ""} 已被结束`);
    this.name = "SessionCancelledError";
    this.code = "WITCHTRIAL_SESSION_CANCELLED";
  }
}

export function isSessionCancelledError(error) {
  return error?.code === "WITCHTRIAL_SESSION_CANCELLED";
}

async function compareDelete(key, expected) {
  return redis.eval(
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
    1,
    key,
    String(expected)
  );
}

async function compareExpire(key, expected, ttlMs) {
  return redis.eval(
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end",
    1,
    key,
    String(expected),
    String(ttlMs)
  );
}

export function createSession({
  selfId,
  groupId,
  hostId,
  hostNickname,
  theme,
  maxPlayers,
  maxChapters,
  investigateRounds,
  trialRounds,
  turnTimeoutMs,
  routeId,
}) {
  const now = Date.now();
  return {
    version: SESSION_VERSION,
    sessionId: randomUUID(),
    selfId: String(selfId),
    groupId: String(groupId),
    hostId: String(hostId),
    phase: PHASES.RECRUITING,
    theme: theme || "",
    maxPlayers,
    // 开局时固定下来，中途改配置不影响正在跑的这一局
    maxChapters: Number.isFinite(maxChapters) ? maxChapters : 3,
    investigateRounds: Number.isFinite(investigateRounds) ? investigateRounds : 3,
    trialRounds: Number.isFinite(trialRounds) ? trialRounds : 5,
    turnTimeoutMs:
      Number.isFinite(turnTimeoutMs) && turnTimeoutMs > 0
        ? turnTimeoutMs
        : DEFAULT_TURN_TIMEOUT_MS,
    turnDeadlineAt: 0,
    routeId,
    players: [{ userId: String(hostId), nickname: hostNickname || String(hostId) }],

    prison: null,
    girls: {},          // girlId -> 少女，玩家和 NPC 统一存

    chapter: 0,
    caseFile: null,
    round: 0,

    pendingActions: {}, // girlId -> 本回合动作
    publicEvidence: [], // 集合 P：已公开、所有人都能使用的证据 id
    evidenceLinks: [],  // 已当庭建立的论证 { evidenceId, propId, stance, byId, chapter, round }
    destroyedEvidence: [], // 被凶手销毁的，永远不会进 P
    refutedProps: [],   // 已被推翻的命题
    claims: [],         // 台面上的主张 { byId, propId, chapter, round }
    questions: [],      // 追问 { fromId, toId, topic, round, answered }
    pouch: {},          // girlId -> 证物袋（证据 id 数组）
    votes: {},          // girlId -> propId
    advancePending: false, // 判决已落库、等待生成下一章
    investigationLeads: {}, // girlId -> 为真人保留的证据 id
    fakeUsed: false,    // 每章最多伪造一次

    // 跨章保留的东西：上一章说过的话，这一章还能翻出来对质
    testimony: [],      // { chapter, byId, name, text }
    history: [],        // { chapter, victimName, executedName, correct, truthText }

    summaryLines: [],
    recentLog: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function armTurnDeadline(session, now = Date.now()) {
  session.turnDeadlineAt = now + session.turnTimeoutMs;
  return session.turnDeadlineAt;
}

export function clearTurnDeadline(session) {
  session.turnDeadlineAt = 0;
}

export function isTurnDeadlineExpired(session, now = Date.now()) {
  return (
    Number.isFinite(session?.turnDeadlineAt) &&
    session.turnDeadlineAt > 0 &&
    session.turnDeadlineAt <= now
  );
}

export function turnDeadlineRemainingMs(session, now = Date.now()) {
  if (!Number.isFinite(session?.turnDeadlineAt) || session.turnDeadlineAt <= 0) return 0;
  return Math.max(0, session.turnDeadlineAt - now);
}

export async function loadSession(selfId, groupId) {
  const raw = await redis.get(sessionKey(selfId, groupId));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (isCurrentSession(parsed)) return parsed;

    // 版本升级后旧局无法兼容，直接清掉，避免残留 key 干扰开新局
    logger.warn(
      `[魔女审判] 群 ${groupId} 的会话版本不兼容（version=${parsed?.version ?? "?"}，需要 ${SESSION_VERSION}），已丢弃`
    );
    await purgeStaleSessionArtifacts(selfId, groupId, parsed);
    return null;
  } catch (error) {
    logger.warn(`[魔女审判] 群 ${groupId} 的会话数据损坏，已丢弃：${error.message}`);
    await redis.del(sessionKey(selfId, groupId));
    return null;
  }
}

/** 清掉不兼容会话的 session key、取消墓碑，以及仍指向该群的玩家索引 */
async function purgeStaleSessionArtifacts(selfId, groupId, parsed) {
  const players = Array.isArray(parsed?.players) ? parsed.players : [];
  const pipeline = redis.multi();
  pipeline.del(sessionKey(selfId, groupId));
  if (parsed?.sessionId) {
    pipeline.del(cancellationKey(selfId, groupId, parsed.sessionId));
  }
  // 用户索引可能已被他人覆盖，只删仍指向本群的
  for (const player of players) {
    if (player?.userId == null) continue;
    pipeline.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      1,
      userKey(selfId, player.userId),
      String(groupId)
    );
  }
  await pipeline.exec();
}

export async function saveSession(session) {
  assertCurrentSession(session);
  const sessionId = sessionIdentity(session);
  session.updatedAt = Date.now();
  const keys = [
    sessionKey(session.selfId, session.groupId),
    cancellationKey(session.selfId, session.groupId, sessionId),
    ...session.players.map((player) => userKey(session.selfId, player.userId)),
  ];
  const saved = await redis.eval(
    `-- witchtrial_save
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
for i = 3, #KEYS do
  local current = redis.call('GET', KEYS[i])
  if (not current) or current == ARGV[3] then
    redis.call('SET', KEYS[i], ARGV[3], 'EX', ARGV[2])
  end
end
return 1`,
    keys.length,
    ...keys,
    JSON.stringify(session),
    String(SESSION_TTL),
    String(session.groupId)
  );

  if (Number(saved) !== 1) throw new SessionCancelledError(session);
  return true;
}

export async function deleteSession(session) {
  assertCurrentSession(session);
  const sessionId = sessionIdentity(session);
  const keys = [
    sessionKey(session.selfId, session.groupId),
    cancellationKey(session.selfId, session.groupId, sessionId),
    ...session.players.map((player) => userKey(session.selfId, player.userId)),
  ];
  const deleted = await redis.eval(
    `-- witchtrial_delete
redis.call('SET', KEYS[2], '1', 'EX', ARGV[2])
local raw = redis.call('GET', KEYS[1])
if raw then
  local ok, current = pcall(cjson.decode, raw)
  if ok and tostring(current.sessionId or '') ~= ARGV[1] then
    return 0
  end
  redis.call('DEL', KEYS[1])
end
for i = 3, #KEYS do
  if redis.call('GET', KEYS[i]) == ARGV[3] then
    redis.call('DEL', KEYS[i])
  end
end
return 1`,
    keys.length,
    ...keys,
    sessionId,
    String(SESSION_TTL),
    String(session.groupId)
  );
  return Number(deleted) === 1;
}

/** 当前长任务是否已被房主/管理员终止。 */
export async function isSessionCancelled(session) {
  const sessionId = sessionIdentity(session);
  const cancelled = await redis.get(
    cancellationKey(session.selfId, session.groupId, sessionId)
  );
  return cancelled === "1";
}

export async function assertSessionActive(session) {
  if (await isSessionCancelled(session)) {
    throw new SessionCancelledError(session);
  }
}

/**
 * 不等待正在进行的 AI 请求：留下终止墓碑、清理会话，并撤掉当前写锁。
 * 旧任务稍后返回时，saveSession 会凭 sessionId 拒绝它，不能把局复活。
 */
export async function cancelSession(session) {
  const current = await loadSession(session.selfId, session.groupId);
  if (current && current.sessionId === sessionIdentity(session)) {
    session = current;
  }
  const deleted = await deleteSession(session);
  if (!deleted) return false;

  const key = `${session.selfId}:${session.groupId}`;
  const held = busySessions.get(key);
  if (held?.timer) clearInterval(held.timer);
  if (held) busySessions.delete(key);

  const redisLockKey = lockKey(session.selfId, session.groupId);
  const token = held?.token || await redis.get(redisLockKey);
  if (token) await compareDelete(redisLockKey, token);
  return true;
}

/**
 * 原子占用玩家私聊索引。
 * 同一玩家在同一个机器人实例下只能属于一个仍然有效的审判会话。
 */
export async function claimUserIndex(selfId, userId, groupId) {
  const key = userKey(selfId, userId);
  const wanted = String(groupId);

  for (let attempt = 0; attempt < 2; attempt++) {
    const claimed = await redis.set(key, wanted, "EX", SESSION_TTL, "NX");
    if (claimed === "OK") return { ok: true, groupId: wanted };

    const existing = await redis.get(key);
    if (existing === wanted) {
      await redis.expire(key, SESSION_TTL);
      return { ok: true, groupId: wanted };
    }

    if (existing) {
      const session = await loadSession(selfId, existing);
      const active =
        session &&
        session.phase !== PHASES.ENDED &&
        session.players.some((player) => player.userId === String(userId));
      if (active) return { ok: false, groupId: String(existing) };
      await compareDelete(key, existing);
    }
  }

  const existing = await redis.get(key);
  return { ok: existing === wanted, groupId: existing ? String(existing) : "" };
}

/** 玩家退出时只清掉仍指向指定群的索引，避免误删另一局 */
export async function dropUserIndex(selfId, userId, groupId) {
  if (groupId === undefined || groupId === null) return false;
  return compareDelete(userKey(selfId, userId), String(groupId));
}

/** 按玩家 QQ 反查他正在参与的那一局 */
export async function findSessionByUser(selfId, userId) {
  const groupId = await redis.get(userKey(selfId, userId));
  if (!groupId) return null;

  const session = await loadSession(selfId, groupId);
  if (!session || session.phase === PHASES.ENDED) {
    await compareDelete(userKey(selfId, userId), String(groupId));
    return null;
  }
  if (!session.players.some((player) => player.userId === String(userId))) {
    await compareDelete(userKey(selfId, userId), String(groupId));
    return null;
  }
  return session;
}

/** 定时任务按机器人账号扫描仍在 Redis 中的审判会话 */
export async function listSessionsBySelfId(selfId) {
  const pattern = `${KEY_PREFIX}:session:${selfId}:*`;
  const sessions = [];
  let cursor = "0";

  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      100
    );
    cursor = String(nextCursor);
    if (!keys.length) continue;

    const values = await redis.mget(...keys);
    for (let i = 0; i < values.length; i++) {
      const raw = values[i];
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (isCurrentSession(parsed)) {
          sessions.push(parsed);
          continue;
        }
        // 扫描时顺手清掉旧版本，避免定时任务反复读到垃圾数据
        const parts = String(keys[i]).split(":");
        // sakura:witchtrial:session:{selfId}:{groupId}
        const groupId = parts.slice(4).join(":") || parsed?.groupId;
        logger.warn(
          `[魔女审判] 定时扫描丢弃不兼容会话：群 ${groupId} version=${parsed?.version ?? "?"}`
        );
        await purgeStaleSessionArtifacts(selfId, groupId, parsed);
      } catch (error) {
        logger.warn(`[魔女审判] 定时扫描时遇到损坏会话：${error.message}`);
        try {
          await redis.del(keys[i]);
        } catch (_) {
          /* ignore */
        }
      }
    }
  } while (cursor !== "0");

  return sessions;
}

export function isPlayer(session, userId) {
  return session.players.some((player) => player.userId === String(userId));
}

/** 取某人的证物袋 */
export function pouchOf(session, girlId) {
  return session.pouch?.[girlId] || [];
}

export function addToPouch(session, girlId, evidenceId) {
  const bag = session.pouch[girlId] || [];
  if (!bag.includes(evidenceId)) bag.push(evidenceId);
  session.pouch[girlId] = bag;
}

/** 把证据摊上台面，进入集合 P，并追加到全体少女的证物袋 */
export function publicize(session, evidenceId) {
  const added = !session.publicEvidence.includes(evidenceId);
  if (added) {
    session.publicEvidence.push(evidenceId);
  }

  const recipients = new Set([
    ...Object.keys(session.girls || {}),
    ...Object.keys(session.pouch || {}),
  ]);
  for (const girlId of recipients) {
    addToPouch(session, girlId, evidenceId);
  }
  return added;
}

/** 撤下公开证物（目前只用于被揭穿后从案件中移除的伪证） */
export function withdrawPublicEvidence(session, evidenceId) {
  session.publicEvidence = (session.publicEvidence || []).filter(
    (id) => id !== evidenceId
  );
  for (const girlId of Object.keys(session.pouch || {})) {
    session.pouch[girlId] = (session.pouch[girlId] || []).filter(
      (id) => id !== evidenceId
    );
  }
}

/**
 * 抢占会话写锁，覆盖提交、结算、开章与结束；返回锁令牌。
 * 允许传入完整会话，或仅含 { selfId, groupId } 的锁引用（开局/加入/退出时用）。
 */
export async function acquireTurnLock(session) {
  if (session?.selfId == null || session?.groupId == null) {
    throw new TypeError("抢占审判锁需要 selfId 和 groupId");
  }
  const selfId = String(session.selfId);
  const groupId = String(session.groupId);
  const key = `${selfId}:${groupId}`;
  const existing = busySessions.get(key);
  if (existing) {
    const cancelled =
      Boolean(existing.sessionId) &&
      (await redis.get(
        cancellationKey(selfId, groupId, existing.sessionId)
      )) === "1";
    if (!cancelled) return null;
    if (existing.timer) clearInterval(existing.timer);
    busySessions.delete(key);
  }

  const token = randomUUID();
  // 开局等场景还没有 sessionId；有则记入，便于取消时放行重入
  const sessionId =
    typeof session.sessionId === "string" && session.sessionId
      ? session.sessionId
      : "";
  busySessions.set(key, { token, timer: null, sessionId });
  try {
    const redisKey = lockKey(selfId, groupId);
    const claimed = await redis.set(
      redisKey,
      token,
      "PX",
      LOCK_TTL_MS,
      "NX"
    );
    if (claimed !== "OK") {
      busySessions.delete(key);
      return null;
    }

    // 生成牢狱或案件可能连续重试多次，不能让固定 TTL 在 AI 尚未返回时过期。
    // 续租只认自己的令牌；进程崩溃后定时器消失，锁仍会按 TTL 自动释放。
    const timer = setInterval(() => {
      compareExpire(redisKey, token, LOCK_TTL_MS).catch((error) => {
        logger.warn(`[魔女审判] 群 ${groupId} 的会话锁续租失败：${error.message}`);
      });
    }, LOCK_RENEW_INTERVAL_MS);
    timer.unref?.();
    busySessions.set(key, { token, timer, sessionId });
    return token;
  } catch (error) {
    if (busySessions.get(key)?.token === token) busySessions.delete(key);
    throw error;
  }
}

export async function releaseTurnLock(session, token) {
  if (!token) return;
  if (session?.selfId == null || session?.groupId == null) return;
  const key = `${session.selfId}:${session.groupId}`;
  const held = busySessions.get(key);
  if (held?.token === token && held.timer) clearInterval(held.timer);
  try {
    await compareDelete(lockKey(session.selfId, session.groupId), token);
  } finally {
    if (busySessions.get(key)?.token === token) busySessions.delete(key);
  }
}
