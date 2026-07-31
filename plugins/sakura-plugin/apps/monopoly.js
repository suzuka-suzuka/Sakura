import {
  Command,
  Cron,
  plugin,
} from "../../../src/core/plugin.js"
import {
  Segment,
  getCurrentBotSelfId,
} from "../../../src/api/client.js"
import { getRedis } from "../../../src/utils/redis.js"
import { logger } from "../../../src/utils/logger.js"
import {
  DECISIONS,
  GameRuleError,
} from "../lib/monopoly/constants.js"
import { GameService } from "../lib/monopoly/GameService.js"
import { COMMAND_PATTERNS } from "../lib/monopoly/commands.js"
import { MapLoader } from "../lib/monopoly/map/MapLoader.js"
import { MonopolySessionStore } from "../lib/monopoly/SessionStore.js"
import { TimeoutScheduler } from "../lib/monopoly/TimeoutScheduler.js"
import { renderBoard } from "../lib/monopoly/presentation/BoardRenderer.js"
import {
  buildTurnPrompt,
} from "../lib/monopoly/presentation/MessageFormatter.js"

export class Monopoly extends plugin {
  constructor() {
    super({
      name: "QQ群大富翁",
      event: "message.group",
      priority: 1128,
    })
    this.ready = false
    this.initError = null
    this.map = null
    this.store = null
    this.scheduler = null
    this.service = null
  }

  async init() {
    try {
      this.map = await new MapLoader().load("default-40")
      this.store = new MonopolySessionStore(getRedis(), { log: logger })
      this.scheduler = new TimeoutScheduler({
        onTimeout: (token) => this.handleScheduledTimeout(token),
        log: logger,
      })
      this.service = new GameService({
        map: this.map,
        store: this.store,
        scheduler: this.scheduler,
      })
      this.ready = true
      logger.info(
        `[大富翁] 已加载地图 ${this.map.name} v${this.map.version}（${this.map.tiles.length} 格）`
      )
    } catch (error) {
      this.initError = error
      this.ready = false
      logger.error(`[大富翁] 初始化失败：${error.stack || error}`)
    }
  }

  destroy() {
    this.ready = false
    this.scheduler?.clear()
    this.store?.destroy()
    super.destroy()
  }

  contextFromEvent(e) {
    return {
      selfId: e.self_id,
      groupId: e.group_id,
      userId: e.user_id,
      displayName:
        e.sender?.card ||
        e.sender?.nickname ||
        e.nickname ||
        String(e.user_id),
      isAdmin: Boolean(e.isAdmin),
      isMaster: Boolean(e.isMaster),
      isWhite: Boolean(e.isWhite),
    }
  }

  async ensureReady(e) {
    if (this.ready) return true
    const reason = this.initError?.message
      ? `：${this.initError.message}`
      : ""
    await e.reply(`大富翁模块尚未就绪${reason}`)
    return false
  }

  async buildBoardSegment(result) {
    if (!result.renderBoard) return null
    try {
      return Segment.image(
        await renderBoard(result.state, this.map, { events: result.events })
      )
    } catch (error) {
      logger.error(
        `[大富翁] 群 ${result.groupId} 棋盘渲染失败：${error.stack || error}`
      )
      return null
    }
  }

  async sendResult(e, result) {
    if (!result) return
    const board = await this.buildBoardSegment(result)
    if (board) await e.reply([board])
    const prompt = buildTurnPrompt(result)
    if (prompt) {
      await e.reply([
        Segment.at(prompt.mentionUserId),
        Segment.text(`\n${prompt.text}`),
      ])
    }
  }

  async sendScheduledResult(result) {
    if (!result) return
    const selfId = Number(result.selfId) || result.selfId
    const groupId = Number(result.groupId) || result.groupId
    const bot = this.getBot(selfId)
    if (!bot) {
      logger.warn(
        `[大富翁] 账号 ${result.selfId} 当前离线，群 ${result.groupId} 的超时结果未能播报`
      )
      return
    }
    const board = await this.buildBoardSegment(result)
    if (board) await bot.sendGroupMsg(groupId, [board])
    const prompt = buildTurnPrompt(result)
    if (prompt) {
      await bot.sendGroupMsg(groupId, [
        Segment.at(prompt.mentionUserId),
        Segment.text(`\n${prompt.text}`),
      ])
    }
  }

  async handleScheduledTimeout(token) {
    if (!this.ready || !this.service) return
    const result = await this.service.handleTimeout(token)
    if (result) await this.sendScheduledResult(result)
  }

  async execute(e, callback) {
    if (!(await this.ensureReady(e))) return true
    try {
      const result = await callback()
      if (result) await this.sendResult(e, result)
      return true
    } catch (error) {
      if (error instanceof GameRuleError) {
        try {
          const result = await this.service.status(this.contextFromEvent(e))
          result.events = [
            { type: "rule_error", message: error.message },
          ]
          await this.sendResult(e, result)
        } catch {
          await e.reply(error.message)
        }
        return true
      }
      logger.error(`[大富翁] 指令执行失败：${error.stack || error}`)
      await e.reply("大富翁操作失败，状态没有被重复结算，请稍后再试。")
      return true
    }
  }

  async executeInGame(e, callback) {
    if (!this.ready || !this.service) return false
    const context = this.contextFromEvent(e)
    if (!(await this.service.hasSession(context))) return false
    return this.execute(e, callback)
  }

  deadlineSweep = Cron("*/5 * * * * *", async () => {
    if (!this.ready || !this.service) return
    const selfId = getCurrentBotSelfId()
    if (selfId == null) return
    try {
      const results = await this.service.sweep(selfId)
      for (const result of results) {
        await this.sendScheduledResult(result)
      }
    } catch (error) {
      if (error instanceof GameRuleError && error.code === "GAME_BUSY") return
      logger.error(`[大富翁] 截止时间扫描失败：${error.stack || error}`)
    }
  })

  createGame = Command(COMMAND_PATTERNS.createGame, async (e) =>
    this.execute(e, () =>
      this.service.createGame(this.contextFromEvent(e))
    )
  )

  joinGame = Command(COMMAND_PATTERNS.joinGame, async (e) =>
    this.executeInGame(e, () =>
      this.service.joinGame(this.contextFromEvent(e))
    )
  )

  leaveLobby = Command(COMMAND_PATTERNS.leaveLobby, async (e) =>
    this.executeInGame(e, () =>
      this.service.leaveLobby(this.contextFromEvent(e))
    )
  )

  startGame = Command(COMMAND_PATTERNS.startGame, async (e) =>
    this.executeInGame(e, () =>
      this.service.startGame(this.contextFromEvent(e))
    )
  )

  roll = Command(COMMAND_PATTERNS.roll, async (e) =>
    this.executeInGame(e, () => this.service.roll(this.contextFromEvent(e)))
  )

  purchase = Command(COMMAND_PATTERNS.purchase, async (e) =>
    this.executeInGame(e, () =>
      this.service.decide(
        this.contextFromEvent(e),
        DECISIONS.PURCHASE
      )
    )
  )

  build = Command(COMMAND_PATTERNS.build, async (e) =>
    this.executeInGame(e, () =>
      this.service.build(this.contextFromEvent(e), e.match[1])
    )
  )

  sellBuilding = Command(COMMAND_PATTERNS.sellBuilding, async (e) =>
    this.executeInGame(e, () =>
      this.service.sellBuilding(this.contextFromEvent(e), e.match[1])
    )
  )

  mortgage = Command(COMMAND_PATTERNS.mortgage, async (e) =>
    this.executeInGame(e, () =>
      this.service.mortgage(this.contextFromEvent(e), e.match[1])
    )
  )

  redeem = Command(COMMAND_PATTERNS.redeem, async (e) =>
    this.executeInGame(e, () =>
      this.service.redeem(this.contextFromEvent(e), e.match[1])
    )
  )

  resolveDebt = Command(COMMAND_PATTERNS.resolveDebt, async (e) =>
    this.executeInGame(e, () =>
      this.service.resolveDebt(this.contextFromEvent(e))
    )
  )

  decline = Command(COMMAND_PATTERNS.decline, async (e) =>
    this.executeInGame(e, () =>
      this.service.decide(
        this.contextFromEvent(e),
        DECISIONS.DECLINE
      )
    )
  )

  surrender = Command(COMMAND_PATTERNS.surrender, async (e) =>
    this.executeInGame(e, () =>
      this.service.surrender(this.contextFromEvent(e))
    )
  )

  status = Command(COMMAND_PATTERNS.status, async (e) =>
    this.executeInGame(e, () =>
      this.service.status(this.contextFromEvent(e))
    )
  )

  help = Command(COMMAND_PATTERNS.help, async (e) => {
    return this.executeInGame(e, async () => {
      const result = await this.service.status(this.contextFromEvent(e))
      result.events = [{ type: "rules_requested" }]
      return result
    })
  })

  forceEnd = Command(COMMAND_PATTERNS.forceEnd, async (e) =>
    this.executeInGame(e, () =>
      this.service.forceEnd(this.contextFromEvent(e))
    )
  )
}
