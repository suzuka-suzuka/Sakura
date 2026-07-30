import {
  PHASES,
  PLAYER_STATUS,
  GameRuleError,
  ruleError,
} from "../constants.js"

export function cloneState(state) {
  return structuredClone(state)
}

export function playerById(state, userId) {
  const wanted = String(userId)
  return state.players.find((player) => player.userId === wanted) || null
}

export function requirePlayer(state, userId) {
  const player = playerById(state, userId)
  if (!player) ruleError("NOT_PLAYER", "你不在这局大富翁中。")
  return player
}

export function activePlayers(state) {
  return state.players.filter(
    (player) => player.status === PLAYER_STATUS.ACTIVE
  )
}

export function isActivePlayer(player) {
  return player?.status === PLAYER_STATUS.ACTIVE
}

export function currentPlayer(state) {
  if (!Number.isInteger(state.turnIndex) || state.turnIndex < 0) return null
  return state.players[state.turnIndex] || null
}

export function requireCurrentPlayer(state, userId) {
  const player = requirePlayer(state, userId)
  const current = currentPlayer(state)
  if (!current || current.userId !== player.userId) {
    ruleError("NOT_CURRENT_PLAYER", "现在还没有轮到你。")
  }
  if (!isActivePlayer(player)) {
    ruleError("PLAYER_INACTIVE", "你已经退出本局，不能继续操作。")
  }
  return player
}

export function tileById(map, tileId) {
  return map.tiles.find((tile) => tile.id === Number(tileId)) || null
}

export function deckById(map, deckId) {
  return map.chanceDecks.find((deck) => deck.id === deckId) || null
}

export function propertyTiles(map) {
  return map.tiles.filter((tile) => tile.type === "property")
}

export function ownedPropertyEntries(state, map, userId) {
  const wanted = String(userId)
  return propertyTiles(map)
    .map((tile) => ({
      tile,
      propertyState: state.propertyStates[String(tile.id)],
    }))
    .filter(({ propertyState }) => propertyState?.ownerId === wanted)
}

export function assertStateInvariants(state, map) {
  if (!state || typeof state !== "object") {
    throw new GameRuleError("INVALID_STATE", "大富翁会话不是对象。")
  }
  const userIds = state.players.map((player) => player.userId)
  if (new Set(userIds).size !== userIds.length) {
    throw new GameRuleError("INVALID_STATE", "大富翁玩家 ID 重复。")
  }
  const validTileIds = new Set(map.board.path)
  const validStatuses = new Set(Object.values(PLAYER_STATUS))
  for (const player of state.players) {
    if (typeof player.userId !== "string" || !player.userId) {
      throw new GameRuleError("INVALID_STATE", "大富翁玩家缺少 userId。")
    }
    if (!Number.isSafeInteger(player.cash) || player.cash < 0) {
      throw new GameRuleError(
        "INVALID_STATE",
        `玩家 ${player.userId} 的现金不是非负整数。`
      )
    }
    if (!validTileIds.has(player.position)) {
      throw new GameRuleError(
        "INVALID_STATE",
        `玩家 ${player.userId} 所在格无效。`
      )
    }
    if (!validStatuses.has(player.status)) {
      throw new GameRuleError(
        "INVALID_STATE",
        `玩家 ${player.userId} 状态无效。`
      )
    }
    if (!Number.isSafeInteger(player.jailTurns) || player.jailTurns < 0) {
      throw new GameRuleError(
        "INVALID_STATE",
        `玩家 ${player.userId} 的看守所回合无效。`
      )
    }
    if (
      !Number.isSafeInteger(player.consecutiveRollTimeouts) ||
      player.consecutiveRollTimeouts < 0
    ) {
      throw new GameRuleError(
        "INVALID_STATE",
        `玩家 ${player.userId} 的超时计数无效。`
      )
    }
  }

  const validOwners = new Set(userIds)
  for (const tile of propertyTiles(map)) {
    const propertyState = state.propertyStates?.[String(tile.id)]
    if (!propertyState) {
      throw new GameRuleError(
        "INVALID_STATE",
        `地产 ${tile.id} 缺少运行时状态。`
      )
    }
    if (
      propertyState.ownerId !== null &&
      !validOwners.has(propertyState.ownerId)
    ) {
      throw new GameRuleError(
        "INVALID_STATE",
        `地产 ${tile.id} 的所有者不存在。`
      )
    }
    if (
      !Number.isSafeInteger(propertyState.level) ||
      propertyState.level < 0 ||
      propertyState.level > map.gameDefaults.maxPropertyLevel
    ) {
      throw new GameRuleError(
        "INVALID_STATE",
        `地产 ${tile.id} 的等级无效。`
      )
    }
    if (propertyState.ownerId === null && propertyState.level !== 0) {
      throw new GameRuleError(
        "INVALID_STATE",
        `无主地产 ${tile.id} 不能保留等级。`
      )
    }
  }

  if (state.phase === PHASES.LOBBY) {
    if (state.turnIndex !== -1 || state.round !== 0) {
      throw new GameRuleError("INVALID_STATE", "等待房间不应存在进行中的轮次。")
    }
  } else if (state.phase !== PHASES.ENDED) {
    if (
      !Number.isInteger(state.turnIndex) ||
      state.turnIndex < 0 ||
      state.turnIndex >= state.players.length
    ) {
      throw new GameRuleError("INVALID_STATE", "当前玩家下标无效。")
    }
    if (!isActivePlayer(currentPlayer(state))) {
      throw new GameRuleError("INVALID_STATE", "当前行动者已经不在场。")
    }
    if (!Number.isInteger(state.round) || state.round < 1) {
      throw new GameRuleError("INVALID_STATE", "当前轮次无效。")
    }
  }

  const pendingPhase =
    state.phase === PHASES.AWAITING_PURCHASE ||
    state.phase === PHASES.AWAITING_UPGRADE
  if (pendingPhase !== Boolean(state.pendingDecision)) {
    throw new GameRuleError("INVALID_STATE", "选择状态与待处理选择不一致。")
  }

  return state
}
