import { ruleError } from "../constants.js"
import { playerById } from "./state.js"

export function itemById(map, itemId) {
  return map.items?.find((item) => item.id === String(itemId)) || null
}

export function itemName(map, itemId) {
  return itemById(map, itemId)?.name || String(itemId)
}

export function heldItems(player) {
  return Array.isArray(player?.items) ? player.items : []
}

export function heldCount(player, itemId) {
  return heldItems(player).filter((entry) => entry.itemId === itemId).length
}

export function hasItem(player, itemId) {
  return heldCount(player, itemId) > 0
}

// 背包按道具种类汇总，渲染和净资产口径都用这个
export function itemSummary(player) {
  const summary = {}
  for (const entry of heldItems(player)) {
    summary[entry.itemId] = (summary[entry.itemId] || 0) + 1
  }
  return summary
}

export function grantItem(
  state,
  map,
  playerId,
  itemId,
  events,
  { cardId = null } = {}
) {
  const player = playerById(state, playerId)
  const definition = itemById(map, itemId)
  if (!player || !definition) {
    ruleError("INVALID_ITEM", `道具 ${itemId} 不存在。`)
  }
  if (!Array.isArray(player.items)) player.items = []
  if (heldCount(player, itemId) >= definition.maxHeld) {
    // 到上限就作废这次发放，不排队也不折现
    events.push({
      type: "item_capped",
      playerId: player.userId,
      itemId,
      cardId,
      maxHeld: definition.maxHeld,
    })
    return false
  }
  player.items.push({ itemId: definition.id, cardId })
  events.push({
    type: "item_granted",
    playerId: player.userId,
    itemId: definition.id,
    cardId,
  })
  return true
}

export function consumeItem(
  state,
  map,
  playerId,
  itemId,
  events,
  { reason = null } = {}
) {
  const player = playerById(state, playerId)
  const index = heldItems(player).findIndex(
    (entry) => entry.itemId === String(itemId)
  )
  if (index < 0) return false
  player.items.splice(index, 1)
  events.push({
    type: "item_used",
    playerId: player.userId,
    itemId: String(itemId),
    reason,
  })
  return true
}

// 破产和认输都把背包清空，道具不随地产转给债主
export function dropAllItems(state, playerId, events, reason) {
  const player = playerById(state, playerId)
  const count = heldItems(player).length
  if (count === 0) return 0
  player.items = []
  events.push({
    type: "items_dropped",
    playerId: player.userId,
    count,
    reason,
  })
  return count
}
