import {
  DECISIONS,
  PHASES,
  ruleError,
} from "../constants.js"
import { playerById, tileById } from "./state.js"

export function ownsCompleteGroup(state, map, playerId, groupId) {
  const group = map.propertyGroups.find((item) => item.id === groupId)
  if (!group) return false
  const wanted = String(playerId)
  return group.tileIds.every(
    (tileId) => state.propertyStates[String(tileId)]?.ownerId === wanted
  )
}

export function rentFor(state, map, tile) {
  const propertyState = state.propertyStates[String(tile.id)]
  if (!propertyState) ruleError("INVALID_PROPERTY", "地产状态不存在。")
  let rent = tile.rentByLevel[propertyState.level]
  if (
    propertyState.ownerId !== null &&
    ownsCompleteGroup(state, map, propertyState.ownerId, tile.groupId)
  ) {
    rent = Math.floor(rent * map.gameDefaults.completeSetRentMultiplier)
  }
  return rent
}

export function createPropertyDecision(
  state,
  map,
  playerId,
  tile,
  now,
  events
) {
  const player = playerById(state, playerId)
  const propertyState = state.propertyStates[String(tile.id)]
  if (!player || !propertyState) {
    ruleError("INVALID_PROPERTY", "无法创建地产选择。")
  }

  if (propertyState.ownerId === null && player.cash >= tile.price) {
    state.phase = PHASES.AWAITING_PURCHASE
    state.pendingDecision = {
      type: DECISIONS.PURCHASE,
      playerId: player.userId,
      tileId: tile.id,
      createdAt: now,
    }
    state.deadlineAt =
      now + map.gameDefaults.decisionTimeoutSeconds * 1000
    events.push({
      type: "purchase_offered",
      playerId: player.userId,
      tileId: tile.id,
      price: tile.price,
      deadlineAt: state.deadlineAt,
    })
    return true
  }

  if (
    propertyState.ownerId === player.userId &&
    propertyState.level < map.gameDefaults.maxPropertyLevel &&
    player.cash >= tile.upgradeCost
  ) {
    state.phase = PHASES.AWAITING_UPGRADE
    state.pendingDecision = {
      type: DECISIONS.UPGRADE,
      playerId: player.userId,
      tileId: tile.id,
      createdAt: now,
    }
    state.deadlineAt =
      now + map.gameDefaults.decisionTimeoutSeconds * 1000
    events.push({
      type: "upgrade_offered",
      playerId: player.userId,
      tileId: tile.id,
      price: tile.upgradeCost,
      currentLevel: propertyState.level,
      deadlineAt: state.deadlineAt,
    })
    return true
  }

  return false
}

export function resolvePropertyDecision(
  state,
  map,
  playerId,
  decision,
  events,
  { automatic = false } = {}
) {
  const pending = state.pendingDecision
  if (!pending) ruleError("NO_PENDING_DECISION", "当前没有待处理的地产选择。")
  if (pending.playerId !== String(playerId)) {
    ruleError("NOT_CURRENT_PLAYER", "这个选择不属于你。")
  }

  const tile = tileById(map, pending.tileId)
  const propertyState = state.propertyStates[String(pending.tileId)]
  const player = playerById(state, playerId)
  if (!tile || tile.type !== "property" || !propertyState || !player) {
    ruleError("INVALID_PROPERTY", "待处理地产已经失效。")
  }

  if (decision === DECISIONS.DECLINE) {
    events.push({
      type: "decision_declined",
      playerId: player.userId,
      tileId: tile.id,
      decisionType: pending.type,
      automatic,
    })
    return
  }

  if (pending.type === DECISIONS.PURCHASE) {
    if (decision !== DECISIONS.PURCHASE) {
      ruleError("WRONG_DECISION", "当前应选择购买或放弃。")
    }
    if (propertyState.ownerId !== null) {
      ruleError("PROPERTY_OWNED", "这块地产已经有主人了。")
    }
    if (player.cash < tile.price) {
      ruleError("INSUFFICIENT_CASH", "你的现金已经不足以购买这块地产。")
    }
    player.cash -= tile.price
    propertyState.ownerId = player.userId
    propertyState.level = 0
    events.push({
      type: "property_purchased",
      playerId: player.userId,
      tileId: tile.id,
      amount: tile.price,
    })
    return
  }

  if (pending.type === DECISIONS.UPGRADE) {
    if (decision !== DECISIONS.UPGRADE) {
      ruleError("WRONG_DECISION", "当前应选择升级或放弃。")
    }
    if (propertyState.ownerId !== player.userId) {
      ruleError("NOT_PROPERTY_OWNER", "这块地产已经不属于你。")
    }
    if (propertyState.level >= map.gameDefaults.maxPropertyLevel) {
      ruleError("PROPERTY_MAX_LEVEL", "这块地产已经满级。")
    }
    if (player.cash < tile.upgradeCost) {
      ruleError("INSUFFICIENT_CASH", "你的现金已经不足以升级这块地产。")
    }
    player.cash -= tile.upgradeCost
    propertyState.level += 1
    events.push({
      type: "property_upgraded",
      playerId: player.userId,
      tileId: tile.id,
      amount: tile.upgradeCost,
      level: propertyState.level,
    })
    return
  }

  ruleError("INVALID_DECISION", "未知的地产选择。")
}
