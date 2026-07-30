import { PLAYER_STATUS, ruleError } from "../constants.js"
import {
  ownedPropertyEntries,
  playerById,
} from "./state.js"

export function liquidationValue(map, tile, propertyState) {
  const raw =
    (tile.price + tile.upgradeCost * propertyState.level) *
    map.gameDefaults.liquidationRate
  const unit = map.gameDefaults.liquidationRoundingUnit
  return Math.floor(raw / unit) * unit
}

export function returnAllPropertiesToBank(
  state,
  map,
  playerId,
  events,
  reason
) {
  for (const { tile, propertyState } of ownedPropertyEntries(
    state,
    map,
    playerId
  )) {
    const previousLevel = propertyState.level
    propertyState.ownerId = null
    propertyState.level = 0
    events.push({
      type: "property_returned",
      playerId: String(playerId),
      tileId: tile.id,
      previousLevel,
      reason,
    })
  }
}

export function surrenderPlayer(
  state,
  map,
  playerId,
  events,
  reason = "surrender"
) {
  const player = playerById(state, playerId)
  if (!player) ruleError("NOT_PLAYER", "认输玩家不存在。")
  if (player.status !== PLAYER_STATUS.ACTIVE) return false

  player.cash = 0
  player.status = PLAYER_STATUS.SURRENDERED
  returnAllPropertiesToBank(state, map, player.userId, events, reason)
  events.push({
    type: "player_surrendered",
    playerId: player.userId,
    reason,
  })
  return true
}

function markBankrupt(state, map, player, events, reason) {
  player.cash = 0
  player.status = PLAYER_STATUS.BANKRUPT
  returnAllPropertiesToBank(
    state,
    map,
    player.userId,
    events,
    "bankruptcy"
  )
  events.push({
    type: "player_bankrupt",
    playerId: player.userId,
    reason,
  })
}

export function settlePayment(
  state,
  map,
  {
    payerId,
    recipientId = null,
    amount,
    reason,
    tileId = null,
    cardId = null,
    events,
  }
) {
  const payer = playerById(state, payerId)
  if (!payer) ruleError("NOT_PLAYER", "付款玩家不存在。")
  if (payer.status !== PLAYER_STATUS.ACTIVE) {
    return { due: amount, paid: 0, bankrupt: true }
  }
  if (!Number.isSafeInteger(amount) || amount < 0) {
    ruleError("INVALID_PAYMENT", "付款金额必须是非负整数。")
  }

  const recipient =
    recipientId === null ? null : playerById(state, recipientId)
  if (recipientId !== null && !recipient) {
    ruleError("NOT_PLAYER", "收款玩家不存在。")
  }

  const candidates = ownedPropertyEntries(state, map, payer.userId)
    .map((entry) => ({
      ...entry,
      value: liquidationValue(map, entry.tile, entry.propertyState),
    }))
    .sort((left, right) => right.value - left.value || left.tile.id - right.tile.id)

  while (payer.cash < amount && candidates.length > 0) {
    const candidate = candidates.shift()
    const previousLevel = candidate.propertyState.level
    candidate.propertyState.ownerId = null
    candidate.propertyState.level = 0
    payer.cash += candidate.value
    events.push({
      type: "property_liquidated",
      playerId: payer.userId,
      tileId: candidate.tile.id,
      previousLevel,
      amount: candidate.value,
      reason,
    })
  }

  const paid = Math.min(payer.cash, amount)
  payer.cash -= paid
  if (recipient?.status === PLAYER_STATUS.ACTIVE) recipient.cash += paid

  events.push({
    type: "payment",
    payerId: payer.userId,
    recipientId: recipient?.userId || null,
    due: amount,
    paid,
    reason,
    tileId,
    cardId,
  })

  const bankrupt = paid < amount
  if (bankrupt) markBankrupt(state, map, payer, events, reason)
  return { due: amount, paid, bankrupt }
}

export function grantCash(
  state,
  playerId,
  amount,
  events,
  reason,
  { tileId = null, cardId = null } = {}
) {
  const player = playerById(state, playerId)
  if (!player) ruleError("NOT_PLAYER", "收款玩家不存在。")
  if (!Number.isSafeInteger(amount) || amount < 0) {
    ruleError("INVALID_PAYMENT", "增加现金必须是非负整数。")
  }
  if (player.status !== PLAYER_STATUS.ACTIVE || amount === 0) return 0
  player.cash += amount
  events.push({
    type: "cash_granted",
    playerId: player.userId,
    amount,
    reason,
    tileId,
    cardId,
  })
  return amount
}
