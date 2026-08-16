/**
 * 战斗图片的对外门面。
 *
 * 五类图（战场图 / 角色卡 / 攻略页 / 图鉴卡 / 图鉴总览）全部由浏览器渲染，
 * 本文件只负责缓存与调度：
 *   模板  battleHtml.js（战场）、cardHtml.js（角色卡 + 攻略页）、rosterHtml.js（图鉴总览）
 *   截图  browser.js（常驻 Chromium 单例）
 *   素材  htmlAssets.js（立绘 / Q版 / 头像转 base64 内嵌）
 *
 * 角色卡、攻略页与图鉴总览按内容缓存 Promise —— 同一角色多次请求只渲染一次；
 * 战场图每回合都不同，不缓存。
 */
import { ROSTER } from "./roster.js"
import { buildBattleHtml, MAP_WIDTH, MAP_HEIGHT } from "./battleHtml.js"
import {
  buildCardHtml, buildGuideHtml, guidePages,
  CARD_WIDTH, CARD_HEIGHT, GUIDE_WIDTH, GUIDE_HEIGHT,
} from "./cardHtml.js"
import { buildRosterGridHtml, GRID_WIDTH, GRID_VIEWPORT_HEIGHT } from "./rosterHtml.js"
import { shotHtml } from "./browser.js"

class BaBattleImageGenerator {
  constructor() {
    this.cardCache = new Map()
    this.guidePageCache = null
    this.rosterGridCache = null
  }

  /** 战场图：每回合结算后发一张，内容每次都变，不缓存 */
  async generateBattleMap(state, options = {}) {
    return shotHtml(buildBattleHtml(state, options.events || []), {
      width: MAP_WIDTH, height: MAP_HEIGHT, selector: "#map",
    })
  }

  async generateCharacterCard(tmpl) {
    if (!this.cardCache.has(tmpl.id)) {
      this.cardCache.set(tmpl.id, shotHtml(buildCardHtml(tmpl), {
        width: CARD_WIDTH, height: CARD_HEIGHT, selector: "#card",
      }))
    }
    return this.cardCache.get(tmpl.id)
  }

  async generateGuidePages() {
    if (!this.guidePageCache) {
      const pages = guidePages()
      this.guidePageCache = Promise.all(pages.map((page, index) =>
        shotHtml(buildGuideHtml(page, index, pages.length), {
          width: GUIDE_WIDTH, height: GUIDE_HEIGHT, selector: "#guide",
        })
      ))
    }
    return this.guidePageCache
  }

  /**
   * 图鉴总览：全员一张图，作为图鉴合并转发的第一条。
   * 角色表不变就一直是同一张，开局要发给双方，缓存能省掉一次渲染。
   */
  async generateRosterGrid() {
    if (!this.rosterGridCache) {
      // 失败别把 rejected promise 留在缓存里：Chromium 抽一次风就再也发不出图了
      this.rosterGridCache = shotHtml(buildRosterGridHtml(), {
        width: GRID_WIDTH, height: GRID_VIEWPORT_HEIGHT, selector: "#roster",
      }).catch((error) => {
        this.rosterGridCache = null
        throw error
      })
    }
    return this.rosterGridCache
  }

  /** 全体角色卡，配队前发一次图鉴 */
  async generateRosterCards() {
    return Promise.all(ROSTER.map((tmpl) => this.generateCharacterCard(tmpl)))
  }

  /** 角色表变动后调用，清掉旧图 */
  clearCache() {
    this.cardCache.clear()
    this.guidePageCache = null
    this.rosterGridCache = null
  }
}

export const baBattleImageGenerator = new BaBattleImageGenerator()
