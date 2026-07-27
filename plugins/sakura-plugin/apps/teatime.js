import Setting from "../lib/setting.js"
import { isCronDue } from "../lib/cron.js"
import _ from "lodash"
import { getCurrentBotSelfId } from "../../../src/api/client.js"

// 用 konachan.net 而非 .com：后者被 Cloudflare 拦在 403（TLS 指纹级别，
// 伪造 UA 无效），原先正是为此才要走 puppeteer-real-browser。
// .net 是同一套数据库的 SFW 镜像，裸 fetch 即可。
const IMAGE_API = "https://konachan.net/post.json?tags=loli+-rating:e+-nipples&limit=500"

export class teatime extends plugin {
  constructor() {
    super({
      name: "teatime",
      priority: 1135,
    })
  }

  teatimeTask = Cron("* * * * *", async (fireDate) => {
    const config = Setting.getConfig("teatime")
    const cronExpression = String(config?.cron || "0 15 * * *").trim()
    if (!isCronDue(cronExpression, fireDate)) {
      return
    }

    const selfId = getCurrentBotSelfId()
    if (selfId == null) {
      logger.warn("[teatime] 触发定时任务时没有在线账号，已跳过本次推送")
      return
    }

    await this.runForSelf(selfId)
  })

  async runForSelf(selfId) {
    const config = Setting.getConfig("teatime", { selfId })
    const groups = Array.isArray(config?.Groups) ? config.Groups : []
    if (!groups.length) {
      return
    }

    const currentBot = this.getBot(selfId)
    if (!currentBot) {
      return
    }

    // 各群拿的是同一份数据，拉一次即可；随机性来自每群各自的 sampleSize
    let imageUrls
    try {
      const response = await fetch(IMAGE_API)
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }
      const jsonData = await response.json()
      if (!Array.isArray(jsonData) || jsonData.length === 0) {
        logger.error("[teatime]获取到 API 数据，但数据为空或格式不正确。", jsonData)
        return
      }
      imageUrls = jsonData.map(item => item?.file_url).filter(url => url)
    } catch (error) {
      logger.error("[teatime]获取图片列表失败:", error)
      return
    }

    if (!imageUrls.length) {
      logger.warn("[teatime]获取到的图片URL列表为空。")
      return
    }

    // 取图成功后才发问候语，避免只发了一句话却没有下文
    for (const groupId of groups) {
      await currentBot.pickGroup(groupId).sendMsg("下午茶时间到，来点萝莉")

      for (const imageUrl of _.sampleSize(imageUrls, 5)) {
        try {
          await currentBot.pickGroup(groupId).sendMsg(segment.image(imageUrl))
          await new Promise(resolve => setTimeout(resolve, 1000))
        } catch (sendError) {
          logger.error(`[teatime]向群 ${groupId} 发送图片消息失败: ${imageUrl}`, sendError)
        }
      }
    }
  }
}
