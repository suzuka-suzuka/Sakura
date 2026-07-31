import { randomUUID } from "node:crypto"
import {
  PHASES,
  PLAYER_STATUS,
  SESSION_VERSION,
} from "./constants.js"

const KEY_PREFIX = "sakura:monopoly"
const DEFAULT_SESSION_TTL_SECONDS = 48 * 60 * 60
const DEFAULT_LOCK_TTL_MS = 30_000
const DEFAULT_LOCK_RENEW_MS = 10_000
const NOOP_LOGGER = Object.freeze({
  warn() {},
})

function isCurrentSession(session) {
  return (
    session !== null &&
    typeof session === "object" &&
    session.version === SESSION_VERSION &&
    typeof session.sessionId === "string" &&
    session.sessionId.length > 0 &&
    typeof session.selfId === "string" &&
    typeof session.groupId === "string"
  )
}

function assertCurrentSession(session) {
  if (!isCurrentSession(session)) {
    throw new TypeError(`只接受版本 ${SESSION_VERSION} 的大富翁会话`)
  }
  return session
}

export class SessionCancelledError extends Error {
  constructor(session) {
    super(`大富翁会话 ${session?.groupId || ""} 已经结束`)
    this.name = "SessionCancelledError"
    this.code = "MONOPOLY_SESSION_CANCELLED"
  }
}

export class SessionConflictError extends Error {
  constructor(message, code = "MONOPOLY_SESSION_CONFLICT") {
    super(message)
    this.name = "SessionConflictError"
    this.code = code
  }
}

export class MonopolySessionStore {
  constructor(
    redisClient = null,
    {
      sessionTtlSeconds = DEFAULT_SESSION_TTL_SECONDS,
      lockTtlMs = DEFAULT_LOCK_TTL_MS,
      lockRenewMs = DEFAULT_LOCK_RENEW_MS,
      log = NOOP_LOGGER,
    } = {}
  ) {
    if (!redisClient) {
      throw new TypeError("MonopolySessionStore 需要 Redis 客户端")
    }
    this.redis = redisClient
    this.sessionTtlSeconds = sessionTtlSeconds
    this.lockTtlMs = lockTtlMs
    this.lockRenewMs = Math.min(lockRenewMs, Math.max(1000, lockTtlMs / 2))
    this.log = log
    this.busySessions = new Map()
  }

  sessionKey(_selfId, groupId) {
    return `${KEY_PREFIX}:session:${groupId}`
  }

  userKey(selfId, userId) {
    return `${KEY_PREFIX}:user:${selfId}:${userId}`
  }

  lockKey(_selfId, groupId) {
    return `${KEY_PREFIX}:lock:${groupId}`
  }

  cancellationKey(_selfId, groupId, sessionId) {
    return `${KEY_PREFIX}:cancelled:${groupId}:${sessionId}`
  }

  localLockKey(_selfId, groupId) {
    return String(groupId)
  }

  async compareDelete(key, expected) {
    return this.redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      1,
      key,
      String(expected)
    )
  }

  async compareExpire(key, expected, ttlMs) {
    return this.redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end",
      1,
      key,
      String(expected),
      String(ttlMs)
    )
  }

  async purgeStaleSessionArtifacts(selfId, groupId, parsed) {
    const players = Array.isArray(parsed?.players) ? parsed.players : []
    const pipeline = this.redis.multi()
    pipeline.del(this.sessionKey(selfId, groupId))
    if (parsed?.sessionId) {
      pipeline.del(
        this.cancellationKey(selfId, groupId, parsed.sessionId)
      )
    }
    for (const player of players) {
      if (player?.userId == null) continue
      pipeline.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
        1,
        this.userKey(selfId, player.userId),
        String(groupId)
      )
    }
    await pipeline.exec()
  }

  async loadSession(selfId, groupId) {
    const raw = await this.redis.get(this.sessionKey(selfId, groupId))
    if (!raw) return null

    try {
      const session = JSON.parse(raw)
      if (isCurrentSession(session)) return session
      this.log.warn(
        `[大富翁] 群 ${groupId} 会话版本不兼容（version=${session?.version ?? "?"}，需要 ${SESSION_VERSION}），已清理`
      )
      await this.purgeStaleSessionArtifacts(selfId, groupId, session)
      return null
    } catch (error) {
      this.log.warn(
        `[大富翁] 群 ${groupId} 会话数据损坏，已清理：${error.message}`
      )
      await this.redis.del(this.sessionKey(selfId, groupId))
      return null
    }
  }

  async saveSession(session) {
    assertCurrentSession(session)
    const indexedPlayers = session.players.filter(
      (player) => player.status === PLAYER_STATUS.ACTIVE
    )
    const keys = [
      this.sessionKey(session.selfId, session.groupId),
      this.cancellationKey(
        session.selfId,
        session.groupId,
        session.sessionId
      ),
      ...indexedPlayers.map((player) =>
        this.userKey(session.selfId, player.userId)
      ),
    ]
    const result = await this.redis.eval(
      `-- monopoly_save
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
local raw = redis.call('GET', KEYS[1])
if raw then
  local ok, current = pcall(cjson.decode, raw)
  if not ok then return -3 end
  if tostring(current.sessionId or '') ~= ARGV[4] then return -1 end
end
for i = 3, #KEYS do
  local currentGroup = redis.call('GET', KEYS[i])
  if currentGroup and currentGroup ~= ARGV[3] then return -2 end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
for i = 3, #KEYS do
  redis.call('SET', KEYS[i], ARGV[3], 'EX', ARGV[2])
end
return 1`,
      keys.length,
      ...keys,
      JSON.stringify(session),
      String(this.sessionTtlSeconds),
      String(session.groupId),
      session.sessionId
    )

    if (Number(result) === 0) throw new SessionCancelledError(session)
    if (Number(result) === -1) {
      throw new SessionConflictError("另一个新会话已经占用了本群。")
    }
    if (Number(result) === -2) {
      throw new SessionConflictError(
        "有玩家已经加入了另一个群的大富翁。",
        "MONOPOLY_USER_CONFLICT"
      )
    }
    if (Number(result) === -3) {
      throw new SessionConflictError("Redis 中的现有会话数据已损坏。")
    }
    if (Number(result) !== 1) {
      throw new SessionConflictError(`保存大富翁会话失败：${result}`)
    }
    return true
  }

  async deleteSession(session) {
    assertCurrentSession(session)
    const keys = [
      this.sessionKey(session.selfId, session.groupId),
      this.cancellationKey(
        session.selfId,
        session.groupId,
        session.sessionId
      ),
      ...session.players.map((player) =>
        this.userKey(session.selfId, player.userId)
      ),
    ]
    const result = await this.redis.eval(
      `-- monopoly_delete
redis.call('SET', KEYS[2], '1', 'EX', ARGV[2])
local raw = redis.call('GET', KEYS[1])
if raw then
  local ok, current = pcall(cjson.decode, raw)
  if ok and tostring(current.sessionId or '') ~= ARGV[1] then return 0 end
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
      session.sessionId,
      String(this.sessionTtlSeconds),
      String(session.groupId)
    )
    return Number(result) === 1
  }

  async claimUserIndex(selfId, userId, groupId) {
    const key = this.userKey(selfId, userId)
    const wanted = String(groupId)

    for (let attempt = 0; attempt < 2; attempt++) {
      const claimed = await this.redis.set(
        key,
        wanted,
        "EX",
        this.sessionTtlSeconds,
        "NX"
      )
      if (claimed === "OK") return { ok: true, groupId: wanted }

      const existing = await this.redis.get(key)
      if (existing === wanted) {
        await this.redis.expire(key, this.sessionTtlSeconds)
        return { ok: true, groupId: wanted }
      }

      if (existing) {
        const session = await this.loadSession(selfId, existing)
        const stillParticipating =
          session &&
          session.phase !== PHASES.ENDED &&
          session.players.some(
            (player) =>
              player.userId === String(userId) &&
              player.status === PLAYER_STATUS.ACTIVE
          )
        if (stillParticipating) {
          return { ok: false, groupId: String(existing) }
        }
        await this.compareDelete(key, existing)
      }
    }

    const existing = await this.redis.get(key)
    return {
      ok: existing === wanted,
      groupId: existing ? String(existing) : "",
    }
  }

  async dropUserIndex(selfId, userId, groupId) {
    if (groupId === undefined || groupId === null) return false
    return this.compareDelete(
      this.userKey(selfId, userId),
      String(groupId)
    )
  }

  async findSessionByUser(selfId, userId) {
    const groupId = await this.redis.get(this.userKey(selfId, userId))
    if (!groupId) return null
    const session = await this.loadSession(selfId, groupId)
    if (
      !session ||
      session.phase === PHASES.ENDED ||
      !session.players.some(
        (player) =>
          player.userId === String(userId) &&
          player.status === PLAYER_STATUS.ACTIVE
      )
    ) {
      await this.compareDelete(this.userKey(selfId, userId), groupId)
      return null
    }
    return session
  }

  async listSessionsBySelfId(selfId) {
    const normalizedSelfId = String(selfId)
    const pattern = `${KEY_PREFIX}:session:*`
    const sessions = []
    let cursor = "0"

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100
      )
      cursor = String(nextCursor)
      if (!keys.length) continue

      const values = await this.redis.mget(...keys)
      for (let index = 0; index < values.length; index++) {
        const raw = values[index]
        if (!raw) continue
        try {
          const session = JSON.parse(raw)
          if (isCurrentSession(session)) {
            if (session.selfId === normalizedSelfId) sessions.push(session)
            continue
          }
          const groupId =
            String(keys[index]).split(":").slice(3).join(":") ||
            session?.groupId
          await this.purgeStaleSessionArtifacts(
            session?.selfId || normalizedSelfId,
            groupId,
            session
          )
        } catch (error) {
          this.log.warn(
            `[大富翁] 扫描到损坏会话，已清理：${error.message}`
          )
          await this.redis.del(keys[index])
        }
      }
    } while (cursor !== "0")

    return sessions
  }

  async acquireSessionLock({ selfId, groupId }) {
    if (selfId == null || groupId == null) {
      throw new TypeError("大富翁会话锁需要 selfId 和 groupId")
    }
    const normalizedSelfId = String(selfId)
    const normalizedGroupId = String(groupId)
    const localKey = this.localLockKey(normalizedSelfId, normalizedGroupId)
    if (this.busySessions.has(localKey)) return null

    const token = randomUUID()
    this.busySessions.set(localKey, { token, timer: null })
    try {
      const redisKey = this.lockKey(normalizedSelfId, normalizedGroupId)
      const claimed = await this.redis.set(
        redisKey,
        token,
        "PX",
        this.lockTtlMs,
        "NX"
      )
      if (claimed !== "OK") {
        this.busySessions.delete(localKey)
        return null
      }

      const timer = setInterval(() => {
        this.compareExpire(redisKey, token, this.lockTtlMs).catch((error) => {
          this.log.warn(
            `[大富翁] 群 ${normalizedGroupId} 会话锁续租失败：${error.message}`
          )
        })
      }, this.lockRenewMs)
      timer.unref?.()
      this.busySessions.set(localKey, { token, timer })
      return token
    } catch (error) {
      if (this.busySessions.get(localKey)?.token === token) {
        this.busySessions.delete(localKey)
      }
      throw error
    }
  }

  async releaseSessionLock({ selfId, groupId }, token) {
    if (!token || selfId == null || groupId == null) return
    const normalizedSelfId = String(selfId)
    const normalizedGroupId = String(groupId)
    const localKey = this.localLockKey(normalizedSelfId, normalizedGroupId)
    const held = this.busySessions.get(localKey)
    if (held?.token === token && held.timer) clearInterval(held.timer)
    try {
      await this.compareDelete(
        this.lockKey(normalizedSelfId, normalizedGroupId),
        token
      )
    } catch (error) {
      this.log.warn(
        `[大富翁] 群 ${normalizedGroupId} 会话锁释放失败，将等待租期自动失效：${error.message}`
      )
    } finally {
      if (this.busySessions.get(localKey)?.token === token) {
        this.busySessions.delete(localKey)
      }
    }
  }

  destroy() {
    for (const [groupId, held] of this.busySessions.entries()) {
      if (held.timer) clearInterval(held.timer)
      void this.compareDelete(this.lockKey("", groupId), held.token).catch(
        () => {}
      )
    }
    this.busySessions.clear()
  }
}

export {
  DEFAULT_LOCK_TTL_MS,
  DEFAULT_SESSION_TTL_SECONDS,
  isCurrentSession,
}
