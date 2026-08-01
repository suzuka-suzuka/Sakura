import { PLAYER_STATUS, ruleError } from "../constants.js"
import { buildingCountsForLevel } from "./buildings.js"
import { grantItem } from "./items.js"
import {
  moveBy,
  moveTo,
  nearestTileOfKind,
  sendToJail,
} from "./movement.js"
import {
  grantCash,
  processPaymentQueue,
} from "./settlement.js"
import {
  activePlayers,
  deckById,
  ownedPropertyEntries,
  playerById,
} from "./state.js"

function buildingCountsFor(state, map, playerId) {
  return ownedPropertyEntries(state, map, playerId).reduce(
    (total, { propertyState }) => {
      const counts = buildingCountsForLevel(map, propertyState.level)
      total.houses += counts.houses
      total.hotels += counts.hotels
      return total
    },
    { houses: 0, hotels: 0 }
  )
}

// 一张牌可以放多份，所以牌序按「多重集」比对，而不是去重后比对
export function deckCardCounts(deck) {
  const counts = new Map()
  for (const card of deck.cards) {
    counts.set(card.id, (counts.get(card.id) || 0) + (card.count ?? 1))
  }
  return counts
}

export function deckSize(deck) {
  let total = 0
  for (const count of deckCardCounts(deck).values()) total += count
  return total
}

export function validateDeckOrder(deck, order) {
  if (!Array.isArray(order)) return false
  const expected = deckCardCounts(deck)
  if (order.length !== deckSize(deck)) return false
  const seen = new Map()
  for (const cardId of order) {
    if (!expected.has(cardId)) return false
    seen.set(cardId, (seen.get(cardId) || 0) + 1)
  }
  for (const [cardId, count] of expected) {
    if (seen.get(cardId) !== count) return false
  }
  return true
}

function cardById(deck, cardId) {
  return deck.cards.find((card) => card.id === cardId) || null
}

function prepareDeck(state, map, deckId, runtime, events) {
  const deck = deckById(map, deckId)
  if (!deck) ruleError("INVALID_DECK", `牌堆 ${deckId} 不存在。`)

  const deckState = state.decks?.[deckId]
  if (!deckState) {
    ruleError("INVALID_DECK_STATE", "当前牌堆状态与地图不一致。")
  }

  if (deckState.cursor >= deckState.order.length) {
    const nextOrder = runtime.chanceOrder?.[deckId]
    if (!validateDeckOrder(deck, nextOrder)) {
      ruleError("INVALID_RANDOM_INPUT", "牌堆重新洗牌结果无效。")
    }
    deckState.order = [...nextOrder]
    deckState.cursor = 0
    events.push({ type: "chance_reshuffled", deckId })
  }
  return deck
}

export function drawChanceCard(state, map, deckId, runtime, events) {
  const deck = prepareDeck(state, map, deckId, runtime, events)
  const deckState = state.decks[deckId]
  const cardId = deckState.order[deckState.cursor]
  const card = cardById(deck, cardId)
  if (!card) ruleError("INVALID_DECK_STATE", `卡牌 ${cardId} 不存在。`)
  deckState.cursor += 1
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
      processPaymentQueue(
        state,
        map,
        [
          {
            payerId: player.userId,
            amount: -effect.amount,
            reason: "chance",
            cardId: card.id,
          },
        ],
        events,
        { now: runtime.now }
      )
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

  if (effect.type === "move_to_nearest") {
    const target = nearestTileOfKind(
      map,
      player.position,
      effect.propertyKind
    )
    if (!target) {
      ruleError("INVALID_CHANCE_TARGET", "地图上找不到对应的目标地产。")
    }
    moveTo(state, map, player.userId, target.id, {
      collectStartReward: effect.collectStartReward,
      events,
      reason: "chance",
    })
    if (effect.resolveDestination && player.status === PLAYER_STATUS.ACTIVE) {
      resolveDestination(depth + 1, {
        rentMultiplier: effect.rentMultiplier,
      })
    }
    return
  }

  if (effect.type === "repairs") {
    const counts = buildingCountsFor(state, map, player.userId)
    const amount =
      counts.houses * effect.perHouse + counts.hotels * effect.perHotel
    events.push({
      type: "repairs_assessed",
      playerId: player.userId,
      cardId: card.id,
      houses: counts.houses,
      hotels: counts.hotels,
      amount,
    })
    if (amount <= 0) return
    processPaymentQueue(
      state,
      map,
      [
        {
          payerId: player.userId,
          amount,
          reason: "repairs",
          cardId: card.id,
        },
      ],
      events,
      { now: runtime.now }
    )
    return
  }

  if (effect.type === "grant_item") {
    grantItem(state, map, player.userId, effect.itemId, events, {
      cardId: card.id,
    })
    return
  }

  if (effect.type === "send_to_jail") {
    sendToJail(
      state,
      map,
      player.userId,
      effect.targetTileId,
      map.gameDefaults.jailMaxTurns,
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
      processPaymentQueue(
        state,
        map,
        others.map((other) => ({
          payerId: other.userId,
          recipientId: player.userId,
          amount: effect.amount,
          reason: "chance_transfer",
          cardId: card.id,
        })),
        events,
        { now: runtime.now }
      )
      return
    }

    processPaymentQueue(
      state,
      map,
      others.map((other) => ({
        payerId: player.userId,
        recipientId: other.userId,
        amount: effect.amount,
        reason: "chance_transfer",
        cardId: card.id,
      })),
      events,
      { now: runtime.now }
    )
    return
  }

  ruleError("UNSUPPORTED_CHANCE", `不支持的机会牌效果 ${effect.type}。`)
}
