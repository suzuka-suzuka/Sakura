import {
  ACTIONS,
  DECISIONS,
  END_REASONS,
  PHASES,
  PLAYER_STATUS,
  SESSION_VERSION,
  ruleError,
} from "./constants.js"
import { validateDice } from "./rules/dice.js"
import { moveBy } from "./rules/movement.js"
import {
  resolvePropertyDecision,
} from "./rules/property.js"
import {
  surrenderPlayer,
} from "./rules/settlement.js"
import {
  assertStateInvariants,
  cloneState,
  currentPlayer,
  playerById,
  propertyTiles,
  requireCurrentPlayer,
  requirePlayer,
} from "./rules/state.js"
import { resolveCurrentTile } from "./rules/tileResolver.js"
import {
  buildRankings,
  hasAtMostOneActivePlayer,
  soleActivePlayer,
} from "./rules/victory.js"
import { validateDeckOrder } from "./rules/chance.js"

function asNow(runtime) {
  const now = runtime?.now
  if (!Number.isSafeInteger(now) || now < 0) {
    ruleError("INVALID_TIME", "规则引擎需要有效的当前时间。")
  }
  return now
}

function createPlayer({ userId, displayName, joinOrder }, map) {
  return {
    userId: String(userId),
    displayName: String(displayName || userId).slice(0, 40),
    joinOrder,
    color: null,
    cash: 0,
    position: map.board.startTileId,
    jailTurns: 0,
    consecutiveRollTimeouts: 0,
    status: PLAYER_STATUS.ACTIVE,
  }
}

function createPropertyStates(map) {
  return Object.fromEntries(
    propertyTiles(map).map((tile) => [
      String(tile.id),
      { ownerId: null, level: 0 },
    ])
  )
}

export function createLobbyState(
  {
    sessionId,
    selfId,
    groupId,
    hostUserId,
    hostDisplayName,
  },
  map,
  now
) {
  const state = {
    version: SESSION_VERSION,
    sessionId: String(sessionId),
    selfId: String(selfId),
    groupId: String(groupId),
    mapId: map.id,
    mapVersion: map.version,
    phase: PHASES.LOBBY,
    hostUserId: String(hostUserId),
    turnSeq: 0,
    round: 0,
    roundLimit: 0,
    turnIndex: -1,
    players: [
      createPlayer(
        {
          userId: hostUserId,
          displayName: hostDisplayName,
          joinOrder: 0,
        },
        map
      ),
    ],
    propertyStates: createPropertyStates(map),
    chance: {
      deckId: map.chanceDecks[0].id,
      order: [],
      cursor: 0,
    },
    pendingDecision: null,
    deadlineAt: now + map.gameDefaults.lobbyTimeoutSeconds * 1000,
    lastDice: null,
    winnerIds: [],
    rankings: [],
    endReason: null,
    createdAt: now,
    startedAt: 0,
    endedAt: 0,
    updatedAt: now,
  }
  return assertStateInvariants(state, map)
}

function requirePhase(state, expected, message) {
  const accepted = Array.isArray(expected) ? expected : [expected]
  if (!accepted.includes(state.phase)) {
    ruleError("WRONG_PHASE", message)
  }
}

function addTurnStartedEvent(state, map, events) {
  const player = currentPlayer(state)
  state.phase = PHASES.AWAITING_ROLL
  state.pendingDecision = null
  state.deadlineAt =
    state.updatedAt + map.gameDefaults.rollTimeoutSeconds * 1000
  events.push({
    type: "turn_started",
    playerId: player.userId,
    round: state.round,
    roundLimit: state.roundLimit,
    turnSeq: state.turnSeq,
    deadlineAt: state.deadlineAt,
  })
}

function nextActivePointer(state) {
  const total = state.players.length
  for (let offset = 1; offset <= total; offset++) {
    const rawIndex = state.turnIndex + offset
    const index = rawIndex % total
    if (state.players[index].status === PLAYER_STATUS.ACTIVE) {
      return { index, wrapped: rawIndex >= total }
    }
  }
  return null
}

function endGame(state, map, events, reason, runtime, { forced = false } = {}) {
  const now = asNow(runtime)
  const { rankings, tieBreaks } = buildRankings(state, map, runtime)
  state.phase = PHASES.ENDED
  state.pendingDecision = null
  state.deadlineAt = 0
  state.endReason = reason
  state.endedAt = now
  state.rankings = rankings
  if (forced) {
    state.winnerIds = []
  } else if (reason === END_REASONS.LAST_PLAYER) {
    const winner = soleActivePlayer(state)
    state.winnerIds = winner ? [winner.userId] : []
  } else {
    state.winnerIds = rankings.length ? [rankings[0].userId] : []
  }

  for (const tieBreak of tieBreaks) {
    events.push({ type: "ranking_tie_break", ...tieBreak })
  }
  events.push({
    type: "game_ended",
    reason,
    forced,
    winnerIds: [...state.winnerIds],
    rankings: structuredClone(rankings),
  })
}

function beginPlayableTurn(state, map, events, runtime) {
  const maxSteps = state.players.length + 1
  for (let step = 0; step < maxSteps; step++) {
    const player = currentPlayer(state)
    if (!player || player.status !== PLAYER_STATUS.ACTIVE) {
      ruleError("INVALID_STATE", "无法找到下一名在场玩家。")
    }

    if (player.jailTurns <= 0) {
      addTurnStartedEvent(state, map, events)
      return
    }

    player.jailTurns -= 1
    events.push({
      type: "jail_turn_skipped",
      playerId: player.userId,
      remainingTurns: player.jailTurns,
      round: state.round,
      turnSeq: state.turnSeq,
    })

    const next = nextActivePointer(state)
    if (!next) {
      endGame(state, map, events, END_REASONS.LAST_PLAYER, runtime)
      return
    }
    if (next.wrapped && state.round >= state.roundLimit) {
      endGame(state, map, events, END_REASONS.ROUND_LIMIT, runtime)
      return
    }
    if (next.wrapped) state.round += 1
    state.turnIndex = next.index
    state.turnSeq += 1
  }
  ruleError("INVALID_STATE", "看守所自动跳过流程超过安全上限。")
}

function finishPlayerTurn(state, map, events, runtime) {
  state.pendingDecision = null
  state.deadlineAt = 0
  state.phase = PHASES.RESOLVING

  if (hasAtMostOneActivePlayer(state)) {
    endGame(state, map, events, END_REASONS.LAST_PLAYER, runtime)
    return
  }

  const next = nextActivePointer(state)
  if (!next) {
    endGame(state, map, events, END_REASONS.LAST_PLAYER, runtime)
    return
  }
  if (next.wrapped && state.round >= state.roundLimit) {
    endGame(state, map, events, END_REASONS.ROUND_LIMIT, runtime)
    return
  }
  if (next.wrapped) state.round += 1
  state.turnIndex = next.index
  state.turnSeq += 1
  beginPlayableTurn(state, map, events, runtime)
}

function validateStartRandomness(state, map, runtime) {
  const playerIds = state.players.map((player) => player.userId)
  if (
    !Array.isArray(runtime.playerOrder) ||
    runtime.playerOrder.length !== playerIds.length ||
    new Set(runtime.playerOrder).size !== playerIds.length ||
    !runtime.playerOrder.every((userId) => playerIds.includes(String(userId)))
  ) {
    ruleError("INVALID_RANDOM_INPUT", "玩家行动顺序无效。")
  }
  if (
    !Array.isArray(runtime.playerColors) ||
    runtime.playerColors.length < playerIds.length ||
    new Set(runtime.playerColors.slice(0, playerIds.length)).size !==
      playerIds.length
  ) {
    ruleError("INVALID_RANDOM_INPUT", "玩家棋子颜色无效。")
  }
  const deck = map.chanceDecks[0]
  if (!validateDeckOrder(deck, runtime.chanceOrder)) {
    ruleError("INVALID_RANDOM_INPUT", "开局机会牌顺序无效。")
  }
}

function startGame(state, map, action, runtime, events) {
  requirePhase(state, PHASES.LOBBY, "这局已经开始了。")
  if (
    state.hostUserId !== String(action.userId) &&
    action.privileged !== true
  ) {
    ruleError("NOT_HOST", "只有房主或管理员可以开始游戏。")
  }
  if (state.players.length < map.gameDefaults.minPlayers) {
    ruleError(
      "NOT_ENOUGH_PLAYERS",
      `至少需要 ${map.gameDefaults.minPlayers} 人才能开始。`
    )
  }

  validateStartRandomness(state, map, runtime)
  const byId = new Map(state.players.map((player) => [player.userId, player]))
  state.players = runtime.playerOrder.map((userId, index) => {
    const player = byId.get(String(userId))
    player.color = runtime.playerColors[index]
    player.cash = map.gameDefaults.startingCash
    player.position = map.board.startTileId
    player.jailTurns = 0
    player.consecutiveRollTimeouts = 0
    player.status = PLAYER_STATUS.ACTIVE
    return player
  })
  state.propertyStates = createPropertyStates(map)
  state.chance = {
    deckId: map.chanceDecks[0].id,
    order: [...runtime.chanceOrder],
    cursor: 0,
  }
  state.pendingDecision = null
  state.round = 1
  state.roundLimit = Math.min(
    map.gameDefaults.maxRoundsCap,
    Math.ceil(map.gameDefaults.targetTotalTurns / state.players.length)
  )
  state.turnIndex = 0
  state.turnSeq = 1
  state.startedAt = asNow(runtime)
  state.lastDice = null
  state.winnerIds = []
  state.rankings = []
  state.endReason = null
  events.push({
    type: "game_started",
    playerOrder: state.players.map((player) => player.userId),
    roundLimit: state.roundLimit,
    startingCash: map.gameDefaults.startingCash,
  })
  addTurnStartedEvent(state, map, events)
}

function performRoll(
  state,
  map,
  player,
  dice,
  runtime,
  events,
  { automatic = false } = {}
) {
  validateDice(dice, map.gameDefaults.diceSides)
  state.phase = PHASES.RESOLVING
  state.deadlineAt = 0
  state.pendingDecision = null
  state.lastDice = {
    playerId: player.userId,
    value: dice,
    turnSeq: state.turnSeq,
  }
  events.push({
    type: "dice_rolled",
    playerId: player.userId,
    value: dice,
    automatic,
  })
  moveBy(state, map, player.userId, dice, {
    collectStartReward: true,
    events,
    reason: automatic ? "timeout_roll" : "dice",
  })
  resolveCurrentTile(state, map, player.userId, runtime, events)

  if (hasAtMostOneActivePlayer(state)) {
    endGame(state, map, events, END_REASONS.LAST_PLAYER, runtime)
    return
  }

  if (
    state.phase === PHASES.AWAITING_PURCHASE ||
    state.phase === PHASES.AWAITING_UPGRADE
  ) {
    if (!automatic) return
    const pending = state.pendingDecision
    const offerIndex = events.findLastIndex(
      (event) =>
        (event.type === "purchase_offered" ||
          event.type === "upgrade_offered") &&
        event.playerId === pending?.playerId &&
        event.tileId === pending?.tileId
    )
    if (offerIndex >= 0) events.splice(offerIndex, 1)
    resolvePropertyDecision(
      state,
      map,
      player.userId,
      DECISIONS.DECLINE,
      events,
      { automatic: true }
    )
    state.pendingDecision = null
  }
  finishPlayerTurn(state, map, events, runtime)
}

function joinLobby(state, map, action, events) {
  requirePhase(state, PHASES.LOBBY, "游戏已经开始，不能中途加入。")
  if (playerById(state, action.userId)) {
    ruleError("ALREADY_JOINED", "你已经在这局里了。")
  }
  if (state.players.length >= map.gameDefaults.maxPlayers) {
    ruleError("ROOM_FULL", `房间已满，最多 ${map.gameDefaults.maxPlayers} 人。`)
  }
  const player = createPlayer(
    {
      userId: action.userId,
      displayName: action.displayName,
      joinOrder:
        Math.max(-1, ...state.players.map((item) => item.joinOrder)) + 1,
    },
    map
  )
  state.players.push(player)
  events.push({
    type: "player_joined",
    playerId: player.userId,
    playerCount: state.players.length,
    maxPlayers: map.gameDefaults.maxPlayers,
  })
}

function leaveLobby(state, map, action, runtime, events) {
  requirePhase(state, PHASES.LOBBY, "游戏开始后请使用【#认输】退出。")
  const player = requirePlayer(state, action.userId)
  state.players = state.players.filter((item) => item.userId !== player.userId)
  events.push({
    type: "player_left",
    playerId: player.userId,
    displayName: player.displayName,
    playerCount: state.players.length,
  })

  if (state.players.length === 0) {
    state.phase = PHASES.ENDED
    state.deadlineAt = 0
    state.endReason = END_REASONS.LOBBY_EMPTY
    state.endedAt = asNow(runtime)
    events.push({
      type: "game_ended",
      reason: END_REASONS.LOBBY_EMPTY,
      forced: false,
      winnerIds: [],
      rankings: [],
    })
    return
  }

  if (state.hostUserId === player.userId) {
    state.players.sort((left, right) => left.joinOrder - right.joinOrder)
    state.hostUserId = state.players[0].userId
    events.push({
      type: "host_changed",
      playerId: state.hostUserId,
    })
  }
}

function decide(state, map, action, runtime, events, automatic = false) {
  requirePhase(
    state,
    [PHASES.AWAITING_PURCHASE, PHASES.AWAITING_UPGRADE],
    "当前没有等待购买或升级。"
  )
  const player = requireCurrentPlayer(state, action.userId)
  resolvePropertyDecision(
    state,
    map,
    player.userId,
    action.decision,
    events,
    { automatic }
  )
  state.pendingDecision = null
  state.phase = PHASES.RESOLVING
  state.deadlineAt = 0
  finishPlayerTurn(state, map, events, runtime)
}

function rollTimeout(state, map, action, runtime, events) {
  requirePhase(state, PHASES.AWAITING_ROLL, "当前不在等待掷骰。")
  const player = currentPlayer(state)
  player.consecutiveRollTimeouts += 1
  events.push({
    type: "roll_timed_out",
    playerId: player.userId,
    count: player.consecutiveRollTimeouts,
    limit: map.gameDefaults.maxConsecutiveRollTimeouts,
  })
  if (
    player.consecutiveRollTimeouts >=
    map.gameDefaults.maxConsecutiveRollTimeouts
  ) {
    surrenderPlayer(state, map, player.userId, events, "roll_timeout")
    finishPlayerTurn(state, map, events, runtime)
    return
  }
  performRoll(state, map, player, action.dice, runtime, events, {
    automatic: true,
  })
}

function surrender(state, map, action, runtime, events) {
  requirePhase(
    state,
    [
      PHASES.AWAITING_ROLL,
      PHASES.AWAITING_PURCHASE,
      PHASES.AWAITING_UPGRADE,
    ],
    "当前不能认输。"
  )
  const player = requirePlayer(state, action.userId)
  if (player.status !== PLAYER_STATUS.ACTIVE) {
    ruleError("PLAYER_INACTIVE", "你已经退出本局。")
  }
  const wasCurrent = currentPlayer(state)?.userId === player.userId
  if (state.pendingDecision?.playerId === player.userId) {
    state.pendingDecision = null
  }
  surrenderPlayer(state, map, player.userId, events, "surrender")

  if (hasAtMostOneActivePlayer(state)) {
    endGame(state, map, events, END_REASONS.LAST_PLAYER, runtime)
  } else if (wasCurrent) {
    finishPlayerTurn(state, map, events, runtime)
  }
}

export function transition(inputState, action, map, runtime = {}) {
  const state = cloneState(inputState)
  const events = []
  const now = asNow(runtime)
  state.updatedAt = now

  switch (action.type) {
    case ACTIONS.JOIN:
      joinLobby(state, map, action, events)
      break
    case ACTIONS.LEAVE_LOBBY:
      leaveLobby(state, map, action, runtime, events)
      break
    case ACTIONS.START:
      startGame(state, map, action, runtime, events)
      break
    case ACTIONS.ROLL: {
      requirePhase(state, PHASES.AWAITING_ROLL, "当前不在等待掷骰。")
      const player = requireCurrentPlayer(state, action.userId)
      player.consecutiveRollTimeouts = 0
      performRoll(state, map, player, action.dice, runtime, events)
      break
    }
    case ACTIONS.ROLL_TIMEOUT:
      rollTimeout(state, map, action, runtime, events)
      break
    case ACTIONS.DECIDE:
      decide(state, map, action, runtime, events)
      break
    case ACTIONS.DECISION_TIMEOUT: {
      const pending = state.pendingDecision
      if (!pending) {
        ruleError("NO_PENDING_DECISION", "当前没有等待中的选择。")
      }
      events.push({
        type: "decision_timed_out",
        playerId: pending.playerId,
        tileId: pending.tileId,
        decisionType: pending.type,
      })
      decide(
        state,
        map,
        {
          userId: pending.playerId,
          decision: DECISIONS.DECLINE,
        },
        runtime,
        events,
        true
      )
      break
    }
    case ACTIONS.SURRENDER:
      surrender(state, map, action, runtime, events)
      break
    case ACTIONS.FORCE_END:
      if (state.phase === PHASES.ENDED) {
        ruleError("GAME_ENDED", "这局已经结束了。")
      }
      endGame(state, map, events, END_REASONS.FORCE, runtime, {
        forced: true,
      })
      break
    default:
      ruleError("UNKNOWN_ACTION", `未知的大富翁动作 ${action.type}。`)
  }

  assertStateInvariants(state, map)
  return { state, events }
}
