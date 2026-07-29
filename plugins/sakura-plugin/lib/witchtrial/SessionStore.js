/**
 * 审判会话的 Redis 持久化
 *
 * 不用模块级 Map 存局：框架支持插件热重载，父进程还会在子进程崩溃后重启它，
 * 内存态一重载整局就没了。存 Redis 才能跨重启接着跑。
 *
 * 另外维护一份「玩家 → 所在群」的反查索引。这个游戏的绝大多数动作都走私聊
 * （搜到什么、手里有什么牌、要出示什么，都不能公开），索引是必需的。
 */

const SESSION_TTL = 7 * 24 * 60 * 60;
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

/** 正在处理回合的会话，防止并发推进同一局 */
const busySessions = new Set();

function sessionKey(selfId, groupId) {
  return `${KEY_PREFIX}:session:${selfId}:${groupId}`;
}

function userKey(selfId, userId) {
  return `${KEY_PREFIX}:user:${selfId}:${userId}`;
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
  routeId,
}) {
  const now = Date.now();
  return {
    version: 1,
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

    // 跨章保留的东西：上一章说过的话，这一章还能翻出来对质
    testimony: [],      // { chapter, byId, name, text }
    history: [],        // { chapter, victimName, executedName, correct, truthText }

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
    logger.warn(`[魔女审判] 群 ${groupId} 的会话数据损坏，已丢弃：${error.message}`);
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
