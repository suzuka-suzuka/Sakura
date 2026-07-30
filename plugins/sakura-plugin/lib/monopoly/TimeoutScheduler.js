import { PHASES } from "./constants.js"

const MAX_TIMEOUT_MS = 2_147_000_000
const NOOP_LOGGER = Object.freeze({
  error() {},
})

export class TimeoutScheduler {
  constructor({
    onTimeout,
    now = () => Date.now(),
    log = NOOP_LOGGER,
  } = {}) {
    if (typeof onTimeout !== "function") {
      throw new TypeError("TimeoutScheduler 需要 onTimeout 回调")
    }
    this.onTimeout = onTimeout
    this.now = now
    this.log = log
    this.timers = new Map()
  }

  key(selfId, groupId) {
    return `${selfId}:${groupId}`
  }

  tokenFrom(session) {
    return {
      sessionId: session.sessionId,
      selfId: session.selfId,
      groupId: session.groupId,
      turnSeq: session.turnSeq,
      phase: session.phase,
      deadlineAt: session.deadlineAt,
    }
  }

  schedule(session) {
    const key = this.key(session.selfId, session.groupId)
    this.cancel(session.selfId, session.groupId)
    if (
      session.phase === PHASES.ENDED ||
      !Number.isSafeInteger(session.deadlineAt) ||
      session.deadlineAt <= 0
    ) {
      return false
    }

    const token = this.tokenFrom(session)
    const delay = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(0, session.deadlineAt - this.now())
    )
    const timer = setTimeout(async () => {
      const held = this.timers.get(key)
      if (held?.timer !== timer) return
      this.timers.delete(key)
      try {
        await this.onTimeout(token)
      } catch (error) {
        this.log.error(
          `[大富翁] 群 ${session.groupId} 超时处理失败：${error.stack || error}`
        )
      }
    }, delay)
    timer.unref?.()
    this.timers.set(key, { timer, token })
    return true
  }

  cancel(selfId, groupId) {
    const key = this.key(selfId, groupId)
    const held = this.timers.get(key)
    if (!held) return false
    clearTimeout(held.timer)
    this.timers.delete(key)
    return true
  }

  clear() {
    for (const held of this.timers.values()) clearTimeout(held.timer)
    this.timers.clear()
  }
}
