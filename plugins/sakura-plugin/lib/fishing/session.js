export const FISHING_PHASE = Object.freeze({
  starting: "starting",
  waiting: "waiting",
  weightCheck: "weight_check",
  difficultyCheck: "difficulty_check",
  fighting: "fighting",
  settling: "settling",
});

export const FISHING_ACTION = Object.freeze({
  abandon: "abandon",
  reel: "reel",
  forcePull: "force_pull",
  startTug: "start_tug",
  pull: "pull",
  loosen: "loosen",
});

export function parseFishingAction(phase, message) {
  const msg = String(message || "").trim();
  if (phase === FISHING_PHASE.weightCheck) {
    if (/^放弃$/.test(msg)) return FISHING_ACTION.abandon;
    if (/^(收|拉)(杆|竿)$/.test(msg)) return FISHING_ACTION.reel;
    return null;
  }
  if (phase === FISHING_PHASE.difficultyCheck) {
    if (/^强拉$/.test(msg)) return FISHING_ACTION.forcePull;
    if (/^溜鱼$/.test(msg)) return FISHING_ACTION.startTug;
    return null;
  }
  if (phase === FISHING_PHASE.fighting) {
    if (/^拉$/.test(msg)) return FISHING_ACTION.pull;
    if (/^溜$/.test(msg)) return FISHING_ACTION.loosen;
  }
  return null;
}

export class FishingSessionStore {
  constructor({ clearTimer = clearTimeout } = {}) {
    this.clearTimer = clearTimer;
    this.sessions = new Map();
  }

  get(key) {
    return this.sessions.get(String(key)) || null;
  }

  entries() {
    return [...this.sessions.entries()];
  }

  create(key, values = {}) {
    const normalizedKey = String(key);
    if (this.sessions.has(normalizedKey)) return null;
    if (!values.id) throw new TypeError("钓鱼会话缺少 id");
    const session = {
      phase: FISHING_PHASE.starting,
      processing: false,
      settled: false,
      ...values,
    };
    this.sessions.set(normalizedKey, session);
    return session;
  }

  claimAction(key, sessionId) {
    const session = this.get(key);
    if (!session || session.id !== sessionId || session.processing || session.settled) {
      return false;
    }
    session.processing = true;
    return true;
  }

  releaseAction(key, sessionId) {
    const session = this.get(key);
    if (session && session.id === sessionId && !session.settled) {
      session.processing = false;
      return true;
    }
    return false;
  }

  beginSettlement(key, sessionId) {
    const session = this.get(key);
    if (!session || session.id !== sessionId || session.settled) return false;
    session.settled = true;
    session.phase = FISHING_PHASE.settling;
    return true;
  }

  finish(key, sessionId = null) {
    const normalizedKey = String(key);
    const session = this.sessions.get(normalizedKey);
    if (!session || (sessionId && session.id !== sessionId)) return null;

    for (const timerName of ["waitingTimer", "totalTimer", "confirmTimer"]) {
      if (session[timerName]) this.clearTimer(session[timerName]);
      session[timerName] = null;
    }
    this.sessions.delete(normalizedKey);
    return session;
  }

}
