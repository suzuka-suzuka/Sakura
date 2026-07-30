export const SESSION_VERSION = 1

export const PHASES = Object.freeze({
  LOBBY: "lobby",
  AWAITING_ROLL: "awaiting_roll",
  RESOLVING: "resolving",
  AWAITING_PURCHASE: "awaiting_purchase",
  AWAITING_UPGRADE: "awaiting_upgrade",
  ENDED: "ended",
})

export const PHASE_LABELS = Object.freeze({
  [PHASES.LOBBY]: "等待加入",
  [PHASES.AWAITING_ROLL]: "等待掷骰",
  [PHASES.RESOLVING]: "正在结算",
  [PHASES.AWAITING_PURCHASE]: "等待购买",
  [PHASES.AWAITING_UPGRADE]: "等待升级",
  [PHASES.ENDED]: "已结束",
})

export const PLAYER_STATUS = Object.freeze({
  ACTIVE: "active",
  BANKRUPT: "bankrupt",
  SURRENDERED: "surrendered",
})

export const ACTIONS = Object.freeze({
  JOIN: "join",
  LEAVE_LOBBY: "leave_lobby",
  START: "start",
  ROLL: "roll",
  ROLL_TIMEOUT: "roll_timeout",
  DECIDE: "decide",
  DECISION_TIMEOUT: "decision_timeout",
  SURRENDER: "surrender",
  FORCE_END: "force_end",
})

export const DECISIONS = Object.freeze({
  PURCHASE: "purchase",
  UPGRADE: "upgrade",
  DECLINE: "decline",
})

export const END_REASONS = Object.freeze({
  LAST_PLAYER: "last_player",
  ROUND_LIMIT: "round_limit",
  FORCE: "force",
  LOBBY_EMPTY: "lobby_empty",
  LOBBY_EXPIRED: "lobby_expired",
})

export const PLAYER_COLORS = Object.freeze([
  "#EF5350",
  "#42A5F5",
  "#66BB6A",
  "#FFA726",
  "#AB47BC",
  "#26A69A",
])

export class GameRuleError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "GameRuleError"
    this.code = code
  }
}

export function ruleError(code, message) {
  throw new GameRuleError(code, message)
}
