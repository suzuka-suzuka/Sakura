import { randomInt as cryptoRandomInt, randomUUID } from "node:crypto"
import {
  ACTIONS,
  DECISIONS,
  END_REASONS,
  GameRuleError,
  PHASES,
  PLAYER_COLORS,
  PLAYER_STATUS,
} from "./constants.js"
import {
  createLobbyState,
  transition,
} from "./GameEngine.js"
import { rollDice } from "./rules/dice.js"

function normalizeContext(context) {
  if (
    context?.selfId == null ||
    context?.groupId == null ||
    context?.userId == null
  ) {
    throw new TypeError("大富翁操作需要 selfId、groupId 和 userId")
  }
  return {
    ...context,
    selfId: String(context.selfId),
    groupId: String(context.groupId),
    userId: String(context.userId),
    displayName: String(
      context.displayName || context.userId
    ).slice(0, 40),
  }
}

function gameError(code, message) {
  throw new GameRuleError(code, message)
}

export function shuffle(values, randomInt = cryptoRandomInt) {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index--) {
    const selected = randomInt(0, index + 1)
    ;[result[index], result[selected]] = [result[selected], result[index]]
  }
  return result
}

export class GameService {
  constructor({
    map,
    store,
    scheduler = null,
    now = () => Date.now(),
    randomInt = cryptoRandomInt,
    createId = randomUUID,
  }) {
    if (!map || !store) {
      throw new TypeError("GameService 需要地图和 SessionStore")
    }
    this.map = map
    this.store = store
    this.scheduler = scheduler
    this.now = now
    this.randomInt = randomInt
    this.createId = createId
  }

  lockRef(context) {
    return {
      selfId: String(context.selfId),
      groupId: String(context.groupId),
    }
  }

  async withLock(context, callback, { quietBusy = false } = {}) {
    const lockRef = this.lockRef(context)
    const token = await this.store.acquireSessionLock(lockRef)
    if (!token) {
      if (quietBusy) return null
      gameError("GAME_BUSY", "本群大富翁状态正在变化，请稍后再试。")
    }
    try {
      return await callback(lockRef)
    } finally {
      await this.store.releaseSessionLock(lockRef, token)
    }
  }

  ensureMap(session) {
    if (
      session.mapId !== this.map.id ||
      session.mapVersion !== this.map.version
    ) {
      gameError(
        "MAP_VERSION_MISMATCH",
        "这局使用的地图版本已不可用，请由房主或管理员结束后重新开局。"
      )
    }
  }

  async requireSession(selfId, groupId) {
    const session = await this.store.loadSession(selfId, groupId)
    if (!session) gameError("NO_GAME", "本群还没有大富翁房间。")
    this.ensureMap(session)
    return session
  }

  chanceOrder() {
    return shuffle(
      this.map.chanceDecks[0].cards.map((card) => card.id),
      this.randomInt
    )
  }

  tieBreakRolls(players) {
    const rolls = Object.fromEntries(
      players.map((player) => [player.userId, []])
    )
    for (let round = 0; round < 16; round++) {
      for (const player of players) {
        rolls[player.userId].push(this.randomInt(1, 7))
      }
      const signatures = players.map((player) =>
        rolls[player.userId].join(":")
      )
      if (new Set(signatures).size === players.length) return rolls
    }

    // 极端随机源连续碰撞时追加合法骰点，保证纯引擎无需用 QQ 号裁决。
    players.forEach((player, index) => {
      rolls[player.userId].push(index + 1)
    })
    return rolls
  }

  runtime(session, overrides = {}) {
    return {
      now: this.now(),
      chanceOrder: this.chanceOrder(),
      tieBreakRolls: this.tieBreakRolls(session.players),
      ...overrides,
    }
  }

  result({
    state,
    events,
    renderBoard = false,
    scheduled = false,
    deleted = false,
  }) {
    return {
      handled: true,
      state,
      events,
      renderBoard,
      scheduled,
      deleted,
      selfId: state.selfId,
      groupId: state.groupId,
    }
  }

  async saveActiveSession(session) {
    await this.store.saveSession(session)
    this.scheduler?.schedule(session)
  }

  async commitTransition(previous, transitionResult) {
    const { state } = transitionResult
    if (state.phase === PHASES.ENDED) {
      const deleted = await this.store.deleteSession(previous)
      if (!deleted) {
        gameError(
          "SESSION_CHANGED",
          "本局刚刚被另一个操作结束，请重新查看状态。"
        )
      }
      this.scheduler?.cancel(state.selfId, state.groupId)
      return { deleted: true }
    }
    await this.saveActiveSession(state)
    for (const player of state.players) {
      if (player.status === PLAYER_STATUS.ACTIVE) continue
      await this.store.dropUserIndex(
        state.selfId,
        player.userId,
        state.groupId
      )
    }
    return { deleted: false }
  }

  async createGame(rawContext) {
    const context = normalizeContext(rawContext)
    return this.withLock(context, async () => {
      const existing = await this.store.loadSession(
        context.selfId,
        context.groupId
      )
      if (existing && existing.phase !== PHASES.ENDED) {
        gameError("GAME_EXISTS", "本群已经有一局大富翁正在进行。")
      }
      if (existing) await this.store.deleteSession(existing)

      const ownership = await this.store.claimUserIndex(
        context.selfId,
        context.userId,
        context.groupId
      )
      if (!ownership.ok) {
        gameError(
          "USER_IN_OTHER_GAME",
          "你已经在另一个群的大富翁中，不能同时加入第二局。"
        )
      }

      const now = this.now()
      const state = createLobbyState(
        {
          sessionId: this.createId(),
          selfId: context.selfId,
          groupId: context.groupId,
          hostUserId: context.userId,
          hostDisplayName: context.displayName,
        },
        this.map,
        now
      )
      try {
        await this.saveActiveSession(state)
      } catch (error) {
        await this.store.dropUserIndex(
          context.selfId,
          context.userId,
          context.groupId
        )
        throw error
      }

      return this.result({
        state,
        events: [
          {
            type: "game_created",
            playerId: context.userId,
            minPlayers: this.map.gameDefaults.minPlayers,
            maxPlayers: this.map.gameDefaults.maxPlayers,
            lobbyDeadlineAt: state.deadlineAt,
          },
        ],
      })
    })
  }

  async joinGame(rawContext) {
    const context = normalizeContext(rawContext)
    return this.withLock(context, async () => {
      const previous = await this.requireSession(
        context.selfId,
        context.groupId
      )
      const transitionResult = transition(
        previous,
        {
          type: ACTIONS.JOIN,
          userId: context.userId,
          displayName: context.displayName,
        },
        this.map,
        this.runtime(previous)
      )

      const ownership = await this.store.claimUserIndex(
        context.selfId,
        context.userId,
        context.groupId
      )
      if (!ownership.ok) {
        gameError(
          "USER_IN_OTHER_GAME",
          "你已经在另一个群的大富翁中，不能同时加入第二局。"
        )
      }
      try {
        await this.saveActiveSession(transitionResult.state)
      } catch (error) {
        await this.store.dropUserIndex(
          context.selfId,
          context.userId,
          context.groupId
        )
        throw error
      }

      return this.result(transitionResult)
    })
  }

  async leaveLobby(rawContext) {
    const context = normalizeContext(rawContext)
    return this.withLock(context, async () => {
      const previous = await this.requireSession(
        context.selfId,
        context.groupId
      )
      const transitionResult = transition(
        previous,
        {
          type: ACTIONS.LEAVE_LOBBY,
          userId: context.userId,
        },
        this.map,
        this.runtime(previous)
      )
      const { deleted } = await this.commitTransition(
        previous,
        transitionResult
      )
      await this.store.dropUserIndex(
        context.selfId,
        context.userId,
        context.groupId
      )
      return this.result({ ...transitionResult, deleted })
    })
  }

  async startGame(rawContext) {
    const context = normalizeContext(rawContext)
    return this.withLock(context, async () => {
      const previous = await this.requireSession(
        context.selfId,
        context.groupId
      )
      const runtime = this.runtime(previous, {
        playerOrder: shuffle(
          previous.players.map((player) => player.userId),
          this.randomInt
        ),
        playerColors: shuffle(PLAYER_COLORS, this.randomInt),
      })
      const transitionResult = transition(
        previous,
        {
          type: ACTIONS.START,
          userId: context.userId,
          privileged: Boolean(
            context.isAdmin || context.isMaster || context.isWhite
          ),
        },
        this.map,
        runtime
      )
      const { deleted } = await this.commitTransition(
        previous,
        transitionResult
      )
      return this.result({
        ...transitionResult,
        renderBoard: true,
        deleted,
      })
    })
  }

  async roll(rawContext) {
    const context = normalizeContext(rawContext)
    return this.withLock(context, async () => {
      const previous = await this.requireSession(
        context.selfId,
        context.groupId
      )
      const transitionResult = transition(
        previous,
        {
          type: ACTIONS.ROLL,
          userId: context.userId,
          dice: rollDice(
            this.map.gameDefaults.diceSides,
            this.randomInt
          ),
        },
        this.map,
        this.runtime(previous)
      )
      const { deleted } = await this.commitTransition(
        previous,
        transitionResult
      )
      return this.result({
        ...transitionResult,
        renderBoard: true,
        deleted,
      })
    })
  }

  async decide(rawContext, decision) {
    const context = normalizeContext(rawContext)
    if (!Object.values(DECISIONS).includes(decision)) {
      throw new TypeError(`未知选择 ${decision}`)
    }
    return this.withLock(context, async () => {
      const previous = await this.requireSession(
        context.selfId,
        context.groupId
      )
      const transitionResult = transition(
        previous,
        {
          type: ACTIONS.DECIDE,
          userId: context.userId,
          decision,
        },
        this.map,
        this.runtime(previous)
      )
      const { deleted } = await this.commitTransition(
        previous,
        transitionResult
      )
      return this.result({
        ...transitionResult,
        renderBoard: true,
        deleted,
      })
    })
  }

  async surrender(rawContext) {
    const context = normalizeContext(rawContext)
    return this.withLock(context, async () => {
      const previous = await this.requireSession(
        context.selfId,
        context.groupId
      )
      const transitionResult = transition(
        previous,
        {
          type: ACTIONS.SURRENDER,
          userId: context.userId,
        },
        this.map,
        this.runtime(previous)
      )
      const { deleted } = await this.commitTransition(
        previous,
        transitionResult
      )
      return this.result({
        ...transitionResult,
        renderBoard: true,
        deleted,
      })
    })
  }

  async forceEnd(rawContext) {
    const context = normalizeContext(rawContext)
    return this.withLock(context, async () => {
      const previous = await this.store.loadSession(
        context.selfId,
        context.groupId
      )
      if (!previous) gameError("NO_GAME", "本群还没有大富翁房间。")
      const privileged = Boolean(
        context.isAdmin || context.isMaster || context.isWhite
      )
      if (previous.hostUserId !== context.userId && !privileged) {
        gameError(
          "NOT_ALLOWED",
          "只有房主、群管理员或白名单用户可以结束本局。"
        )
      }
      if (
        previous.mapId !== this.map.id ||
        previous.mapVersion !== this.map.version
      ) {
        const now = this.now()
        const state = structuredClone(previous)
        state.phase = PHASES.ENDED
        state.pendingDecision = null
        state.deadlineAt = 0
        state.endReason = END_REASONS.FORCE
        state.endedAt = now
        state.updatedAt = now
        state.winnerIds = []
        state.rankings = []
        const deleted = await this.store.deleteSession(previous)
        if (!deleted) {
          gameError(
            "SESSION_CHANGED",
            "本局刚刚被另一个操作结束，请重新查看状态。"
          )
        }
        this.scheduler?.cancel(state.selfId, state.groupId)
        return this.result({
          state,
          events: [
            {
              type: "game_ended",
              reason: END_REASONS.FORCE,
              forced: true,
              winnerIds: [],
              rankings: [],
            },
          ],
          renderBoard: false,
          deleted: true,
        })
      }
      this.ensureMap(previous)
      const transitionResult = transition(
        previous,
        { type: ACTIONS.FORCE_END, userId: context.userId },
        this.map,
        this.runtime(previous)
      )
      const { deleted } = await this.commitTransition(
        previous,
        transitionResult
      )
      return this.result({
        ...transitionResult,
        renderBoard: previous.phase !== PHASES.LOBBY,
        deleted,
      })
    })
  }

  async status(rawContext) {
    const context = normalizeContext(rawContext)
    const state = await this.requireSession(context.selfId, context.groupId)
    return this.result({
      state,
      events: [{ type: "status_requested", playerId: context.userId }],
      renderBoard: state.phase !== PHASES.LOBBY,
    })
  }

  timeoutToken(session) {
    return {
      sessionId: session.sessionId,
      selfId: session.selfId,
      groupId: session.groupId,
      turnSeq: session.turnSeq,
      phase: session.phase,
      deadlineAt: session.deadlineAt,
    }
  }

  isCurrentTimeout(session, token) {
    return (
      session.sessionId === token.sessionId &&
      session.turnSeq === token.turnSeq &&
      session.phase === token.phase &&
      session.deadlineAt === token.deadlineAt
    )
  }

  async handleTimeout(token) {
    const context = {
      selfId: String(token.selfId),
      groupId: String(token.groupId),
      userId: "timeout",
      displayName: "系统",
    }
    return this.withLock(context, async () => {
      const previous = await this.store.loadSession(
        context.selfId,
        context.groupId
      )
      if (!previous) return null
      this.ensureMap(previous)

      if (!this.isCurrentTimeout(previous, token)) {
        this.scheduler?.schedule(previous)
        return null
      }
      const now = this.now()
      if (previous.deadlineAt > now) {
        this.scheduler?.schedule(previous)
        return null
      }

      if (previous.phase === PHASES.LOBBY) {
        const state = structuredClone(previous)
        state.phase = PHASES.ENDED
        state.deadlineAt = 0
        state.endReason = END_REASONS.LOBBY_EXPIRED
        state.endedAt = now
        state.updatedAt = now
        const deleted = await this.store.deleteSession(previous)
        if (!deleted) return null
        this.scheduler?.cancel(state.selfId, state.groupId)
        return this.result({
          state,
          events: [{ type: "lobby_expired" }],
          scheduled: true,
          deleted: true,
        })
      }

      let action
      if (previous.phase === PHASES.AWAITING_ROLL) {
        action = {
          type: ACTIONS.ROLL_TIMEOUT,
          dice: rollDice(
            this.map.gameDefaults.diceSides,
            this.randomInt
          ),
        }
      } else if (
        previous.phase === PHASES.AWAITING_PURCHASE ||
        previous.phase === PHASES.AWAITING_UPGRADE
      ) {
        action = { type: ACTIONS.DECISION_TIMEOUT }
      } else {
        return null
      }

      const transitionResult = transition(
        previous,
        action,
        this.map,
        this.runtime(previous, { now })
      )
      const { deleted } = await this.commitTransition(
        previous,
        transitionResult
      )
      return this.result({
        ...transitionResult,
        renderBoard: true,
        scheduled: true,
        deleted,
      })
    }, { quietBusy: true })
  }

  async sweep(selfId) {
    const sessions = await this.store.listSessionsBySelfId(String(selfId))
    const results = []
    const now = this.now()
    for (const session of sessions) {
      if (
        Number.isSafeInteger(session.deadlineAt) &&
        session.deadlineAt > 0 &&
        session.deadlineAt <= now
      ) {
        const result = await this.handleTimeout(this.timeoutToken(session))
        if (result) results.push(result)
      } else {
        this.scheduler?.schedule(session)
      }
    }
    return results
  }
}
