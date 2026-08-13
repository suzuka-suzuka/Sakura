/**
 * 对战会话存储
 *
 * 全部走 Redis + TTL：一局对战是有寿命的临时状态，
 * 项目约定「不过期的状态落 SQLite，Redis 只放带 TTL 的键」，对战会话属于后者。
 * 战绩统计之类的长期数据以后要做的话再另开 SQLite 表。
 */

import { getRedis } from "../../../../src/utils/redis.js"

const TTL_BATTLE = 3 * 3600 // 一局最长活 3 小时（测试期不做超时判负，靠 TTL 兜底）
const TTL_INVITE = 180

const kBattle = (scope) => `ba:battle:${scope}`
const kUser = (selfId, userId) => `ba:user:${selfId}:${userId}`
const kInvite = (scope) => `ba:invite:${scope}`
const kLock = (scope) => `ba:lock:${scope}`

export class BattleStore {
  constructor(redis = getRedis()) {
    this.redis = redis
  }

  // ---------- 邀请 ----------

  async setInvite(scope, invite) {
    await this.redis.set(kInvite(scope), JSON.stringify(invite), "EX", TTL_INVITE)
  }

  async getInvite(scope) {
    const raw = await this.redis.get(kInvite(scope))
    return raw ? JSON.parse(raw) : null
  }

  async clearInvite(scope) {
    await this.redis.del(kInvite(scope))
  }

  // ---------- 对局 ----------

  async load(scope) {
    const raw = await this.redis.get(kBattle(scope))
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      await this.redis.del(kBattle(scope))
      return null
    }
  }

  async save(scope, session) {
    await this.redis.set(kBattle(scope), JSON.stringify(session), "EX", TTL_BATTLE)
  }

  /** 同时建立 用户 → 群 的反查，配队私聊要靠它路由回来 */
  async saveWithRouting(scope, selfId, session) {
    const pipe = this.redis.multi()
    pipe.set(kBattle(scope), JSON.stringify(session), "EX", TTL_BATTLE)
    for (const s of session.players) {
      pipe.set(kUser(selfId, s.uid), scope, "EX", TTL_BATTLE)
    }
    await pipe.exec()
  }

  async findByUser(selfId, userId) {
    return this.redis.get(kUser(selfId, userId))
  }

  async clear(scope, selfId, session) {
    const pipe = this.redis.multi()
    pipe.del(kBattle(scope))
    pipe.del(kInvite(scope))
    for (const s of session?.players || []) pipe.del(kUser(selfId, s.uid))
    await pipe.exec()
  }

  /**
   * 结算互斥：同一人连点两下、或两条指令撞在一起时，只让一条进内核。
   * 拿不到锁就直接放弃这次指令，不排队——重复出招比丢一条更糟。
   */
  async withLock(scope, fn) {
    const token = String(Date.now()) + Math.random().toString(36).slice(2)
    const ok = await this.redis.set(kLock(scope), token, "PX", 8000, "NX")
    if (!ok) return { locked: false }
    try {
      return { locked: true, result: await fn() }
    } finally {
      await this.redis.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
        1,
        kLock(scope),
        token
      )
    }
  }
}
