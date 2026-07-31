import {
  DECISIONS,
  PHASES,
  ruleError,
} from "../constants.js"
import {
  buildingLabel,
  hotelLevel,
} from "./buildings.js"
import { playerById, tileById } from "./state.js"

export function propertyKind(tile) {
  return tile?.propertyKind || "street"
}

export function ownsCompleteGroup(state, map, playerId, groupId) {
  const group = map.propertyGroups.find((item) => item.id === groupId)
  if (!group) return false
  const wanted = String(playerId)
  return group.tileIds.every(
    (tileId) => state.propertyStates[String(tileId)]?.ownerId === wanted
  )
}

function ownedCountInGroup(state, map, playerId, groupId) {
  const group = map.propertyGroups.find((item) => item.id === groupId)
  if (!group) return 0
  const wanted = String(playerId)
  return group.tileIds.filter(
    (tileId) => state.propertyStates[String(tileId)]?.ownerId === wanted
  ).length
}

export function rentFor(state, map, tile) {
  const propertyState = state.propertyStates[String(tile.id)]
  if (!propertyState) ruleError("INVALID_PROPERTY", "地产状态不存在。")
  if (propertyState.mortgaged) return 0
  const kind = propertyKind(tile)
  if (kind === "station") {
    const ownedCount = ownedCountInGroup(
      state,
      map,
      propertyState.ownerId,
      tile.groupId
    )
    return tile.rentByOwnedCount[Math.max(0, ownedCount - 1)]
  }
  if (kind === "utility") {
    const ownedCount = ownedCountInGroup(
      state,
      map,
      propertyState.ownerId,
      tile.groupId
    )
    const multiplier =
      tile.rentDiceMultipliers[Math.max(0, ownedCount - 1)]
    return (state.lastDice?.total || 0) * multiplier
  }

  let rent = tile.rentByLevel[propertyState.level]
  if (
    propertyState.level === 0 &&
    propertyState.ownerId !== null &&
    ownsCompleteGroup(state, map, propertyState.ownerId, tile.groupId)
  ) {
    rent = Math.floor(rent * map.gameDefaults.completeSetRentMultiplier)
  }
  return rent
}

export function createBuildingPlan(state, map, playerId, tile) {
  const propertyState = state.propertyStates[String(tile.id)]
  if (
    !propertyState ||
    propertyKind(tile) !== "street" ||
    propertyState.ownerId !== String(playerId) ||
    !ownsCompleteGroup(state, map, playerId, tile.groupId)
  ) {
    return null
  }

  const group = map.propertyGroups.find((item) => item.id === tile.groupId)
  if (
    group.tileIds.some(
      (tileId) => state.propertyStates[String(tileId)].mortgaged
    )
  ) {
    return null
  }
  const levels = group.tileIds.map(
    (tileId) => state.propertyStates[String(tileId)].level
  )
  if (propertyState.level !== Math.min(...levels)) return null
  if (propertyState.level >= map.gameDefaults.maxPropertyLevel) return null

  const targetLevel = propertyState.level + 1
  const buildingType =
    targetLevel === hotelLevel(map) ? "hotel" : "house"
  const available =
    buildingType === "hotel"
      ? state.buildingSupply.hotels
      : state.buildingSupply.houses

  return {
    buildingType,
    currentLevel: propertyState.level,
    targetLevel,
    currentBuilding: buildingLabel(map, propertyState.level),
    targetBuilding: buildingLabel(map, targetLevel),
    available,
    allowed: available > 0,
  }
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
    propertyState.mortgaged = false
    events.push({
      type: "property_purchased",
      playerId: player.userId,
      tileId: tile.id,
      amount: tile.price,
    })
    return
  }

  ruleError("INVALID_DECISION", "未知的地产选择。")
}
