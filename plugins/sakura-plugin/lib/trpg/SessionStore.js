/**
 * 跑团会话的 Redis 持久化
 *
 * 不用模块级 Map 存局：框架支持插件热重载，父进程还会在子进程崩溃后重启它，
 * 内存态一重载整局就没了。存 Redis 才能跨重启接着跑。
 *
 * 另外维护一份「玩家 → 所在群」的反查索引，这样玩家可以私聊提交秘密行动。
 */

const SESSION_TTL = 7 * 24 * 60 * 60;
const KEY_PREFIX = "sakura:trpg";

export const PHASES = {
  RECRUITING: "recruiting",
  GENERATING: "generating",
  PLAYING: "playing",
  ENDED: "ended",
};

/** 正在处理回合的会话，防止并发推进同一局 */
const busySessions = new Set();

function sessionKey(selfId, groupId) {
  return `${KEY_PREFIX}:session:${selfId}:${groupId}`;
}

function userKey(selfId, userId) {
  return `${KEY_PREFIX}:user:${selfId}:${userId}`;
}

export function createSession({ selfId, groupId, hostId, hostNickname, theme, tone, maxPlayers, maxRounds, routeId }) {
  const now = Date.now();
  return {
    version: 1,
    selfId: String(selfId),
    groupId: String(groupId),
    hostId: String(hostId),
    phase: PHASES.RECRUITING,
    theme: theme || "",
    tone: tone || "",
    maxPlayers,
    // 开局时固定下来，中途改配置不影响正在跑的这一局
    maxRounds: Number.isFinite(maxRounds) ? maxRounds : 0,
    routeId,
    players: [{ userId: String(hostId), nickname: hostNickname || String(hostId) }],
    module: null,
    characters: {},
    round: 0,
    currentScene: "",
    pendingActions: {},
    currentOptions: [],
    flags: {},
    summaryLines: [],
    recentLog: [],
    createdAt: now,
    updatedAt: now,
  };
}

export async function loadSession(selfId, groupId) {
  const raw = await redis.get(sessionKey(selfId, groupId));
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (error) {
    logger.warn(`[跑团] 群 ${groupId} 的会话数据损坏，已丢弃：${error.message}`);
    await redis.del(sessionKey(selfId, groupId));
    return null;
  }
}

export async function saveSession(session) {
  session.updatedAt = Date.now();
  const key = sessionKey(session.selfId, session.groupId);
  await redis.set(key, JSON.stringify(session), "EX", SESSION_TTL);

  // 同步玩家索引，供私聊指令反查
  const pipeline = redis.pipeline();
  for (const player of session.players) {
    pipeline.set(userKey(session.selfId, player.userId), String(session.groupId), "EX", SESSION_TTL);
  }
  await pipeline.exec();
}

export async function deleteSession(session) {
  await redis.del(sessionKey(session.selfId, session.groupId));

  const pipeline = redis.pipeline();
  for (const player of session.players) {
    pipeline.del(userKey(session.selfId, player.userId));
  }
  await pipeline.exec();

  busySessions.delete(`${session.selfId}:${session.groupId}`);
}

/** 玩家退出时单独清掉他的索引 */
export async function dropUserIndex(selfId, userId) {
  await redis.del(userKey(selfId, userId));
}

/** 按玩家 QQ 反查他正在参与的那一局 */
export async function findSessionByUser(selfId, userId) {
  const groupId = await redis.get(userKey(selfId, userId));
  if (!groupId) return null;

  const session = await loadSession(selfId, groupId);
  if (!session) {
    await redis.del(userKey(selfId, userId));
    return null;
  }
  if (!session.players.some((player) => player.userId === String(userId))) {
    await redis.del(userKey(selfId, userId));
    return null;
  }
  return session;
}

/** 取本局全部角色卡，顺序与 players 一致 */
export function getCharacters(session) {
  return session.players
    .map((player) => session.characters[player.userId])
    .filter(Boolean);
}

export function getCharacter(session, userId) {
  return session.characters[String(userId)] || null;
}

export function isPlayer(session, userId) {
  return session.players.some((player) => player.userId === String(userId));
}

export function isAlive(session, userId) {
  return getCharacter(session, userId)?.alive === true;
}

/** 抢占回合处理权，拿不到说明这局正在推进中 */
export function acquireTurnLock(session) {
  const key = `${session.selfId}:${session.groupId}`;
  if (busySessions.has(key)) return false;
  busySessions.add(key);
  return true;
}

export function releaseTurnLock(session) {
  busySessions.delete(`${session.selfId}:${session.groupId}`);
}
