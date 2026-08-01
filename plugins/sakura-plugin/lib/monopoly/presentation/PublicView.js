import {
  PHASE_LABELS,
  PHASES,
  PLAYER_STATUS,
  playerPublicLabel,
} from "../constants.js"
import {
  liquidationValue,
} from "../rules/settlement.js"
import {
  buildingCountsForLevel,
  buildingLabel,
} from "../rules/buildings.js"
import {
  heldItems,
  itemSummary,
} from "../rules/items.js"
import { rentFor } from "../rules/property.js"
import {
  currentPlayer,
  ownedPropertyEntries,
  tileById,
} from "../rules/state.js"

export function buildPublicView(state, map) {
  const players = state.players.map((player, index) => {
    const owned = ownedPropertyEntries(state, map, player.userId)
    const ranking = state.rankings?.find(
      (entry) => entry.userId === player.userId
    )
    const propertyValue = owned.reduce(
      (sum, { tile, propertyState }) =>
        sum + liquidationValue(map, tile, propertyState),
      0
    )
    const buildings = owned.reduce(
      (total, { propertyState }) => {
        const counts = buildingCountsForLevel(
          map,
          propertyState.level
        )
        total.houses += counts.houses
        total.hotels += counts.hotels
        return total
      },
      { houses: 0, hotels: 0 }
    )
    return {
      userId: player.userId,
      label: playerPublicLabel(player, index),
      color: player.color || "#78909C",
      cash: player.cash,
      position: player.position,
      tileName: tileById(map, player.position)?.name || `格子 ${player.position}`,
      jailTurns: player.jailTurns,
      consecutiveRollTimeouts: player.consecutiveRollTimeouts,
      consecutiveDoubles: player.consecutiveDoubles,
      status: player.status,
      active: player.status === PLAYER_STATUS.ACTIVE,
      rank: ranking?.rank ?? null,
      propertyCount: owned.length,
      mortgagedCount: owned.filter(
        ({ propertyState }) => propertyState.mortgaged
      ).length,
      houseCount: buildings.houses,
      hotelCount: buildings.hotels,
      items: itemSummary(player),
      itemCount: heldItems(player).length,
      propertyValue,
      netWorth: player.cash + propertyValue,
    }
  })

  const propertyStates = Object.fromEntries(
    map.tiles
      .filter((tile) => tile.type === "property")
      .map((tile) => {
        const stateEntry = state.propertyStates[String(tile.id)]
        return [
          String(tile.id),
          {
            ownerId: stateEntry.ownerId,
            level: stateEntry.level,
            mortgaged: stateEntry.mortgaged,
            propertyKind: tile.propertyKind || "street",
            building: buildingLabel(map, stateEntry.level),
            ...buildingCountsForLevel(map, stateEntry.level),
            rent:
              stateEntry.ownerId === null || stateEntry.mortgaged
                ? null
                : rentFor(state, map, tile),
            ownerColor:
              players.find((player) => player.userId === stateEntry.ownerId)
                ?.color || null,
          },
        ]
      })
  )

  const active = state.phase === PHASES.ENDED ? null : currentPlayer(state)
  return {
    sessionId: state.sessionId,
    mapId: state.mapId,
    mapVersion: state.mapVersion,
    mapName: map.name,
    phase: state.phase,
    phaseLabel: PHASE_LABELS[state.phase] || state.phase,
    hostUserId: state.hostUserId,
    turnSeq: state.turnSeq,
    currentPlayerId: active?.userId || null,
    deadlineAt: state.deadlineAt,
    lastDice: state.lastDice ? structuredClone(state.lastDice) : null,
    lastMove: state.lastMove ? { ...state.lastMove } : null,
    pendingDecision: state.pendingDecision
      ? { ...state.pendingDecision }
      : null,
    pendingDebt: state.pendingDebt
      ? structuredClone(state.pendingDebt)
      : null,
    pendingAction: state.pendingAction
      ? structuredClone(state.pendingAction)
      : null,
    players,
    propertyStates,
    buildingSupply: { ...state.buildingSupply },
    rankings: Array.isArray(state.rankings)
      ? structuredClone(state.rankings)
      : [],
    winnerIds: Array.isArray(state.winnerIds) ? [...state.winnerIds] : [],
    endReason: state.endReason,
  }
}
