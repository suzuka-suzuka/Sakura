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
  return String(
    session?.sessionId ||
      `legacy:${session?.selfId || ""}:${session?.groupId || ""}:${session?.createdAt || 0}`
  );
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
    version: 4,
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
    publicEvidence: [], // 集合 P：已公开的证据 id
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

function migrateSession(session) {
  if (!session || typeof session !== "object") return session;
  if (!Number.isFinite(session.version) || session.version < 2) {
    session.advancePending = Boolean(session.advancePending);
    session.pendingActions ||= {};
    for (const action of Object.values(session.pendingActions)) {
      if (action?.kind === "refute") {
        action.kind = "play";
        action.stance = "refute";
      }
    }
    session.claims = (session.claims || []).map((claim) => ({
      ...claim,
      broken: Boolean(claim.broken),
    }));

    const locationCodes = "ABCDEFGHIJ";
    (session.prison?.locations || []).forEach((location, index) => {
      location.code ||= locationCodes[index] || "";
    });
    const girls = Object.values(session.girls || {});
    if (girls.some((girl) => !girl.code)) {
      girls
        .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh"))
        .forEach((girl, index) => {
          girl.code = String(index + 1).padStart(3, "0");
        });
    }
    session.version = 2;
  }
  if (session.version < 3) {
    session.turnTimeoutMs =
      Number.isFinite(session.turnTimeoutMs) && session.turnTimeoutMs > 0
        ? session.turnTimeoutMs
        : DEFAULT_TURN_TIMEOUT_MS;
    session.turnDeadlineAt = Number.isFinite(session.turnDeadlineAt)
      ? session.turnDeadlineAt
      : 0;
    session.investigationLeads ||= {};
    session.fakeUsed = Boolean(session.fakeUsed);
    session.version = 3;
  }
  if (session.version < 4) {
    session.sessionId = sessionIdentity(session);
    session.version = 4;
  }
  session.sessionId ||= sessionIdentity(session);
  return session;
}

export function armTurnDeadline(session, now = Date.now()) {
  const timeoutMs =
    Number.isFinite(session?.turnTimeoutMs) && session.turnTimeoutMs > 0
      ? session.turnTimeoutMs
      : DEFAULT_TURN_TIMEOUT_MS;
  session.turnDeadlineAt = now + timeoutMs;
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
    return migrateSession(JSON.parse(raw));
  } catch (error) {
    logger.warn(`[魔女审判] 群 ${groupId} 的会话数据损坏，已丢弃：${error.message}`);
    await redis.del(sessionKey(selfId, groupId));
    return null;
  }
}

export async function saveSession(session) {
  session.sessionId ||= sessionIdentity(session);
  session.updatedAt = Date.now();
  const keys = [
    sessionKey(session.selfId, session.groupId),
    cancellationKey(
      session.selfId,
      session.groupId,
      sessionIdentity(session)
    ),
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
  session.sessionId ||= sessionIdentity(session);
  const keys = [
    sessionKey(session.selfId, session.groupId),
    cancellationKey(
      session.selfId,
      session.groupId,
      sessionIdentity(session)
    ),
    ...session.players.map((player) => userKey(session.selfId, player.userId)),
  ];
  const deleted = await redis.eval(
    `-- witchtrial_delete
redis.call('SET', KEYS[2], '1', 'EX', ARGV[2])
local raw = redis.call('GET', KEYS[1])
if raw then
  local ok, current = pcall(cjson.decode, raw)
  if ok and current.sessionId and tostring(current.sessionId) ~= ARGV[1] then
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
    sessionIdentity(session),
    String(SESSION_TTL),
    String(session.groupId)
  );
  return Number(deleted) === 1;
}

/** 当前长任务是否已被房主/管理员终止。 */
export async function isSessionCancelled(session) {
  const cancelled = await redis.get(
    cancellationKey(
      session.selfId,
      session.groupId,
      sessionIdentity(session)
    )
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
  if (current && sessionIdentity(current) === sessionIdentity(session)) {
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
    for (const raw of values) {
      if (!raw) continue;
      try {
        const session = migrateSession(JSON.parse(raw));
        if (session) sessions.push(session);
      } catch (error) {
        logger.warn(`[魔女审判] 定时扫描时遇到损坏会话：${error.message}`);
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
  if (!session.pouch) session.pouch = {};
  const bag = session.pouch[girlId] || [];
  if (!bag.includes(evidenceId)) bag.push(evidenceId);
  session.pouch[girlId] = bag;
}

/** 把证据摊上台面，进入集合 P */
export function publicize(session, evidenceId) {
  if (!session.publicEvidence.includes(evidenceId)) {
    session.publicEvidence.push(evidenceId);
    return true;
  }
  return false;
}

/** 抢占会话写锁，覆盖提交、结算、开章与结束；返回锁令牌 */
export async function acquireTurnLock(session) {
  const key = `${session.selfId}:${session.groupId}`;
  const existing = busySessions.get(key);
  if (existing) {
    const cancelled =
      Boolean(existing.sessionId) &&
      (await redis.get(
        cancellationKey(session.selfId, session.groupId, existing.sessionId)
      )) === "1";
    if (!cancelled) return null;
    if (existing.timer) clearInterval(existing.timer);
    busySessions.delete(key);
  }

  const token = randomUUID();
  const sessionId = sessionIdentity(session);
  busySessions.set(key, { token, timer: null, sessionId });
  try {
    const redisKey = lockKey(session.selfId, session.groupId);
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
        logger.warn(`[魔女审判] 群 ${session.groupId} 的会话锁续租失败：${error.message}`);
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
  const key = `${session.selfId}:${session.groupId}`;
  const held = busySessions.get(key);
  if (held?.token === token && held.timer) clearInterval(held.timer);
  try {
    await compareDelete(lockKey(session.selfId, session.groupId), token);
  } finally {
    if (busySessions.get(key)?.token === token) busySessions.delete(key);
  }
}
