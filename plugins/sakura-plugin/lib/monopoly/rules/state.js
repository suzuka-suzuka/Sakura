import {
  PHASES,
  PLAYER_STATUS,
  GameRuleError,
  ruleError,
} from "../constants.js"
import {
  buildingCountsForLevel,
  buildingStock,
} from "./buildings.js"

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
    if (
      !Number.isSafeInteger(player.consecutiveDoubles) ||
      player.consecutiveDoubles < 0 ||
      player.consecutiveDoubles >=
        map.gameDefaults.maxConsecutiveDoubles
    ) {
      throw new GameRuleError(
        "INVALID_STATE",
        `玩家 ${player.userId} 的连续对子计数无效。`
      )
    }
    if (!Array.isArray(player.items)) {
      throw new GameRuleError(
        "INVALID_STATE",
        `玩家 ${player.userId} 的道具背包不是数组。`
      )
    }
    const heldCounts = new Map()
    for (const entry of player.items) {
      const definition = map.items?.find(
        (item) => item.id === entry?.itemId
      )
      if (!definition) {
        throw new GameRuleError(
          "INVALID_STATE",
          `玩家 ${player.userId} 持有不存在的道具 ${entry?.itemId}。`
        )
      }
      const count = (heldCounts.get(definition.id) || 0) + 1
      heldCounts.set(definition.id, count)
      if (count > definition.maxHeld) {
        throw new GameRuleError(
          "INVALID_STATE",
          `玩家 ${player.userId} 的 ${definition.name} 超过持有上限。`
        )
      }
    }
  }

  for (const deck of map.chanceDecks) {
    const deckState = state.decks?.[deck.id]
    if (
      !deckState ||
      !Array.isArray(deckState.order) ||
      !Number.isSafeInteger(deckState.cursor) ||
      deckState.cursor < 0 ||
      deckState.cursor > deckState.order.length
    ) {
      throw new GameRuleError(
        "INVALID_STATE",
        `牌堆 ${deck.id} 的状态无效。`
      )
    }
  }

  if (state.lastDice != null) {
    const dice = state.lastDice
    const validValues =
      Array.isArray(dice.values) &&
      dice.values.length === map.gameDefaults.diceCount &&
      dice.values.every(
        (value) =>
          Number.isSafeInteger(value) &&
          value >= 1 &&
          value <= map.gameDefaults.diceSides
      )
    if (
      !dice ||
      typeof dice !== "object" ||
      !userIds.includes(String(dice.playerId)) ||
      !validValues ||
      !Number.isSafeInteger(dice.total) ||
      dice.total !== dice.values.reduce((sum, value) => sum + value, 0) ||
      typeof dice.isDouble !== "boolean" ||
      dice.isDouble !== dice.values.every((value) => value === dice.values[0]) ||
      !Number.isSafeInteger(dice.turnSeq) ||
      dice.turnSeq < 1
    ) {
      throw new GameRuleError(
        "INVALID_STATE",
        "最近一次双骰结果无效。"
      )
    }
  }

  if (state.lastMove != null) {
    const move = state.lastMove
    if (
      !move ||
      typeof move !== "object" ||
      !userIds.includes(String(move.playerId)) ||
      !validTileIds.has(move.fromTileId) ||
      !validTileIds.has(move.toTileId) ||
      !Number.isSafeInteger(move.turnSeq) ||
      move.turnSeq < 1
    ) {
      throw new GameRuleError(
        "INVALID_STATE",
        "本回合移动焦点无效。"
      )
    }
  }

  const validOwners = new Set(userIds)
  let housesOnBoard = 0
  let hotelsOnBoard = 0
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
    if (typeof propertyState.mortgaged !== "boolean") {
      throw new GameRuleError(
        "INVALID_STATE",
        `地产 ${tile.id} 的抵押状态无效。`
      )
    }
    if (propertyState.ownerId === null && propertyState.level !== 0) {
      throw new GameRuleError(
        "INVALID_STATE",
        `无主地产 ${tile.id} 不能保留等级。`
      )
    }
    if (propertyState.ownerId === null && propertyState.mortgaged) {
      throw new GameRuleError(
        "INVALID_STATE",
        `无主地产 ${tile.id} 不能处于抵押状态。`
      )
    }
    if (propertyState.mortgaged && propertyState.level !== 0) {
      throw new GameRuleError(
        "INVALID_STATE",
        `抵押地产 ${tile.id} 不能保留建筑。`
      )
    }
    if (
      (tile.propertyKind || "street") !== "street" &&
      propertyState.level !== 0
    ) {
      throw new GameRuleError(
        "INVALID_STATE",
        `非街区地产 ${tile.id} 不能建造房屋。`
      )
    }
    const buildingCounts = buildingCountsForLevel(
      map,
      propertyState.level
    )
    housesOnBoard += buildingCounts.houses
    hotelsOnBoard += buildingCounts.hotels
  }

  for (const group of map.propertyGroups) {
    const tiles = group.tileIds.map((tileId) => tileById(map, tileId))
    if ((tiles[0]?.propertyKind || "street") !== "street") continue
    const states = group.tileIds.map(
      (tileId) => state.propertyStates[String(tileId)]
    )
    const built = states.filter((entry) => entry.level > 0)
    if (built.length === 0) continue

    const builderId = built[0].ownerId
    if (
      builderId === null ||
      built.some((entry) => entry.ownerId !== builderId)
    ) {
      throw new GameRuleError(
        "INVALID_STATE",
        `色组 ${group.id} 的建筑归属不合法。`
      )
    }

    // 色组被道具打散后只按有建筑的地块比等级；
    // 一旦整组重新回到同一个主人手里，立刻恢复整组的均衡校验
    const owners = new Set(states.map((entry) => entry.ownerId))
    const scope = owners.size === 1 ? states : built
    const levels = scope.map((entry) => entry.level)
    if (Math.max(...levels) - Math.min(...levels) > 1) {
      throw new GameRuleError(
        "INVALID_STATE",
        `色组 ${group.id} 的建筑等级不均衡。`
      )
    }
  }

  const stock = buildingStock(map)
  if (
    !state.buildingSupply ||
    !Number.isSafeInteger(state.buildingSupply.houses) ||
    !Number.isSafeInteger(state.buildingSupply.hotels) ||
    state.buildingSupply.houses < 0 ||
    state.buildingSupply.hotels < 0 ||
    state.buildingSupply.houses + housesOnBoard !== stock.houses ||
    state.buildingSupply.hotels + hotelsOnBoard !== stock.hotels
  ) {
    throw new GameRuleError(
      "INVALID_STATE",
      "银行房屋或旅馆库存与棋盘建筑数量不一致。"
    )
  }

  if (state.phase === PHASES.LOBBY) {
    if (state.turnIndex !== -1) {
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
  }

  const purchasePhase = state.phase === PHASES.AWAITING_PURCHASE
  if (purchasePhase !== Boolean(state.pendingDecision)) {
    throw new GameRuleError("INVALID_STATE", "选择状态与待处理选择不一致。")
  }
  const debtPhase = state.phase === PHASES.AWAITING_DEBT
  if (debtPhase !== Boolean(state.pendingDebt)) {
    throw new GameRuleError("INVALID_STATE", "欠款状态与待处理欠款不一致。")
  }
  const counterPhase = state.phase === PHASES.AWAITING_COUNTER
  if (counterPhase !== Boolean(state.pendingAction)) {
    throw new GameRuleError("INVALID_STATE", "否决状态与待处理道具不一致。")
  }
  if (state.pendingAction) {
    const pending = state.pendingAction
    const known = new Set(userIds)
    if (
      !map.items?.some((item) => item.id === pending.itemId) ||
      !known.has(String(pending.actorId)) ||
      !known.has(String(pending.victimId)) ||
      !known.has(String(pending.respondentId)) ||
      !Array.isArray(pending.chain) ||
      pending.chain.some((entry) => !known.has(String(entry?.userId))) ||
      !Number.isSafeInteger(pending.createdAt) ||
      pending.createdAt < 0
    ) {
      throw new GameRuleError("INVALID_STATE", "待处理道具内容无效。")
    }
  }
  if (state.pendingDebt) {
    const debt = state.pendingDebt
    const payer = playerById(state, debt.payerId)
    if (
      !payer ||
      payer.status !== PLAYER_STATUS.ACTIVE ||
      !Number.isSafeInteger(debt.amount) ||
      debt.amount <= 0 ||
      !Array.isArray(debt.remainingPayments) ||
      !Number.isSafeInteger(debt.createdAt) ||
      debt.createdAt < 0
    ) {
      throw new GameRuleError("INVALID_STATE", "待处理欠款内容无效。")
    }
  }

  return state
}
