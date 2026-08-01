import {
  ACTIONS,
  DECISIONS,
  END_REASONS,
  PHASES,
  PLAYER_STATUS,
  SESSION_VERSION,
  ruleError,
} from "./constants.js"
import {
  placeBid,
  resolveAuction,
} from "./rules/auction.js"
import { validateDiceSet } from "./rules/dice.js"
import { moveBy, sendToJail } from "./rules/movement.js"
import {
  resolvePropertyDecision,
} from "./rules/property.js"
import {
  buildOnProperty,
  mortgageProperty,
  redeemProperty,
  sellBuilding,
} from "./rules/assets.js"
import { createBuildingSupply } from "./rules/buildings.js"
import {
  consumeItem,
  hasItem,
  itemById,
} from "./rules/items.js"
import {
  NEGATE_ITEM,
  itemAction,
} from "./rules/itemActions.js"
import {
  processPaymentQueue,
  resolvePendingDebt,
  settlePayment,
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

const JAIL_FREE_ITEM = "jail_free"
const FORCE_BUY_ITEM = "force_buy"

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
    consecutiveDoubles: 0,
    forceBuysUsed: 0,
    status: PLAYER_STATUS.ACTIVE,
    items: [],
  }
}

function createDeckStates(map) {
  return Object.fromEntries(
    map.chanceDecks.map((deck) => [deck.id, { order: [], cursor: 0 }])
  )
}

function createPropertyStates(map) {
  return Object.fromEntries(
    propertyTiles(map).map((tile) => [
      String(tile.id),
      { ownerId: null, level: 0, mortgaged: false },
    ])
  )
}

export function createLobbyState(
  {
    sessionId,
    selfId,
    groupId,
    hostUserId,
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
    turnIndex: -1,
    players: [],
    propertyStates: createPropertyStates(map),
    buildingSupply: createBuildingSupply(map),
    decks: createDeckStates(map),
    pendingDecision: null,
    pendingDebt: null,
    pendingAction: null,
    pendingAuction: null,
    deadlineAt: now + map.gameDefaults.lobbyTimeoutSeconds * 1000,
    lastDice: null,
    winnerIds: [],
    rankings: [],
    endReason: null,
    createdAt: now,
    startedAt: 0,
    endedAt: 0,
    updatedAt: now,
    lastMove: null,
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
  player.consecutiveDoubles = 0
  state.phase = PHASES.AWAITING_ROLL
  state.pendingDecision = null
  state.pendingDebt = null
  state.pendingAction = null
  state.pendingAuction = null
  state.deadlineAt =
    state.updatedAt + map.gameDefaults.rollTimeoutSeconds * 1000
  events.push({
    type: "turn_started",
    playerId: player.userId,
    turnSeq: state.turnSeq,
    deadlineAt: state.deadlineAt,
    // 在狱中的人这一回合也照常行动，只是掷骰按看守所规则结算
    jailTurns: player.jailTurns,
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
  state.pendingDebt = null
  state.pendingAction = null
  state.pendingAuction = null
  state.deadlineAt = 0
  state.endReason = reason
  state.endedAt = now
  state.rankings = rankings
  for (const player of state.players) player.consecutiveDoubles = 0
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

function finishPlayerTurn(state, map, events, runtime) {
  const endingPlayer = currentPlayer(state)
  if (endingPlayer) endingPlayer.consecutiveDoubles = 0
  state.pendingDecision = null
  state.pendingDebt = null
  state.pendingAction = null
  state.pendingAuction = null
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
  state.turnIndex = next.index
  state.turnSeq += 1
  const player = currentPlayer(state)
  if (!player || player.status !== PLAYER_STATUS.ACTIVE) {
    ruleError("INVALID_STATE", "无法找到下一名在场玩家。")
  }
  addTurnStartedEvent(state, map, events)
}

function resumeAwaitingRoll(state, map, events) {
  state.phase = PHASES.AWAITING_ROLL
  state.pendingDecision = null
  state.pendingDebt = null
  state.pendingAction = null
  state.pendingAuction = null
  state.deadlineAt =
    state.updatedAt + map.gameDefaults.rollTimeoutSeconds * 1000
  return events
}

function finishResolvedRoll(state, map, events, runtime) {
  const player = currentPlayer(state)
  const lastDice = state.lastDice

  // 掷骰前触发的结算（道具引发的欠款、拍卖开标）：回合还给当前玩家，不换人
  if (
    player?.status === PLAYER_STATUS.ACTIVE &&
    (lastDice?.turnSeq !== state.turnSeq ||
      lastDice?.playerId !== player.userId)
  ) {
    resumeAwaitingRoll(state, map, events)
    return
  }

  const canRollAgain =
    player?.status === PLAYER_STATUS.ACTIVE &&
    player.jailTurns <= 0 &&
    lastDice?.playerId === player.userId &&
    lastDice.isDouble === true &&
    player.consecutiveDoubles > 0

  if (!canRollAgain) {
    finishPlayerTurn(state, map, events, runtime)
    return
  }

  state.phase = PHASES.AWAITING_ROLL
  state.pendingDecision = null
  state.pendingDebt = null
  state.pendingAction = null
  state.deadlineAt =
    state.updatedAt + map.gameDefaults.rollTimeoutSeconds * 1000
  events.push({
    type: "extra_roll_awarded",
    playerId: player.userId,
    doublesCount: player.consecutiveDoubles,
    deadlineAt: state.deadlineAt,
  })
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
  for (const deck of map.chanceDecks) {
    if (!validateDeckOrder(deck, runtime.chanceOrder?.[deck.id])) {
      ruleError("INVALID_RANDOM_INPUT", `开局牌堆 ${deck.id} 的顺序无效。`)
    }
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
    player.consecutiveDoubles = 0
    player.forceBuysUsed = 0
    player.status = PLAYER_STATUS.ACTIVE
    player.items = []
    return player
  })
  state.propertyStates = createPropertyStates(map)
  state.buildingSupply = createBuildingSupply(map)
  state.decks = Object.fromEntries(
    map.chanceDecks.map((deck) => [
      deck.id,
      { order: [...runtime.chanceOrder[deck.id]], cursor: 0 },
    ])
  )
  state.pendingDecision = null
  state.pendingDebt = null
  state.pendingAction = null
  state.pendingAuction = null
  state.turnIndex = 0
  state.turnSeq = 1
  state.startedAt = asNow(runtime)
  state.lastDice = null
  state.lastMove = null
  state.winnerIds = []
  state.rankings = []
  state.endReason = null
  events.push({
    type: "game_started",
    playerOrder: state.players.map((player) => player.userId),
    startingCash: map.gameDefaults.startingCash,
  })
  addTurnStartedEvent(state, map, events)
}

// 从本次掷骰产生的事件里还原落点链，去掉最终那一站就是中途落点。
// 连锁深度本身有上限，这里再截一次，免得棋盘上画出一串看不清的圈
const MAX_RENDERED_HOPS = 3

function intermediateHops(events, startIndex, playerId) {
  const landings = []
  for (let index = startIndex; index < events.length; index++) {
    const event = events[index]
    if (event.playerId !== playerId) continue
    if (event.type === "moved" || event.type === "sent_to_jail") {
      landings.push(event.toTileId)
    }
  }
  return landings.slice(0, -1).slice(-MAX_RENDERED_HOPS)
}

// 狱中掷骰：对子当场释放，否则耗掉一次机会；用满上限就必须赎身。
// 返回 true 表示人已经出来了，可以按点数继续走。
function resolveJailRoll(state, map, player, isDouble, runtime, events) {
  if (isDouble) {
    player.jailTurns = 0
    events.push({
      type: "jail_released",
      playerId: player.userId,
      reason: "doubles",
      paid: 0,
    })
    return true
  }

  player.jailTurns -= 1
  if (player.jailTurns > 0) {
    events.push({
      type: "jail_roll_failed",
      playerId: player.userId,
      remainingTurns: player.jailTurns,
      turnSeq: state.turnSeq,
    })
    return false
  }

  // 机会已经用尽：手上有保释令就顶掉这笔罚金，否则照价交钱
  if (
    consumeItem(state, map, player.userId, JAIL_FREE_ITEM, events, {
      reason: "jail",
    })
  ) {
    events.push({
      type: "jail_released",
      playerId: player.userId,
      reason: "jail_free",
      paid: 0,
    })
    return true
  }

  const amount = map.gameDefaults.jailBailAmount
  const queued = processPaymentQueue(
    state,
    map,
    [{ payerId: player.userId, amount, reason: "jail_bail" }],
    events,
    { now: runtime.now }
  )
  // 掏不出罚金就先进筹款流程，本回合不再移动
  if (queued.pending) return false
  events.push({
    type: "jail_released",
    playerId: player.userId,
    reason: "forced_bail",
    paid: amount,
  })
  return true
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
  const values = validateDiceSet(
    dice,
    map.gameDefaults.diceCount,
    map.gameDefaults.diceSides
  )
  const total = values.reduce((sum, value) => sum + value, 0)
  const isDouble = values.every((value) => value === values[0])
  const fromTileId = player.position
  const inJail = player.jailTurns > 0
  state.phase = PHASES.RESOLVING
  state.deadlineAt = 0
  state.pendingDecision = null
  // 狱中的对子不计连对：既不会三连入狱，出狱后也不追加一次掷骰
  player.consecutiveDoubles =
    !inJail && isDouble ? player.consecutiveDoubles + 1 : 0
  state.lastDice = {
    playerId: player.userId,
    values: [...values],
    total,
    isDouble,
    turnSeq: state.turnSeq,
  }
  events.push({
    type: "dice_rolled",
    playerId: player.userId,
    values: [...values],
    total,
    isDouble,
    doublesCount: player.consecutiveDoubles,
    inJail,
    automatic,
  })

  if (inJail) {
    const released = resolveJailRoll(
      state,
      map,
      player,
      isDouble,
      runtime,
      events
    )
    if (!released) {
      state.lastMove = {
        playerId: player.userId,
        fromTileId,
        toTileId: player.position,
        turnSeq: state.turnSeq,
      }
      if (state.phase === PHASES.AWAITING_DEBT) return
      finishPlayerTurn(state, map, events, runtime)
      return
    }
  } else if (
    isDouble &&
    player.consecutiveDoubles >=
      map.gameDefaults.maxConsecutiveDoubles
  ) {
    events.push({
      type: "triple_doubles_jail",
      playerId: player.userId,
      doublesCount: player.consecutiveDoubles,
    })
    sendToJail(
      state,
      map,
      player.userId,
      map.board.jailTileId,
      map.gameDefaults.jailMaxTurns,
      events,
      "consecutive_doubles"
    )
    state.lastMove = {
      playerId: player.userId,
      fromTileId,
      toTileId: player.position,
      turnSeq: state.turnSeq,
    }
    player.consecutiveDoubles = 0
    finishPlayerTurn(state, map, events, runtime)
    return
  }

  // 卡牌可能在落地后把人再挪走，中途落点记下来给棋盘画分段箭头
  const hopMark = events.length
  moveBy(state, map, player.userId, total, {
    collectStartReward: true,
    events,
    reason: automatic ? "timeout_roll" : "dice",
  })
  resolveCurrentTile(state, map, player.userId, runtime, events)
  state.lastMove = {
    playerId: player.userId,
    fromTileId,
    toTileId: player.position,
    viaTileIds: intermediateHops(events, hopMark, player.userId),
    turnSeq: state.turnSeq,
  }

  if (state.phase === PHASES.AWAITING_DEBT) return

  if (hasAtMostOneActivePlayer(state)) {
    endGame(state, map, events, END_REASONS.LAST_PLAYER, runtime)
    return
  }

  if (state.phase === PHASES.AWAITING_PURCHASE) {
    if (!automatic) return
    const pending = state.pendingDecision
    const offerIndex = events.findLastIndex(
      (event) =>
        event.type === "purchase_offered" &&
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
  finishResolvedRoll(state, map, events, runtime)
}

// —— 道具与否决链 ——

// 链上每多一张否决令就翻转一次结果：偶数层生效，奇数层作废
function counterRespondentId(pending) {
  return pending.chain.length % 2 === 0 ? pending.victimId : pending.actorId
}

function resolvePendingItem(state, map, runtime, events) {
  const pending = state.pendingAction
  if (!pending) return
  state.pendingAction = null

  const actor = playerById(state, pending.actorId)
  const negated = pending.chain.length % 2 === 1
  if (negated) {
    const last = pending.chain[pending.chain.length - 1]
    events.push({
      type: "item_negated",
      playerId: last.userId,
      actorId: pending.actorId,
      itemId: pending.itemId,
      depth: pending.chain.length,
    })
  } else if (actor?.status === PLAYER_STATUS.ACTIVE) {
    itemAction(pending.itemId).apply(
      state,
      map,
      actor,
      { ...pending.args, victimId: pending.victimId },
      runtime,
      events
    )
    if (pending.chain.length > 0) {
      events.push({
        type: "counter_chain_resolved",
        playerId: pending.actorId,
        itemId: pending.itemId,
        depth: pending.chain.length,
        applied: true,
      })
    }
  }

  // 道具是在自己掷骰前用的，结算完把回合还回去，不换人；
  // 但道具本身开出的新阶段（暗拍、欠款）不能被覆盖掉
  if (
    state.phase !== PHASES.AWAITING_DEBT &&
    state.phase !== PHASES.AWAITING_AUCTION
  ) {
    state.phase = PHASES.AWAITING_ROLL
    state.deadlineAt =
      state.updatedAt + map.gameDefaults.rollTimeoutSeconds * 1000
  }
}

// 只有手上真有否决令的人才值得开窗口，否则直接结算，别让全场干等
function advanceCounter(state, map, runtime, events) {
  const pending = state.pendingAction
  const respondent = playerById(state, counterRespondentId(pending))
  if (
    !respondent ||
    respondent.status !== PLAYER_STATUS.ACTIVE ||
    !hasItem(respondent, NEGATE_ITEM)
  ) {
    resolvePendingItem(state, map, runtime, events)
    return
  }
  pending.respondentId = respondent.userId
  state.phase = PHASES.AWAITING_COUNTER
  state.deadlineAt =
    state.updatedAt + map.gameDefaults.counterTimeoutSeconds * 1000
  events.push({
    type: "counter_window_opened",
    playerId: respondent.userId,
    actorId: pending.actorId,
    victimId: pending.victimId,
    itemId: pending.itemId,
    depth: pending.chain.length,
    deadlineAt: state.deadlineAt,
  })
}

function useItem(state, map, action, runtime, events) {
  requirePhase(state, PHASES.AWAITING_ROLL, "只能在自己掷骰前使用道具。")
  const actor = requireCurrentPlayer(state, action.userId)
  const definition = itemById(map, action.itemId)
  const handler = itemAction(action.itemId)
  if (!definition || !handler) {
    ruleError("UNKNOWN_ITEM", "这张道具卡不能主动使用。")
  }
  if (!hasItem(actor, definition.id)) {
    ruleError("ITEM_NOT_HELD", `你手上没有${definition.name}。`)
  }

  const prepared = handler.prepare(
    state,
    map,
    actor,
    action.args || [],
    runtime
  )
  consumeItem(state, map, actor.userId, definition.id, events, {
    reason: "use",
  })
  events.push({
    type: "item_targeted",
    playerId: actor.userId,
    victimId: prepared.victimId,
    itemId: definition.id,
    detail: handler.describe(map, prepared.args),
  })

  state.pendingAction = {
    itemId: definition.id,
    actorId: actor.userId,
    victimId: prepared.victimId,
    args: prepared.args,
    chain: [],
    respondentId: null,
    createdAt: asNow(runtime),
  }
  if (handler.counterable) {
    advanceCounter(state, map, runtime, events)
    return
  }
  resolvePendingItem(state, map, runtime, events)
}

// 强制收购是常驻规则不是卡牌，但走同一条否决链：打出即算用掉一次，被否决也不退
function forceBuy(state, map, action, runtime, events) {
  requirePhase(state, PHASES.AWAITING_ROLL, "只能在自己掷骰前收购。")
  const actor = requireCurrentPlayer(state, action.userId)
  const handler = itemAction(FORCE_BUY_ITEM)
  const prepared = handler.prepare(
    state,
    map,
    actor,
    [action.tileId],
    runtime
  )

  actor.forceBuysUsed = (actor.forceBuysUsed ?? 0) + 1
  events.push({
    type: "force_buy_declared",
    playerId: actor.userId,
    victimId: prepared.victimId,
    tileId: prepared.args.targetTileId,
    price: prepared.args.price,
    remaining: Math.max(
      0,
      map.gameDefaults.forceBuyLimit - actor.forceBuysUsed
    ),
  })

  state.pendingAction = {
    itemId: FORCE_BUY_ITEM,
    actorId: actor.userId,
    victimId: prepared.victimId,
    args: prepared.args,
    chain: [],
    respondentId: null,
    createdAt: asNow(runtime),
  }
  advanceCounter(state, map, runtime, events)
}

function counterAction(state, map, action, runtime, events, automatic) {
  requirePhase(state, PHASES.AWAITING_COUNTER, "当前没有等待否决的道具。")
  const pending = state.pendingAction
  if (automatic || action.pass) {
    if (!automatic) {
      const player = requirePlayer(state, action.userId)
      if (player.userId !== pending.respondentId) {
        ruleError("NOT_RESPONDENT", "现在不该你决定是否否决。")
      }
    }
    events.push({
      type: "counter_declined",
      playerId: pending.respondentId,
      itemId: pending.itemId,
      automatic,
      depth: pending.chain.length,
    })
    resolvePendingItem(state, map, runtime, events)
    return
  }

  const player = requirePlayer(state, action.userId)
  if (player.userId !== pending.respondentId) {
    ruleError("NOT_RESPONDENT", "现在不该你决定是否否决。")
  }
  if (!hasItem(player, NEGATE_ITEM)) {
    ruleError("ITEM_NOT_HELD", "你手上没有否决令。")
  }
  consumeItem(state, map, player.userId, NEGATE_ITEM, events, {
    reason: "counter",
  })
  pending.chain.push({ userId: player.userId, itemId: NEGATE_ITEM })
  advanceCounter(state, map, runtime, events)
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
    playerNumber: player.joinOrder + 1,
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
    PHASES.AWAITING_PURCHASE,
    "当前没有等待购买。"
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
  finishResolvedRoll(state, map, events, runtime)
}

function finishDebtResolution(state, map, runtime, events, automatic) {
  const result = resolvePendingDebt(state, map, events, {
    now: asNow(runtime),
    automatic,
  })
  if (result.pending) return
  finishResolvedRoll(state, map, events, runtime)
}

function performAssetAction(state, map, action, runtime, events) {
  const resolvingDebt = state.phase === PHASES.AWAITING_DEBT
  let player
  if (resolvingDebt) {
    player = requirePlayer(state, action.userId)
    if (state.pendingDebt?.payerId !== player.userId) {
      ruleError("NOT_DEBTOR", "只有当前欠款玩家可以处理资产。")
    }
    if (![ACTIONS.SELL_BUILDING, ACTIONS.MORTGAGE].includes(action.type)) {
      ruleError("DEBT_ACTION_NOT_ALLOWED", "欠款处理中只能卖房或抵押地产。")
    }
  } else {
    requirePhase(state, PHASES.AWAITING_ROLL, "只能在自己掷骰前管理资产。")
    player = requireCurrentPlayer(state, action.userId)
  }

  if (action.type === ACTIONS.BUILD) {
    buildOnProperty(state, map, player.userId, action.tileId, events)
  } else if (action.type === ACTIONS.SELL_BUILDING) {
    sellBuilding(state, map, player.userId, action.tileId, events)
  } else if (action.type === ACTIONS.MORTGAGE) {
    mortgageProperty(state, map, player.userId, action.tileId, events)
  } else if (action.type === ACTIONS.REDEEM) {
    redeemProperty(state, map, player.userId, action.tileId, events)
  } else {
    ruleError("UNKNOWN_ASSET_ACTION", "未知的资产操作。")
  }

  if (
    resolvingDebt &&
    player.cash >= (state.pendingDebt?.amount ?? Number.MAX_SAFE_INTEGER)
  ) {
    finishDebtResolution(state, map, runtime, events, false)
  }
}

function resolveDebtAction(state, map, action, runtime, events, automatic) {
  requirePhase(state, PHASES.AWAITING_DEBT, "当前没有等待处理的欠款。")
  if (!automatic) {
    const player = requirePlayer(state, action.userId)
    if (state.pendingDebt?.payerId !== player.userId) {
      ruleError("NOT_DEBTOR", "只有当前欠款玩家可以强制结算。")
    }
  }
  finishDebtResolution(state, map, runtime, events, automatic)
}

// 主动保释：掷骰前花钱（或用掉保释令）离开看守所，之后这一回合完全照常
function payBail(state, map, action, events) {
  requirePhase(state, PHASES.AWAITING_ROLL, "只能在自己掷骰前保释。")
  const player = requireCurrentPlayer(state, action.userId)
  if (player.jailTurns <= 0) {
    ruleError("NOT_IN_JAIL", "你现在不在看守所。")
  }

  // 保释令留着也只能用在这里，有卡就先用卡，省下现金
  if (
    consumeItem(state, map, player.userId, JAIL_FREE_ITEM, events, {
      reason: "jail",
    })
  ) {
    player.jailTurns = 0
    events.push({
      type: "jail_released",
      playerId: player.userId,
      reason: "jail_free",
      paid: 0,
    })
    return
  }

  const amount = map.gameDefaults.jailBailAmount
  if (player.cash < amount) {
    ruleError("INSUFFICIENT_CASH", `保释需要 ${amount}，你的现金不够。`)
  }
  player.jailTurns = 0
  settlePayment(state, map, {
    payerId: player.userId,
    amount,
    reason: "jail_bail",
    events,
    force: true,
  })
  events.push({
    type: "jail_released",
    playerId: player.userId,
    reason: "bail",
    paid: amount,
  })
}

function bidAction(state, map, action, events) {
  requirePhase(state, PHASES.AWAITING_AUCTION, "现在没有正在进行的拍卖。")
  placeBid(state, map, {
    userId: action.userId,
    amount: action.amount,
    events,
  })
}

// 开标：结算完把回合还给用拍卖令的人，他还没掷骰
function finishAuction(state, map, runtime, events, automatic) {
  requirePhase(state, PHASES.AWAITING_AUCTION, "当前没有等待开标的拍卖。")
  resolveAuction(state, map, events, { automatic })
  if (hasAtMostOneActivePlayer(state)) {
    endGame(state, map, events, END_REASONS.LAST_PLAYER, runtime)
    return
  }
  finishResolvedRoll(state, map, events, runtime)
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
    case ACTIONS.PAY_BAIL:
      payBail(state, map, action, events)
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
    case ACTIONS.BUILD:
    case ACTIONS.SELL_BUILDING:
    case ACTIONS.MORTGAGE:
    case ACTIONS.REDEEM:
      performAssetAction(state, map, action, runtime, events)
      break
    case ACTIONS.USE_ITEM:
      useItem(state, map, action, runtime, events)
      break
    case ACTIONS.FORCE_BUY:
      forceBuy(state, map, action, runtime, events)
      break
    case ACTIONS.COUNTER:
      counterAction(state, map, action, runtime, events, false)
      break
    case ACTIONS.COUNTER_PASS:
      counterAction(
        state,
        map,
        { ...action, pass: true },
        runtime,
        events,
        false
      )
      break
    case ACTIONS.COUNTER_TIMEOUT:
      counterAction(state, map, action, runtime, events, true)
      break
    case ACTIONS.BID:
      bidAction(state, map, action, events)
      break
    case ACTIONS.AUCTION_TIMEOUT:
      finishAuction(state, map, runtime, events, true)
      break
    case ACTIONS.RESOLVE_DEBT:
      resolveDebtAction(state, map, action, runtime, events, false)
      break
    case ACTIONS.DEBT_TIMEOUT:
      resolveDebtAction(state, map, action, runtime, events, true)
      break
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
