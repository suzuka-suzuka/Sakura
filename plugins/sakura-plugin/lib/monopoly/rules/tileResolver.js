import { PHASES, PLAYER_STATUS } from "../constants.js"
import { applyChanceCard, drawChanceCard } from "./chance.js"
import { returnBuildingsToBank } from "./buildings.js"
import { sendToJail } from "./movement.js"
import {
  createPropertyDecision,
  rentFor,
} from "./property.js"
import {
  grantCash,
  processPaymentQueue,
} from "./settlement.js"
import {
  playerById,
  tileById,
} from "./state.js"

export function resolveCurrentTile(
  state,
  map,
  playerId,
  runtime,
  events,
  depth = 0,
  { rentMultiplier = 1 } = {}
) {
  const player = playerById(state, playerId)
  if (!player || player.status !== PLAYER_STATUS.ACTIVE) return

  if (depth >= map.gameDefaults.maxTileResolutionDepth) {
    events.push({
      type: "resolution_limit_reached",
      playerId: player.userId,
      tileId: player.position,
      depth,
    })
    return
  }

  const tile = tileById(map, player.position)
  if (!tile) return

  if (tile.type === "property") {
    const propertyState = state.propertyStates[String(tile.id)]
    if (propertyState.ownerId === null || propertyState.ownerId === player.userId) {
      createPropertyDecision(
        state,
        map,
        player.userId,
        tile,
        runtime.now,
        events
      )
      return
    }

    const owner = playerById(state, propertyState.ownerId)
    if (!owner || owner.status !== PLAYER_STATUS.ACTIVE) {
      const previousLevel = propertyState.level
      const returnedBuildings = returnBuildingsToBank(
        state,
        map,
        previousLevel
      )
      propertyState.ownerId = null
      propertyState.level = 0
      propertyState.mortgaged = false
      events.push({
        type: "property_returned",
        playerId: owner?.userId || null,
        tileId: tile.id,
        previousLevel,
        returnedBuildings,
        reason: "invalid_owner",
      })
      createPropertyDecision(
        state,
        map,
        player.userId,
        tile,
        runtime.now,
        events
      )
      return
    }

    if (propertyState.mortgaged) {
      events.push({
        type: "mortgaged_property_visited",
        playerId: player.userId,
        ownerId: owner.userId,
        tileId: tile.id,
      })
      return
    }
    processPaymentQueue(
      state,
      map,
      [
        {
          payerId: player.userId,
          recipientId: owner.userId,
          // 机会牌指定前往时会带倍率（例如末班列车付双倍）
          amount: rentFor(state, map, tile) * rentMultiplier,
          reason: "rent",
          tileId: tile.id,
        },
      ],
      events,
      { now: runtime.now }
    )
    return
  }

  if (tile.type === "chance") {
    const card = drawChanceCard(state, map, tile.deckId, runtime, events)
    applyChanceCard(state, map, player.userId, card, runtime, events, {
      depth,
      resolveDestination: (nextDepth, options) =>
        resolveCurrentTile(
          state,
          map,
          player.userId,
          runtime,
          events,
          nextDepth,
          options
        ),
    })
    return
  }

  if (tile.type === "tax") {
    processPaymentQueue(
      state,
      map,
      [
        {
          payerId: player.userId,
          amount: tile.amount,
          reason: "tax",
          tileId: tile.id,
        },
      ],
      events,
      { now: runtime.now }
    )
    return
  }

  if (tile.type === "bonus") {
    grantCash(state, player.userId, tile.amount, events, "bonus", {
      tileId: tile.id,
    })
    return
  }

  if (tile.type === "go_to_jail") {
    sendToJail(
      state,
      map,
      player.userId,
      tile.targetTileId,
      map.gameDefaults.jailMaxTurns,
      events,
      "tile"
    )
    return
  }

  if (
    tile.type === "start" ||
    tile.type === "jail" ||
    tile.type === "rest"
  ) {
    events.push({
      type: "tile_no_effect",
      playerId: player.userId,
      tileId: tile.id,
      tileType: tile.type,
    })
  }

  if (state.phase === PHASES.RESOLVING) state.deadlineAt = 0
}
