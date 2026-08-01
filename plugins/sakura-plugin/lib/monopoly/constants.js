export const SESSION_VERSION = 5

export const PHASES = Object.freeze({
  LOBBY: "lobby",
  AWAITING_ROLL: "awaiting_roll",
  RESOLVING: "resolving",
  AWAITING_PURCHASE: "awaiting_purchase",
  AWAITING_DEBT: "awaiting_debt",
  AWAITING_COUNTER: "awaiting_counter",
  ENDED: "ended",
})

export const PHASE_LABELS = Object.freeze({
  [PHASES.LOBBY]: "等待加入",
  [PHASES.AWAITING_ROLL]: "等待掷骰",
  [PHASES.RESOLVING]: "正在结算",
  [PHASES.AWAITING_PURCHASE]: "等待购买",
  [PHASES.AWAITING_DEBT]: "等待筹款",
  [PHASES.AWAITING_COUNTER]: "等待否决",
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
  BUILD: "build",
  SELL_BUILDING: "sell_building",
  MORTGAGE: "mortgage",
  REDEEM: "redeem",
  RESOLVE_DEBT: "resolve_debt",
  DEBT_TIMEOUT: "debt_timeout",
  USE_ITEM: "use_item",
  COUNTER: "counter",
  COUNTER_PASS: "counter_pass",
  COUNTER_TIMEOUT: "counter_timeout",
  SURRENDER: "surrender",
  FORCE_END: "force_end",
})

export const DECISIONS = Object.freeze({
  PURCHASE: "purchase",
  DECLINE: "decline",
})

export const END_REASONS = Object.freeze({
  LAST_PLAYER: "last_player",
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

export const PLAYER_COLOR_LABELS = Object.freeze({
  "#EF5350": "红色",
  "#42A5F5": "蓝色",
  "#66BB6A": "绿色",
  "#FFA726": "橙色",
  "#AB47BC": "紫色",
  "#26A69A": "青色",
})

export function playerPublicLabel(player, fallbackIndex = 0) {
  const colorLabel = PLAYER_COLOR_LABELS[player?.color]
  if (colorLabel) return colorLabel
  const seat =
    Number.isSafeInteger(player?.joinOrder) && player.joinOrder >= 0
      ? player.joinOrder + 1
      : fallbackIndex + 1
  return `玩家${seat}`
}

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
