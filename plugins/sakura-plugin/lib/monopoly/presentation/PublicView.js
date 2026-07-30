import {
  PHASE_LABELS,
  PHASES,
  PLAYER_STATUS,
} from "../constants.js"
import {
  liquidationValue,
} from "../rules/settlement.js"
import {
  currentPlayer,
  ownedPropertyEntries,
  tileById,
} from "../rules/state.js"

export function buildPublicView(state, map) {
  const players = state.players.map((player) => {
    const owned = ownedPropertyEntries(state, map, player.userId)
    const propertyValue = owned.reduce(
      (sum, { tile, propertyState }) =>
        sum + liquidationValue(map, tile, propertyState),
      0
    )
    return {
      userId: player.userId,
      displayName: player.displayName,
      color: player.color || "#78909C",
      cash: player.cash,
      position: player.position,
      tileName: tileById(map, player.position)?.name || `格子 ${player.position}`,
      jailTurns: player.jailTurns,
      consecutiveRollTimeouts: player.consecutiveRollTimeouts,
      status: player.status,
      active: player.status === PLAYER_STATUS.ACTIVE,
      propertyCount: owned.length,
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
    round: state.round,
    roundLimit: state.roundLimit,
    turnSeq: state.turnSeq,
    currentPlayerId: active?.userId || null,
    deadlineAt: state.deadlineAt,
    lastDice: state.lastDice ? { ...state.lastDice } : null,
    pendingDecision: state.pendingDecision
      ? { ...state.pendingDecision }
      : null,
    players,
    propertyStates,
    rankings: Array.isArray(state.rankings)
      ? structuredClone(state.rankings)
      : [],
    winnerIds: Array.isArray(state.winnerIds) ? [...state.winnerIds] : [],
    endReason: state.endReason,
  }
}
