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
import { MapLoader } from "../lib/monopoly/map/MapLoader.js"
import { MonopolySessionStore } from "../lib/monopoly/SessionStore.js"
import { TimeoutScheduler } from "../lib/monopoly/TimeoutScheduler.js"
import { renderBoard } from "../lib/monopoly/presentation/BoardRenderer.js"
import {
  buildHelpText,
  formatResult,
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
      this.map = await new MapLoader().load("default-24")
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

  async buildSegments(result) {
    const formatted = formatResult(result, this.map)
    const segments = []
    if (formatted.mentionUserId) {
      segments.push(Segment.at(formatted.mentionUserId))
      segments.push(Segment.text(`\n${formatted.text}`))
    } else {
      segments.push(Segment.text(formatted.text))
    }

    if (result.renderBoard) {
      try {
        segments.push(Segment.image(renderBoard(result.state, this.map)))
      } catch (error) {
        logger.error(
          `[大富翁] 群 ${result.groupId} 棋盘渲染失败：${error.stack || error}`
        )
        segments.push(
          Segment.text("\n（棋盘图片生成失败，游戏状态已经正常保存。）")
        )
      }
    }
    return segments
  }

  async sendResult(e, result) {
    if (!result) return
    await e.reply(await this.buildSegments(result))
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
    await bot.sendGroupMsg(groupId, await this.buildSegments(result))
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
        await e.reply(error.message)
        return true
      }
      logger.error(`[大富翁] 指令执行失败：${error.stack || error}`)
      await e.reply("大富翁操作失败，状态没有被重复结算，请稍后再试。")
      return true
    }
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

  createGame = Command(/^#创建大富翁$/, async (e) =>
    this.execute(e, () =>
      this.service.createGame(this.contextFromEvent(e))
    )
  )

  joinGame = Command(/^#加入大富翁$/, async (e) =>
    this.execute(e, () =>
      this.service.joinGame(this.contextFromEvent(e))
    )
  )

  leaveLobby = Command(/^#退出大富翁$/, async (e) =>
    this.execute(e, () =>
      this.service.leaveLobby(this.contextFromEvent(e))
    )
  )

  startGame = Command(/^#开始大富翁$/, async (e) =>
    this.execute(e, () =>
      this.service.startGame(this.contextFromEvent(e))
    )
  )

  roll = Command(/^#掷骰$/, async (e) =>
    this.execute(e, () => this.service.roll(this.contextFromEvent(e)))
  )

  purchase = Command(/^#购买$/, async (e) =>
    this.execute(e, () =>
      this.service.decide(
        this.contextFromEvent(e),
        DECISIONS.PURCHASE
      )
    )
  )

  upgrade = Command(/^#升级$/, async (e) =>
    this.execute(e, () =>
      this.service.decide(
        this.contextFromEvent(e),
        DECISIONS.UPGRADE
      )
    )
  )

  decline = Command(/^#放弃$/, async (e) =>
    this.execute(e, () =>
      this.service.decide(
        this.contextFromEvent(e),
        DECISIONS.DECLINE
      )
    )
  )

  surrender = Command(/^#认输$/, async (e) =>
    this.execute(e, () =>
      this.service.surrender(this.contextFromEvent(e))
    )
  )

  status = Command(/^#(?:大富翁|大富翁状态|查看大富翁|大富翁地图)$/, async (e) =>
    this.execute(e, () =>
      this.service.status(this.contextFromEvent(e))
    )
  )

  help = Command(/^#大富翁规则$/, async (e) => {
    if (!(await this.ensureReady(e))) return true
    await e.reply(buildHelpText(this.map))
    return true
  })

  forceEnd = Command(/^#结束大富翁$/, async (e) =>
    this.execute(e, () =>
      this.service.forceEnd(this.contextFromEvent(e))
    )
  )
}
