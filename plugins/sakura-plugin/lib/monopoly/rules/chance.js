import { PLAYER_STATUS, ruleError } from "../constants.js"
import { moveBy, moveTo, sendToJail } from "./movement.js"
import { grantCash, settlePayment } from "./settlement.js"
import {
  activePlayers,
  deckById,
  playerById,
} from "./state.js"

export function validateDeckOrder(deck, order) {
  if (!Array.isArray(order) || order.length !== deck.cards.length) return false
  const expected = new Set(deck.cards.map((card) => card.id))
  return new Set(order).size === order.length && order.every((id) => expected.has(id))
}

function cardById(deck, cardId) {
  return deck.cards.find((card) => card.id === cardId) || null
}

function prepareDeck(state, map, deckId, runtime, events) {
  const deck = deckById(map, deckId)
  if (!deck) ruleError("INVALID_DECK", `机会牌堆 ${deckId} 不存在。`)

  if (!state.chance || state.chance.deckId !== deckId) {
    ruleError("INVALID_DECK_STATE", "当前机会牌堆状态与地图不一致。")
  }

  if (state.chance.cursor >= state.chance.order.length) {
    const nextOrder = runtime.chanceOrder
    if (!validateDeckOrder(deck, nextOrder)) {
      ruleError("INVALID_RANDOM_INPUT", "机会牌重新洗牌结果无效。")
    }
    state.chance.order = [...nextOrder]
    state.chance.cursor = 0
    events.push({ type: "chance_reshuffled", deckId })
  }
  return deck
}

export function drawChanceCard(state, map, deckId, runtime, events) {
  const deck = prepareDeck(state, map, deckId, runtime, events)
  const cardId = state.chance.order[state.chance.cursor]
  const card = cardById(deck, cardId)
  if (!card) ruleError("INVALID_DECK_STATE", `机会牌 ${cardId} 不存在。`)
  state.chance.cursor += 1
  events.push({
    type: "chance_drawn",
    deckId,
    cardId: card.id,
  })
  return card
}

export function applyChanceCard(
  state,
  map,
  playerId,
  card,
  runtime,
  events,
  { depth, resolveDestination }
) {
  const player = playerById(state, playerId)
  if (!player || player.status !== PLAYER_STATUS.ACTIVE) return
  const effect = card.effect

  if (effect.type === "cash") {
    if (effect.amount > 0) {
      grantCash(state, player.userId, effect.amount, events, "chance", {
        cardId: card.id,
      })
    } else {
      settlePayment(state, map, {
        payerId: player.userId,
        amount: -effect.amount,
        reason: "chance",
        cardId: card.id,
        events,
      })
    }
    return
  }

  if (effect.type === "move_by") {
    moveBy(state, map, player.userId, effect.steps, {
      collectStartReward: effect.collectStartReward,
      events,
      reason: "chance",
    })
    if (effect.resolveDestination && player.status === PLAYER_STATUS.ACTIVE) {
      resolveDestination(depth + 1)
    }
    return
  }

  if (effect.type === "move_to") {
    moveTo(state, map, player.userId, effect.targetTileId, {
      collectStartReward: effect.collectStartReward,
      events,
      reason: "chance",
    })
    if (effect.resolveDestination && player.status === PLAYER_STATUS.ACTIVE) {
      resolveDestination(depth + 1)
    }
    return
  }

  if (effect.type === "send_to_jail") {
    sendToJail(
      state,
      map,
      player.userId,
      effect.targetTileId,
      map.gameDefaults.jailSkipTurns,
      events,
      "chance"
    )
    return
  }

  if (effect.type === "transfer_each") {
    const others = activePlayers(state).filter(
      (other) => other.userId !== player.userId
    )
    if (effect.direction === "from_others") {
      for (const other of others) {
        if (other.status !== PLAYER_STATUS.ACTIVE) continue
        settlePayment(state, map, {
          payerId: other.userId,
          recipientId: player.userId,
          amount: effect.amount,
          reason: "chance_transfer",
          cardId: card.id,
          events,
        })
      }
      return
    }

    for (const other of others) {
      if (player.status !== PLAYER_STATUS.ACTIVE) break
      settlePayment(state, map, {
        payerId: player.userId,
        recipientId: other.userId,
        amount: effect.amount,
        reason: "chance_transfer",
        cardId: card.id,
        events,
      })
    }
    return
  }

  ruleError("UNSUPPORTED_CHANCE", `不支持的机会牌效果 ${effect.type}。`)
}
