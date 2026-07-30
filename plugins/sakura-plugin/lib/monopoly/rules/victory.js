import { PLAYER_STATUS } from "../constants.js"
import {
  activePlayers,
  ownedPropertyEntries,
} from "./state.js"
import { liquidationValue } from "./settlement.js"

export function netWorthOf(state, map, playerId) {
  const player = state.players.find((item) => item.userId === String(playerId))
  if (!player) return 0
  return (
    player.cash +
    ownedPropertyEntries(state, map, player.userId).reduce(
      (sum, { tile, propertyState }) =>
        sum + liquidationValue(map, tile, propertyState),
      0
    )
  )
}

function primaryKey(entry) {
  return `${entry.statusOrder}:${entry.netWorth}:${entry.cash}:${entry.propertyCount}`
}

function statusOrder(status) {
  if (status === PLAYER_STATUS.ACTIVE) return 0
  if (status === PLAYER_STATUS.BANKRUPT) return 1
  return 2
}

function normalizedRolls(runtime, userId) {
  const rolls = runtime?.tieBreakRolls?.[userId]
  if (!Array.isArray(rolls) || rolls.length === 0) return [1]
  return rolls.map((value) =>
    Number.isSafeInteger(value) && value >= 1 && value <= 6 ? value : 1
  )
}

function compareRollSequences(left, right) {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const leftRoll = left[index] ?? 1
    const rightRoll = right[index] ?? 1
    if (leftRoll !== rightRoll) return rightRoll - leftRoll
  }
  return 0
}

export function buildRankings(state, map, runtime = {}) {
  const entries = state.players.map((player) => ({
    userId: player.userId,
    status: player.status,
    cash: player.cash,
    propertyCount: ownedPropertyEntries(state, map, player.userId).length,
    netWorth: netWorthOf(state, map, player.userId),
    statusOrder: statusOrder(player.status),
    tieBreakRolls: normalizedRolls(runtime, player.userId),
  }))

  entries.sort(
    (left, right) =>
      left.statusOrder - right.statusOrder ||
      right.netWorth - left.netWorth ||
      right.cash - left.cash ||
      right.propertyCount - left.propertyCount
  )

  const tieBreaks = []
  for (let start = 0; start < entries.length; ) {
    let end = start + 1
    while (
      end < entries.length &&
      primaryKey(entries[end]) === primaryKey(entries[start])
    ) {
      end += 1
    }
    if (end - start > 1) {
      const tied = entries.slice(start, end)
      tied.sort(
        (left, right) =>
          compareRollSequences(left.tieBreakRolls, right.tieBreakRolls) ||
          left.userId.localeCompare(right.userId)
      )
      entries.splice(start, tied.length, ...tied)
      tieBreaks.push({
        playerIds: tied.map((entry) => entry.userId),
        rolls: Object.fromEntries(
          tied.map((entry) => [entry.userId, entry.tieBreakRolls])
        ),
      })
    }
    start = end
  }

  const rankings = entries.map((entry, index) => ({
    rank: index + 1,
    userId: entry.userId,
    status: entry.status,
    cash: entry.cash,
    propertyCount: entry.propertyCount,
    netWorth: entry.netWorth,
  }))
  return { rankings, tieBreaks }
}

export function soleActivePlayer(state) {
  const active = activePlayers(state)
  return active.length === 1 ? active[0] : null
}

export function hasAtMostOneActivePlayer(state) {
  return activePlayers(state).length <= 1
}
