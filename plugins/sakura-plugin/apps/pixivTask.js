import Setting from "../lib/setting.js"
import { getBot, getCurrentBotSelfId } from "../../../src/api/client.js"
import { getRankingOverview, buildRankingForwardParams } from "../lib/pixiv/ranking.js"
import {
  searchTagSubscription,
  searchArtistSubscription,
  markAsSent,
  isAlreadySent,
  getIllustImageUrls,
  buildIllustInfoText
} from "../lib/pixiv/subscription.js"
import { sendPixivImages } from "../lib/pixiv/sendImages.js"
import { isUgoira } from "../lib/pixiv/ugoira.js"

function getTaskBot() {
  const selfId = getCurrentBotSelfId()
  return selfId == null ? null : getBot(selfId)
}

function formatDuration(ms) {
  const sec = Math.round(ms / 1000)
  return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`
}

/**
 * 订阅检查每轮只在 info 级别打一行汇总，逐个标签/画师的明细在 debug 级别。
 * 有出错时整行升为 warn，并带上最近一次的错误。
 */
function logRunSummary(logTag, parts, errors) {
  const text = `${logTag} 检查完成：${parts.filter(Boolean).join('，')}`
  if (errors.length === 0) {
    logger.info(text)
  } else {
    logger.warn(`${text}，出错 ${errors.length} 次（最近一次：${errors[errors.length - 1]}）`)
  }
}

export class PixivTask extends plugin {
  constructor() {
    super({
      name: "pixiv定时任务",
      event: "message",
      priority: 1135,
    })
  }

  get appconfig() {
    return Setting.getConfig("pixiv")
  }

  get r18Config() {
    return Setting.getConfig("r18")
  }


  subscribeTag = Command(/^#?订阅标签\s*(.+)$/, async (e) => {
    if (!(e.isMaster || e.isAdmin)) {
      return false
    }

    const match = e.msg.match(/^#?订阅标签\s*(.+)$/)
    if (!match) return false

    const tag = match[1].trim()
    if (!tag) {
      return e.reply("请输入要订阅的标签，例如：#订阅标签 白毛", 10)
    }

    const config = this.appconfig
    const groupId = Number(e.group_id)


    let tagSubscriptions = config.tagSubscriptions || []

    let groupSub = tagSubscriptions.find(s => s.groupId === groupId)

    if (!groupSub) {

      groupSub = { groupId, tags: [] }
      tagSubscriptions.push(groupSub)
    }


    if (groupSub.tags.includes(tag)) {
      return e.reply(`本群已订阅标签「${tag}」，无需重复订阅~`, 10, true)
    }


    groupSub.tags.push(tag)

    Setting.setConfig("pixiv", { ...config, tagSubscriptions })

    return e.reply(`✅ 成功订阅标签「${tag}」`, 10)
  });


  unsubscribeTag = Command(/^#?取消订阅标签\s*(.+)$/, async (e) => {
    if (!(e.isMaster || e.isAdmin)) {
      return false
    }
    const match = e.msg.match(/^#?取消订阅标签\s*(.+)$/)
    if (!match) return false

    const tag = match[1].trim()
    const config = this.appconfig
    const groupId = Number(e.group_id)

    let tagSubscriptions = config.tagSubscriptions || []


    const groupSub = tagSubscriptions.find(s => s.groupId === groupId)

    if (!groupSub || !groupSub.tags.includes(tag)) {
      return e.reply(`本群未订阅标签「${tag}」`, 10)
    }

    groupSub.tags = groupSub.tags.filter(t => t !== tag)


    if (groupSub.tags.length === 0) {
      tagSubscriptions = tagSubscriptions.filter(s => s.groupId !== groupId)
    }

    Setting.setConfig("pixiv", { ...config, tagSubscriptions })
    return e.reply(`✅ 已取消订阅标签「${tag}」`, 10)
  });


  subscribeArtist = Command(/^#?订阅画师\s*(\d+)$/, async (e) => {
    if (!(e.isMaster || e.isAdmin)) {
      return false
    }

    const match = e.msg.match(/^#?订阅画师\s*(\d+)$/)
    if (!match) return false
    const artistId = match[1].trim()
    const config = this.appconfig
    const groupId = Number(e.group_id)

    let artistSubscriptions = config.artistSubscriptions || []


    let groupSub = artistSubscriptions.find(s => s.groupId === groupId)

    if (!groupSub) {
      groupSub = { groupId, artistIds: [] }
      artistSubscriptions.push(groupSub)
    }

    if (groupSub.artistIds.includes(artistId)) {
      return e.reply(`本群已订阅画师「${artistId}」，无需重复订阅~`, 10)
    }

    groupSub.artistIds.push(artistId)
    Setting.setConfig("pixiv", { ...config, artistSubscriptions })

    return e.reply(`✅ 成功订阅画师「${artistId}」`, 10)
  });


  unsubscribeArtist = Command(/^#?取消订阅画师\s*(\d+)$/, async (e) => {
    if (!(e.isMaster || e.isAdmin)) {
      return false
    }

    const match = e.msg.match(/^#?取消订阅画师\s*(\d+)$/)
    if (!match) return false

    const artistId = match[1].trim()
    const config = this.appconfig
    const groupId = Number(e.group_id)
    let artistSubscriptions = config.artistSubscriptions || []


    const groupSub = artistSubscriptions.find(s => s.groupId === groupId)

    if (!groupSub || !groupSub.artistIds.includes(artistId)) {
      return e.reply(`本群未订阅画师「${artistId}」`, 10)
    }

    groupSub.artistIds = groupSub.artistIds.filter(a => a !== artistId)

    if (groupSub.artistIds.length === 0) {
      artistSubscriptions = artistSubscriptions.filter(s => s.groupId !== groupId)
    }
    Setting.setConfig("pixiv", { ...config, artistSubscriptions })

    return e.reply(`✅ 已取消订阅画师「${artistId}」`, 10)
  });


  listSubscriptions = Command(/^#?订阅列表$/, async (e) => {
    const config = this.appconfig
    const groupId = Number(e.group_id)


    const tagSubConfig = (config.tagSubscriptions || []).find(s => s.groupId === groupId)
    const artistSubConfig = (config.artistSubscriptions || []).find(s => s.groupId === groupId)

    const tagSubs = tagSubConfig?.tags || []
    const artistSubs = artistSubConfig?.artistIds || []

    if (tagSubs.length === 0 && artistSubs.length === 0) {
      return e.reply("本群暂无任何P站订阅~", 10)
    }
    let msg = "📋 本群P站订阅列表：\n"

    if (tagSubs.length > 0) {
      msg += "\n🏷️ 标签订阅：\n"
      tagSubs.forEach((tag, i) => {
        msg += `  ${i + 1}. ${tag}\n`
      })
    }

    if (artistSubs.length > 0) {
      msg += "\n🎨 画师订阅：\n"
      artistSubs.forEach((id, i) => {
        msg += `  ${i + 1}. ${id}\n`
      })
    }

    return e.sendForwardMsg(msg.trim(), {
      prompt: "本群P站订阅列表",
      source: "Pixiv订阅",
      news: [
        { text: `🏷️ 标签订阅：${tagSubs.length}个` },
        { text: `🎨 画师订阅：${artistSubs.length}个` }
      ]
    })
  });




  tagSubscriptionTask = Cron("*/30 * * * *", async () => {
    const taskBot = getTaskBot()
    if (!taskBot) return

    const config = this.appconfig
    const tagSubscriptions = config.tagSubscriptions || []
    if (tagSubscriptions.length === 0) {
      logger.debug("[标签订阅定时] 无订阅，跳过")
      return
    }

    if (!config.cookie || !config.refresh_token) {
      logger.warn("[标签订阅定时] 未配置 Pixiv Cookie 或 RefreshToken，跳过")
      return
    }

    const subConfig = {
      maxPages: config.tagSubMaxPages || 5,
      freshnessPeriod: config.tagSubFreshnessPeriod || 86400,
      minBookmark: config.tagSubMinBookmark || 300,
      minBookRate: config.tagSubMinBookRate || 0.09,
      minBookPerHour: config.tagSubMinBookPerHour || 50,
    }

    const tagToGroups = new Map()
    for (const groupSub of tagSubscriptions) {
      const groupId = String(groupSub.groupId)
      for (const tag of (groupSub.tags || [])) {
        if (!tagToGroups.has(tag)) tagToGroups.set(tag, [])
        tagToGroups.get(tag).push(groupId)
      }
    }

    const startedAt = Date.now()
    const stats = { fetched: 0, skippedRejected: 0, pushed: 0, deferred: 0, errors: [] }

    for (const [tag, groupIds] of tagToGroups.entries()) {
      try {
        const isR18Enabled = groupIds.some(gid => this.r18Config.Groups?.includes(Number(gid)))
        const result = await searchTagSubscription(tag, groupIds, config, subConfig, isR18Enabled)
        stats.fetched += result.fetched
        stats.skippedRejected += result.skippedRejected
        stats.errors.push(...result.errors)
        logger.debug(`[标签订阅定时] 标签「${tag}」拉取详情 ${result.fetched} 个，跳过近期未达标 ${result.skippedRejected} 个，符合条件 ${result.illusts.length} 个`)

        if (result.illusts.length === 0) {
          continue
        }

        const sent = await this.distributeSubscriptionIllusts(taskBot, result.illusts, groupIds, {
          name: tag,
          type: 'tag',
          sentTtl: subConfig.freshnessPeriod,
          maxPerGroup: this.subMaxPushPerRun,
          logTag: '[标签订阅定时]',
        })
        stats.pushed += sent.pushed
        stats.deferred += sent.deferred
        stats.errors.push(...sent.errors)
      } catch (err) {
        stats.errors.push(`标签「${tag}」: ${err.message}`)
        logger.debug(`[标签订阅定时] 处理标签「${tag}」失败: ${err.stack || err.message}`)
      }

      await new Promise(resolve => setTimeout(resolve, 5000))
    }

    logRunSummary('[标签订阅定时]', [
      `${tagToGroups.size} 个标签`,
      `拉取详情 ${stats.fetched} 个`,
      `跳过近期未达标 ${stats.skippedRejected} 个`,
      `推送 ${stats.pushed} 次`,
      stats.deferred > 0 && `顺延 ${stats.deferred} 次`,
      `耗时 ${formatDuration(Date.now() - startedAt)}`,
    ], stats.errors)
  });


  artistSubscriptionTask = Cron("10 * * * *", async () => {
    const taskBot = getTaskBot()
    if (!taskBot) return

    const config = this.appconfig
    const artistSubscriptions = config.artistSubscriptions || []
    if (artistSubscriptions.length === 0) {
      logger.debug("[画师订阅定时] 无订阅，跳过")
      return
    }

    if (!config.cookie || !config.refresh_token) {
      logger.warn("[画师订阅定时] 未配置 Pixiv Cookie 或 RefreshToken，跳过")
      return
    }

    const subConfig = {
      freshnessPeriod: config.artistSubFreshnessPeriod || 43200,
    }

    const artistToGroups = new Map()
    for (const groupSub of artistSubscriptions) {
      const groupId = String(groupSub.groupId)
      for (const artistId of (groupSub.artistIds || [])) {
        if (!artistToGroups.has(artistId)) artistToGroups.set(artistId, [])
        artistToGroups.get(artistId).push(groupId)
      }
    }

    const startedAt = Date.now()
    const stats = { fetched: 0, pushed: 0, deferred: 0, errors: [] }

    for (const [artistId, groupIds] of artistToGroups.entries()) {
      try {
        const result = await searchArtistSubscription(artistId, groupIds, config, subConfig)
        stats.fetched += result.fetched
        stats.errors.push(...result.errors)
        logger.debug(`[画师订阅定时] 画师「${artistId}」拉取详情 ${result.fetched} 个，新作品 ${result.illusts.length} 个`)

        if (result.illusts.length === 0) {
          continue
        }

        const sent = await this.distributeSubscriptionIllusts(taskBot, result.illusts, groupIds, {
          name: artistId,
          type: 'artist',
          // 已发送标记要比保质期活得久，否则保质期内会重复推送
          sentTtl: Math.max(86400, subConfig.freshnessPeriod),
          maxPerGroup: this.subMaxPushPerRun,
          logTag: '[画师订阅定时]',
        })
        stats.pushed += sent.pushed
        stats.deferred += sent.deferred
        stats.errors.push(...sent.errors)
      } catch (err) {
        stats.errors.push(`画师「${artistId}」: ${err.message}`)
        logger.debug(`[画师订阅定时] 处理画师「${artistId}」失败: ${err.stack || err.message}`)
      }

      await new Promise(resolve => setTimeout(resolve, 5000))
    }

    logRunSummary('[画师订阅定时]', [
      `${artistToGroups.size} 位画师`,
      `拉取详情 ${stats.fetched} 个`,
      `推送 ${stats.pushed} 次`,
      stats.deferred > 0 && `顺延 ${stats.deferred} 次`,
      `耗时 ${formatDuration(Date.now() - startedAt)}`,
    ], stats.errors)
  });

  get subMaxPushPerRun() {
    return Math.max(1, Math.floor(Number(this.appconfig.subMaxPushPerRun)) || 3)
  }

  /**
   * 把订阅找到的作品分发到各群。
   * 按发布时间从早到晚推，每个群每轮最多推 maxPerGroup 个；
   * 没轮到的不标记已发送，下一轮还会被找出来，过了保质期就不再推。
   * @returns {Promise<{pushed: number, deferred: number, errors: string[]}>}
   */
  async distributeSubscriptionIllusts(taskBot, illusts, groupIds, { name, type, sentTtl, maxPerGroup, logTag }) {
    const ordered = [...illusts].sort((a, b) => new Date(a.create_date) - new Date(b.create_date))
    const pushedCount = new Map()
    const deferredCount = new Map()
    const errors = []

    for (const illust of ordered) {
      let sentToAny = false
      for (const groupId of groupIds) {
        try {
          if (await isAlreadySent(groupId, illust.id, type)) continue

          if ((pushedCount.get(groupId) || 0) >= maxPerGroup) {
            deferredCount.set(groupId, (deferredCount.get(groupId) || 0) + 1)
            continue
          }

          const pushed = await this.sendSubscriptionIllust(taskBot, groupId, illust, name, type)
          await markAsSent(groupId, illust.id, type, sentTtl)
          if (pushed) {
            pushedCount.set(groupId, (pushedCount.get(groupId) || 0) + 1)
            sentToAny = true
          }
        } catch (err) {
          errors.push(`向群 ${groupId} 推送「${name}」的作品 ${illust.id}: ${err.message}`)
          logger.debug(`${logTag} 向群 ${groupId} 推送「${name}」的作品 ${illust.id} 失败: ${err.message}`)
        }
      }

      if (sentToAny) {
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }

    let deferred = 0
    for (const [groupId, count] of deferredCount) {
      deferred += count
      logger.debug(`${logTag} 群 ${groupId} 本轮已推满 ${maxPerGroup} 个「${name}」作品，剩余 ${count} 个顺延到下一轮`)
    }

    let pushed = 0
    for (const count of pushedCount.values()) pushed += count

    return { pushed, deferred, errors }
  }

  /**
   * @returns {Promise<boolean>} 是否真的推送了（R18 不允许或无图时返回 false）
   */
  async sendSubscriptionIllust(taskBot, groupId, illust, subscriptionName, type) {
    const config = this.appconfig
    const isR18 = illust.x_restrict !== 0


    if (isR18 && !this.r18Config.Groups?.includes(Number(groupId))) {
      logger.debug(`[订阅推送] 群 ${groupId} 未开启R18，跳过作品 ${illust.id}`)
      return false
    }

    const imageUrls = getIllustImageUrls(illust, "", 3)

    if (imageUrls.length === 0) {
      logger.warn(`[订阅推送] 作品 ${illust.id} 无图片链接`)
      return false
    }

    const typeLabel = type === 'tag' ? '标签' : '画师'
    const infoText = buildIllustInfoText(illust)
    const newsText = `🔔「${subscriptionName}」有新作品`

    const msgNodes = [
      {
        type: "node",
        data: {
          user_id: taskBot.self_id,
          nickname: taskBot.nickname || "Pixiv小助手",
          content: infoText,
        },
      }
    ]

    await taskBot.sendForwardMsg({
      messages: msgNodes,
      group_id: Number(groupId),
      prompt: `🔔 有新作品更新`,
      source: `Pixiv${typeLabel}订阅`,
      news: [{ text: newsText }]
    })


    await sendPixivImages({
      bot: taskBot,
      self_id: taskBot.self_id,
      group_id: groupId,
      reply: async (message, recall = 0) => {
        const result = await taskBot.sendGroupMsg(groupId, message)
        if (recall > 0 && result?.message_id) {
          setTimeout(() => {
            taskBot.deleteMsg(result.message_id).catch(() => { })
          }, recall * 1000)
        }
        return result
      },
    }, {
      imageUrls,
      proxy: config.proxy,
      fallbackLinkProxy: config.fallbackLinkProxy,
      pid: illust.id,
      ugoira: isUgoira(illust),
      initialRecallTime: isR18 ? (config.recallTime ?? 10) : 0,
      fallbackRecallTime: config.recallTime ?? 10,
    })
    return true
  }



  weeklyRankingTask = Cron("5 11 * * 0", async () => {
    const taskBot = getTaskBot()
    if (!taskBot) return

    const config = this.appconfig
    if (!config.cookie || !config.refresh_token) {
      logger.warn("[P站排行榜定时] 未配置 Pixiv Cookie 或 RefreshToken，跳过推送")
      return
    }

    const pushGroups = config.rankingPushGroups ?? []
    if (pushGroups.length === 0) {
      logger.info("[P站排行榜定时] 未配置推送群，跳过")
      return
    }

    logger.info(`[P站排行榜定时] 开始推送周榜到 ${pushGroups.length} 个群...`)

    try {
      const result = await getRankingOverview("周榜")
      if (!result.images || result.images.length === 0) {
        logger.warn("[P站排行榜定时] 周榜无数据，跳过推送")
        return
      }

      for (const groupId of pushGroups) {

        try {
          const { nodes, prompt, news, source } = buildRankingForwardParams(result, "周榜", taskBot.self_id)
          await taskBot.sendGroupMsg(groupId, "周末愉快！来点P站周榜精选")
          const msgNodes = nodes.map(n => ({
            type: "node",
            data: {
              user_id: n.user_id ?? taskBot.self_id,
              nickname: n.nickname ?? "P站排行榜",
              content: Array.isArray(n.content)
                ? n.content
                : typeof n.content === "object" && n.content?.type
                  ? [n.content]
                  : [{ type: "text", data: { text: String(n.content) } }],
            },
          }))

          await taskBot.sendForwardMsg({
            messages: msgNodes,
            group_id: Number(groupId),
            prompt,
            news,
            source,
          })

          logger.info(`[P站排行榜定时] 已推送周榜到群 ${groupId}`)

          await new Promise(resolve => setTimeout(resolve, 1500))
        } catch (err) {
          logger.error(`[P站排行榜定时] 推送群 ${groupId} 失败: ${err.message}`)
        }
      }
    } catch (error) {
      logger.error(`[P站排行榜定时] 获取日榜失败: ${error.message}`)
    }
  })
}
