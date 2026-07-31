import { ruleError } from "../constants.js"
import {
  buildingLabel,
  hotelLevel,
  housesPerHotel,
} from "./buildings.js"
import {
  createBuildingPlan,
  ownsCompleteGroup,
  propertyKind,
} from "./property.js"
import { playerById, tileById } from "./state.js"

function requireOwnedProperty(state, map, playerId, tileId) {
  const player = playerById(state, playerId)
  const tile = tileById(map, tileId)
  const propertyState = state.propertyStates[String(tileId)]
  if (!player || !tile || tile.type !== "property" || !propertyState) {
    ruleError("INVALID_PROPERTY", "目标地产不存在。")
  }
  if (propertyState.ownerId !== player.userId) {
    ruleError("NOT_PROPERTY_OWNER", "这块地产不属于你。")
  }
  return { player, tile, propertyState }
}

function groupFor(map, tile) {
  return map.propertyGroups.find((group) => group.id === tile.groupId) || null
}

function groupStates(state, map, tile) {
  const group = groupFor(map, tile)
  if (!group) ruleError("INVALID_PROPERTY_GROUP", "地产所属分组不存在。")
  return {
    group,
    states: group.tileIds.map(
      (tileId) => state.propertyStates[String(tileId)]
    ),
  }
}

export function buildOnProperty(state, map, playerId, tileId, events) {
  const { player, tile, propertyState } = requireOwnedProperty(
    state,
    map,
    playerId,
    tileId
  )
  if (propertyKind(tile) !== "street") {
    ruleError("BUILDING_NOT_ALLOWED", "车站和公共设施不能建造。")
  }
  if (!ownsCompleteGroup(state, map, player.userId, tile.groupId)) {
    ruleError("BUILDING_NOT_ALLOWED", "必须先完整持有这个同色组。")
  }
  const { states } = groupStates(state, map, tile)
  if (states.some((entry) => entry.mortgaged)) {
    ruleError("GROUP_MORTGAGED", "同色组存在抵押地产，不能建造。")
  }
  const minimumLevel = Math.min(...states.map((entry) => entry.level))
  if (propertyState.level !== minimumLevel) {
    ruleError("UNEVEN_BUILDING", "必须先在组内建筑等级最低的地产上建造。")
  }

  const plan = createBuildingPlan(state, map, player.userId, tile)
  if (!plan) {
    ruleError("BUILDING_NOT_ALLOWED", "这块地产目前不能继续建造。")
  }
  if (!plan.allowed) {
    const name = plan.buildingType === "hotel" ? "旅馆" : "房屋"
    ruleError("BUILDING_SUPPLY_EXHAUSTED", `银行已经没有可用${name}。`)
  }
  if (player.cash < tile.upgradeCost) {
    ruleError("INSUFFICIENT_CASH", "你的现金不足以建造。")
  }

  player.cash -= tile.upgradeCost
  if (plan.buildingType === "hotel") {
    state.buildingSupply.hotels -= 1
    state.buildingSupply.houses += housesPerHotel(map)
  } else {
    state.buildingSupply.houses -= 1
  }
  propertyState.level = plan.targetLevel
  events.push({
    type: "property_upgraded",
    playerId: player.userId,
    tileId: tile.id,
    amount: tile.upgradeCost,
    level: propertyState.level,
    buildingType: plan.buildingType,
    building: plan.targetBuilding,
    buildingSupply: { ...state.buildingSupply },
  })
}

export function sellBuilding(state, map, playerId, tileId, events) {
  const { player, tile, propertyState } = requireOwnedProperty(
    state,
    map,
    playerId,
    tileId
  )
  if (propertyKind(tile) !== "street" || propertyState.level <= 0) {
    ruleError("NO_BUILDING", "这块地产没有可出售的建筑。")
  }
  const { states } = groupStates(state, map, tile)
  const maximumLevel = Math.max(...states.map((entry) => entry.level))
  if (propertyState.level !== maximumLevel) {
    ruleError("UNEVEN_SELLING", "必须先从组内建筑等级最高的地产拆除。")
  }

  const previousLevel = propertyState.level
  const previousBuilding = buildingLabel(map, previousLevel)
  if (previousLevel === hotelLevel(map)) {
    const requiredHouses = housesPerHotel(map)
    if (state.buildingSupply.houses < requiredHouses) {
      ruleError(
        "HOUSE_SUPPLY_EXHAUSTED",
        `银行不足 ${requiredHouses} 间房，暂时不能把旅馆降级。`
      )
    }
    state.buildingSupply.hotels += 1
    state.buildingSupply.houses -= requiredHouses
  } else {
    state.buildingSupply.houses += 1
  }

  propertyState.level -= 1
  const amount = Math.floor(
    tile.upgradeCost * map.gameDefaults.buildingSaleRate
  )
  player.cash += amount
  events.push({
    type: "building_sold",
    playerId: player.userId,
    tileId: tile.id,
    amount,
    previousLevel,
    level: propertyState.level,
    previousBuilding,
    building: buildingLabel(map, propertyState.level),
    buildingSupply: { ...state.buildingSupply },
  })
}

export function mortgageProperty(state, map, playerId, tileId, events) {
  const { player, tile, propertyState } = requireOwnedProperty(
    state,
    map,
    playerId,
    tileId
  )
  if (propertyState.mortgaged) {
    ruleError("ALREADY_MORTGAGED", "这块地产已经抵押。")
  }
  if (propertyKind(tile) === "street") {
    const { states } = groupStates(state, map, tile)
    if (states.some((entry) => entry.level > 0)) {
      ruleError("GROUP_HAS_BUILDINGS", "必须先卖掉整个同色组的建筑。")
    }
  }
  propertyState.mortgaged = true
  player.cash += tile.mortgageValue
  events.push({
    type: "property_mortgaged",
    playerId: player.userId,
    tileId: tile.id,
    amount: tile.mortgageValue,
  })
}

export function redemptionCost(map, tile) {
  return (
    tile.mortgageValue +
    Math.ceil(
      tile.mortgageValue * map.gameDefaults.mortgageInterestRate
    )
  )
}

export function redeemProperty(state, map, playerId, tileId, events) {
  const { player, tile, propertyState } = requireOwnedProperty(
    state,
    map,
    playerId,
    tileId
  )
  if (!propertyState.mortgaged) {
    ruleError("NOT_MORTGAGED", "这块地产没有抵押。")
  }
  const amount = redemptionCost(map, tile)
  if (player.cash < amount) {
    ruleError("INSUFFICIENT_CASH", `赎回这块地产需要 ${amount}。`)
  }
  player.cash -= amount
  propertyState.mortgaged = false
  events.push({
    type: "property_redeemed",
    playerId: player.userId,
    tileId: tile.id,
    amount,
    interest: amount - tile.mortgageValue,
  })
}
