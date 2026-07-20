import { createCanvas, loadImage } from "@napi-rs/canvas"
import fs from "node:fs"
import path from "node:path"
import EconomyImageGenerator from "./ImageGenerator.js"
import { pluginresources } from "../path.js"

const CANVAS_WIDTH = 1000
const FONT_FAMILY = 'ZhuZiAYuan, "MotoyaMaru", "Noto Color Emoji", "Segoe UI Emoji", "Noto Sans SC", sans-serif'
const COLORS = Object.freeze({
  text: "#523B49",
  secondary: "#806575",
  muted: "#A78E9C",
  accent: "#E05C91",
  accentDark: "#B83E70",
  accentSoft: "rgba(255, 224, 237, 0.92)",
  panel: "rgba(255, 255, 255, 0.9)",
  panelSoft: "rgba(255, 248, 252, 0.88)",
  border: "rgba(219, 112, 147, 0.24)",
  success: "#4E9B68",
  warning: "#D58936",
  danger: "#C84B5A",
})

const HANDLER_META = Object.freeze({
  fishing_rod: { icon: "🎣", label: "鱼竿", color: "#D88944" },
  fishing_line: { icon: "🧵", label: "鱼线", color: "#5B91C9" },
  fishing_bait: { icon: "🪱", label: "鱼饵", color: "#62A26F" },
  fishing_torpedo: { icon: "💣", label: "鱼雷", color: "#C45663" },
  fishing_special: { icon: "✨", label: "特殊物品", color: "#A86BC3" },
  fishing_chest: { icon: "🗝️", label: "钓点宝箱", color: "#C38B3D" },
})

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function chunk(items, size) {
  const pages = []
  for (let index = 0; index < items.length; index += size) {
    pages.push(items.slice(index, index + size))
  }
  return pages
}

export default class FishingUiImageGenerator extends EconomyImageGenerator {
  constructor() {
    super()
    this.width = CANVAS_WIDTH
    this.fontFamily = FONT_FAMILY
    this.itemImagePath = path.join(pluginresources, "fish", "img")
    this.imageCache = new Map()
    this.remoteImageCache = new Map()
  }

  formatNumber(value) {
    return Math.trunc(toFiniteNumber(value)).toLocaleString("zh-CN")
  }

  createBaseCanvas(height) {
    const canvas = createCanvas(this.width, height)
    const ctx = canvas.getContext("2d")
    this.drawSakuraBackground(ctx, this.width, height)

    const glow = ctx.createRadialGradient(850, 60, 10, 850, 60, 420)
    glow.addColorStop(0, "rgba(255, 255, 255, 0.72)")
    glow.addColorStop(1, "rgba(255, 255, 255, 0)")
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, this.width, Math.min(height, 520))
    return { canvas, ctx }
  }

  drawPanel(ctx, x, y, width, height, options = {}) {
    const {
      fill = COLORS.panel,
      border = COLORS.border,
      radius = 22,
      shadow = true,
      lineWidth = 1.5,
    } = options
    ctx.save()
    if (shadow) {
      ctx.shadowColor = "rgba(112, 64, 88, 0.12)"
      ctx.shadowBlur = 18
      ctx.shadowOffsetY = 6
    }
    ctx.fillStyle = fill
    this.drawRoundedRect(ctx, x, y, width, height, radius)
    ctx.fill()
    ctx.shadowColor = "transparent"
    if (border) {
      ctx.strokeStyle = border
      ctx.lineWidth = lineWidth
      this.drawRoundedRect(ctx, x, y, width, height, radius)
      ctx.stroke()
    }
    ctx.restore()
  }

  drawPill(ctx, text, x, y, options = {}) {
    const {
      fontSize = 20,
      color = COLORS.accentDark,
      fill = COLORS.accentSoft,
      paddingX = 16,
      height = 38,
      align = "left",
    } = options
    ctx.save()
    ctx.font = `bold ${fontSize}px ${this.fontFamily}`
    const width = Math.ceil(ctx.measureText(String(text)).width) + paddingX * 2
    const left = align === "right" ? x - width : x
    ctx.fillStyle = fill
    this.drawRoundedRect(ctx, left, y, width, height, height / 2)
    ctx.fill()
    ctx.fillStyle = color
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(String(text), left + width / 2, y + height / 2 + 1)
    ctx.restore()
    return width
  }

  drawProgressBar(ctx, x, y, width, height, ratio, options = {}) {
    const safeRatio = Math.max(0, Math.min(1, toFiniteNumber(ratio)))
    const {
      background = "rgba(110, 82, 98, 0.12)",
      startColor = "#FF8DB5",
      endColor = "#D94E86",
    } = options
    ctx.save()
    ctx.fillStyle = background
    this.drawRoundedRect(ctx, x, y, width, height, height / 2)
    ctx.fill()
    if (safeRatio > 0) {
      const fillWidth = Math.max(height, width * safeRatio)
      const gradient = ctx.createLinearGradient(x, y, x + fillWidth, y)
      gradient.addColorStop(0, startColor)
      gradient.addColorStop(1, endColor)
      ctx.fillStyle = gradient
      this.drawRoundedRect(ctx, x, y, Math.min(width, fillWidth), height, height / 2)
      ctx.fill()
    }
    ctx.restore()
  }

  drawWrappedText(ctx, text, x, y, maxWidth, options = {}) {
    const {
      font = `18px ${this.fontFamily}`,
      color = COLORS.secondary,
      lineHeight = 25,
      maxLines = 2,
    } = options
    ctx.save()
    ctx.font = font
    ctx.fillStyle = color
    ctx.textAlign = "left"
    ctx.textBaseline = "alphabetic"

    const lines = []
    for (const rawLine of String(text || "").split("\n")) {
      lines.push(...this.wrapText(ctx, rawLine, maxWidth))
    }
    const visibleLines = lines.slice(0, maxLines)
    if (lines.length > maxLines && visibleLines.length > 0) {
      visibleLines[visibleLines.length - 1] = this.truncateText(
        ctx,
        `${visibleLines[visibleLines.length - 1]}…`,
        maxWidth,
      )
    }
    visibleLines.forEach((line, index) => {
      ctx.fillText(line, x, y + index * lineHeight)
    })
    ctx.restore()
    return visibleLines.length
  }

  async getItemImage(itemId) {
    if (!itemId) return null
    if (!this.imageCache.has(itemId)) {
      const imagePath = path.join(this.itemImagePath, `${itemId}.png`)
      const imagePromise = fs.existsSync(imagePath)
        ? loadImage(imagePath).catch(() => null)
        : Promise.resolve(null)
      this.imageCache.set(itemId, imagePromise)
    }
    return this.imageCache.get(itemId)
  }

  async getRemoteImage(url) {
    if (!url) return null
    if (!this.remoteImageCache.has(url)) {
      this.remoteImageCache.set(url, loadImage(url).catch(() => null))
    }
    return this.remoteImageCache.get(url)
  }

  async drawUserAvatar(ctx, url, x, y, size) {
    const image = await this.getRemoteImage(url)
    ctx.save()
    ctx.beginPath()
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2)
    ctx.closePath()
    ctx.clip()
    if (image) {
      ctx.drawImage(image, x, y, size, size)
    } else {
      const gradient = ctx.createLinearGradient(x, y, x + size, y + size)
      gradient.addColorStop(0, "#F7C5D8")
      gradient.addColorStop(1, "#E99AB9")
      ctx.fillStyle = gradient
      ctx.fillRect(x, y, size, size)
      ctx.fillStyle = "rgba(255, 255, 255, 0.9)"
      ctx.font = `bold ${Math.round(size * 0.42)}px ${this.fontFamily}`
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText("樱", x + size / 2, y + size / 2 + 2)
    }
    ctx.restore()
  }

  async drawItemImage(ctx, itemId, x, y, size, fallbackIcon = "🎁") {
    ctx.save()
    const gradient = ctx.createLinearGradient(x, y, x + size, y + size)
    gradient.addColorStop(0, "rgba(255, 244, 249, 0.96)")
    gradient.addColorStop(1, "rgba(244, 226, 237, 0.92)")
    ctx.fillStyle = gradient
    this.drawRoundedRect(ctx, x, y, size, size, 18)
    ctx.fill()

    const image = await this.getItemImage(itemId)
    if (image) {
      const inset = 8
      const available = size - inset * 2
      const scale = Math.min(available / image.width, available / image.height)
      const drawWidth = image.width * scale
      const drawHeight = image.height * scale
      const drawX = x + (size - drawWidth) / 2
      const drawY = y + (size - drawHeight) / 2
      ctx.save()
      this.drawRoundedRect(ctx, x, y, size, size, 18)
      ctx.clip()
      ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight)
      ctx.restore()
    } else {
      ctx.fillStyle = COLORS.muted
      ctx.font = `bold ${Math.round(size * 0.42)}px ${this.fontFamily}`
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText(fallbackIcon, x + size / 2, y + size / 2 + 2)
    }
    ctx.restore()
  }

  getShopItemDetail(item, handler) {
    if (handler === "fishing_rod" || handler === "fishing_line") {
      const durability = Math.max(0, Math.floor(toFiniteNumber(item.durability)))
      return durability > 0 ? `耐久 ${durability}` : "永久装备"
    }
    if (handler === "fishing_bait") {
      return item.boss_bait ? "首领挑战专用" : `品质 ${Math.max(1, Math.floor(toFiniteNumber(item.quality, 1)))}`
    }
    if (handler === "fishing_torpedo") {
      const hours = Math.max(1, Math.round(toFiniteNumber(item.duration, 86400) / 3600))
      return `投放有效期 ${hours} 小时`
    }
    return item.type === "equipment" ? "永久装备" : "消耗物品"
  }

  async generateShopPages({ nickname, balance, categories }) {
    const visibleCategories = (Array.isArray(categories) ? categories : [])
      .filter((category) => Array.isArray(category.items) && category.items.length > 0)
    const pages = []

    for (let pageIndex = 0; pageIndex < visibleCategories.length; pageIndex++) {
      const category = visibleCategories[pageIndex]
      const items = category.items
      const columns = 2
      const rows = Math.ceil(items.length / columns)
      const cardGap = 18
      const cardHeight = 200
      const cardWidth = (this.width - 72 - cardGap) / columns
      const cardsTop = 218
      const height = cardsTop + rows * cardHeight + Math.max(0, rows - 1) * cardGap + 72
      const { canvas, ctx } = this.createBaseCanvas(height)
      const meta = HANDLER_META[category.handler] || HANDLER_META.fishing_special
      const categoryTitle = String(category.name || `${meta.icon} ${meta.label}`)

      ctx.fillStyle = COLORS.text
      ctx.font = `bold 42px ${this.fontFamily}`
      ctx.fillText("樱神社商店", 40, 70)
      ctx.fillStyle = COLORS.secondary
      ctx.font = `20px ${this.fontFamily}`
      ctx.fillText(
        this.truncateText(ctx, `欢迎光临，${nickname || "旅人"}`, 570),
        42,
        105,
      )

      this.drawPanel(ctx, 665, 34, 295, 82, {
        fill: "rgba(255, 249, 226, 0.94)",
        border: "rgba(218, 169, 70, 0.32)",
        radius: 20,
      })
      ctx.fillStyle = "#9B6A25"
      ctx.font = `18px ${this.fontFamily}`
      ctx.fillText("当前持有", 690, 65)
      ctx.fillStyle = "#C17D17"
      ctx.font = `bold 28px ${this.fontFamily}`
      ctx.fillText(`${this.formatNumber(balance)} 樱花币`, 690, 98)

      ctx.fillStyle = meta.color
      ctx.font = `bold 30px ${this.fontFamily}`
      ctx.fillText(categoryTitle, 40, 158)
      ctx.fillStyle = COLORS.secondary
      ctx.font = `18px ${this.fontFamily}`
      ctx.fillText(
        this.truncateText(ctx, String(category.description || "挑选你需要的钓鱼用品"), 720),
        42,
        190,
      )
      this.drawPill(ctx, `${pageIndex + 1}/${visibleCategories.length}`, 960, 145, {
        align: "right",
        fontSize: 18,
        height: 34,
      })

      for (let index = 0; index < items.length; index++) {
        const item = items[index]
        const col = index % columns
        const row = Math.floor(index / columns)
        const x = 36 + col * (cardWidth + cardGap)
        const y = cardsTop + row * (cardHeight + cardGap)
        this.drawPanel(ctx, x, y, cardWidth, cardHeight, {
          fill: COLORS.panelSoft,
          border: `${meta.color}40`,
          radius: 20,
        })
        await this.drawItemImage(ctx, item.id, x + 18, y + 24, 112, item.icon || meta.icon)

        const textX = x + 148
        const textWidth = cardWidth - 166
        ctx.fillStyle = COLORS.text
        ctx.font = `bold 25px ${this.fontFamily}`
        ctx.fillText(this.truncateText(ctx, String(item.name || item.id), textWidth), textX, y + 48)

        const price = toFiniteNumber(item.price)
        ctx.fillStyle = price > 0 ? "#C17D17" : COLORS.muted
        ctx.font = `bold 21px ${this.fontFamily}`
        ctx.fillText(price > 0 ? `${this.formatNumber(price)} 樱花币` : "非卖品", textX, y + 80)

        ctx.fillStyle = meta.color
        ctx.font = `18px ${this.fontFamily}`
        ctx.fillText(this.getShopItemDetail(item, category.handler), textX, y + 108)
        this.drawWrappedText(ctx, item.description, textX, y + 138, textWidth, {
          font: `16px ${this.fontFamily}`,
          color: COLORS.secondary,
          lineHeight: 22,
          maxLines: 3,
        })
      }

      ctx.fillStyle = COLORS.muted
      ctx.font = `17px ${this.fontFamily}`
      ctx.textAlign = "center"
      ctx.fillText("购买指令：#购买 商品名 数量", this.width / 2, height - 28)
      ctx.textAlign = "left"
      pages.push({ title: categoryTitle, buffer: canvas.toBuffer("image/png") })
    }

    return pages
  }

  getInventoryItemMeta(item) {
    const handlerMeta = HANDLER_META[item.handler] || HANDLER_META.fishing_special
    if (item.durability) {
      const current = Math.max(0, Math.floor(toFiniteNumber(item.durability.current)))
      const max = Math.max(0, Math.floor(toFiniteNumber(item.durability.max)))
      return [
        `耐久 ${current}/${max}`,
        item.kind === "rod" ? `熟练度 ${Math.max(0, Math.floor(toFiniteNumber(item.mastery)))}` : "",
      ].filter(Boolean)
    }
    if (item.handler === "fishing_bait") {
      return [item.bossBait ? "首领挑战专用" : "钓鱼消耗品"]
    }
    if (item.handler === "fishing_chest") return ["发送 #开宝箱 开启"]
    if (item.type === "buff") return ["发送 #使用 激活效果"]
    return [handlerMeta.label]
  }

  async generateInventoryPages({
    nickname,
    avatarUrl,
    balance,
    bagLevel,
    currentSize,
    capacity,
    items,
  }) {
    const inventoryItems = Array.isArray(items) ? items : []
    const pageItems = chunk(inventoryItems, 12)
    if (pageItems.length === 0) pageItems.push([])
    const pages = []

    for (let pageIndex = 0; pageIndex < pageItems.length; pageIndex++) {
      const visibleItems = pageItems[pageIndex]
      const columns = 3
      const rows = Math.max(1, Math.ceil(visibleItems.length / columns))
      const cardGap = 16
      const cardWidth = (this.width - 72 - cardGap * (columns - 1)) / columns
      const cardHeight = 214
      const cardsTop = 230
      const height = Math.max(580, cardsTop + rows * cardHeight + Math.max(0, rows - 1) * cardGap + 72)
      const { canvas, ctx } = this.createBaseCanvas(height)

      await this.drawUserAvatar(ctx, avatarUrl, 42, 38, 126)
      ctx.fillStyle = COLORS.text
      ctx.font = `bold 38px ${this.fontFamily}`
      ctx.fillText(
        this.truncateText(ctx, `${nickname || "旅人"} 的背包`, 430),
        194,
        78,
      )
      ctx.fillStyle = COLORS.secondary
      ctx.font = `20px ${this.fontFamily}`
      ctx.fillText(`背包 Lv.${bagLevel} · ${inventoryItems.length} 种物品`, 196, 112)

      ctx.fillStyle = COLORS.secondary
      ctx.font = `18px ${this.fontFamily}`
      ctx.fillText(`容量 ${currentSize}/${capacity}`, 196, 151)
      this.drawProgressBar(ctx, 196, 165, 360, 16, capacity > 0 ? currentSize / capacity : 0)

      this.drawPanel(ctx, 650, 48, 282, 76, {
        fill: "rgba(255, 249, 226, 0.94)",
        border: "rgba(218, 169, 70, 0.32)",
        radius: 20,
      })
      ctx.fillStyle = "#9B6A25"
      ctx.font = `17px ${this.fontFamily}`
      ctx.fillText("樱花币", 674, 77)
      ctx.fillStyle = "#C17D17"
      ctx.font = `bold 27px ${this.fontFamily}`
      ctx.fillText(this.formatNumber(balance), 674, 108)
      if (pageItems.length > 1) {
        this.drawPill(ctx, `${pageIndex + 1}/${pageItems.length}`, 932, 142, {
          align: "right",
          fontSize: 17,
          height: 32,
        })
      }

      if (visibleItems.length === 0) {
        this.drawPanel(ctx, 150, cardsTop, 700, 250, { fill: COLORS.panelSoft })
        ctx.fillStyle = COLORS.muted
        ctx.font = `64px ${this.fontFamily}`
        ctx.textAlign = "center"
        ctx.fillText("🎒", this.width / 2, cardsTop + 100)
        ctx.fillStyle = COLORS.secondary
        ctx.font = `24px ${this.fontFamily}`
        ctx.fillText("背包空空如也，去商店逛逛吧", this.width / 2, cardsTop + 165)
        ctx.textAlign = "left"
      }

      for (let index = 0; index < visibleItems.length; index++) {
        const item = visibleItems[index]
        const col = index % columns
        const row = Math.floor(index / columns)
        const x = 36 + col * (cardWidth + cardGap)
        const y = cardsTop + row * (cardHeight + cardGap)
        const meta = HANDLER_META[item.handler] || HANDLER_META.fishing_special
        this.drawPanel(ctx, x, y, cardWidth, cardHeight, {
          fill: item.equipped ? "rgba(255, 239, 247, 0.96)" : COLORS.panelSoft,
          border: item.equipped ? "rgba(224, 92, 145, 0.58)" : COLORS.border,
          radius: 20,
          lineWidth: item.equipped ? 2.5 : 1.5,
        })
        await this.drawItemImage(ctx, item.id, x + 16, y + 18, 94, item.icon || meta.icon)

        const textX = x + 124
        const textWidth = cardWidth - 140
        ctx.fillStyle = COLORS.text
        ctx.font = `bold 21px ${this.fontFamily}`
        ctx.fillText(this.truncateText(ctx, String(item.name || item.id), textWidth), textX, y + 43)
        ctx.fillStyle = COLORS.accentDark
        ctx.font = `bold 18px ${this.fontFamily}`
        ctx.fillText(`×${Math.max(0, Math.floor(toFiniteNumber(item.count)))}`, textX, y + 72)
        if (item.equipped) {
          this.drawPill(ctx, "已装备", textX, y + 84, {
            fontSize: 14,
            height: 28,
            paddingX: 11,
          })
        }

        const info = this.getInventoryItemMeta(item)
        ctx.fillStyle = meta.color
        ctx.font = `16px ${this.fontFamily}`
        info.slice(0, 2).forEach((line, infoIndex) => {
          ctx.fillText(line, x + 18, y + 137 + infoIndex * 23)
        })
        this.drawWrappedText(ctx, item.description, x + 18, y + 187, cardWidth - 36, {
          font: `14px ${this.fontFamily}`,
          color: COLORS.muted,
          lineHeight: 19,
          maxLines: 1,
        })
      }

      ctx.fillStyle = COLORS.muted
      ctx.font = `16px ${this.fontFamily}`
      ctx.textAlign = "center"
      ctx.fillText("可使用 #使用、#装备鱼竿、#装备鱼线、#装备鱼饵 管理物品", this.width / 2, height - 28)
      ctx.textAlign = "left"
      pages.push({ buffer: canvas.toBuffer("image/png") })
    }

    return pages
  }

  async drawStatusEquipmentCard(ctx, item, x, y, width, height) {
    const meta = HANDLER_META[item.handler] || HANDLER_META.fishing_special
    this.drawPanel(ctx, x, y, width, height, {
      fill: COLORS.panelSoft,
      border: `${meta.color}45`,
      radius: 22,
    })
    await this.drawItemImage(ctx, item.id, x + (width - 104) / 2, y + 20, 104, meta.icon)
    ctx.fillStyle = COLORS.text
    ctx.font = `bold 22px ${this.fontFamily}`
    ctx.textAlign = "center"
    ctx.fillText(this.truncateText(ctx, item.name || `未装备${meta.label}`, width - 30), x + width / 2, y + 151)
    ctx.fillStyle = meta.color
    ctx.font = `17px ${this.fontFamily}`
    const details = Array.isArray(item.details) ? item.details : []
    if (details.length === 0) details.push("尚未装备")
    details.slice(0, 2).forEach((detail, index) => {
      ctx.fillText(
        this.truncateText(ctx, String(detail), width - 28),
        x + width / 2,
        y + 184 + index * 27,
      )
    })
    ctx.textAlign = "left"
  }

  async generateFishingStatusImage(data) {
    const effects = Array.isArray(data.effects) ? data.effects : []
    const effectRows = Math.max(1, Math.ceil(effects.length / 2))
    const effectsTop = 1040
    const height = effectsTop + effectRows * 78 + 48
    const { canvas, ctx } = this.createBaseCanvas(height)

    this.drawPanel(ctx, 32, 30, 936, 202, {
      fill: "rgba(255, 255, 255, 0.91)",
      radius: 26,
    })
    await this.drawUserAvatar(ctx, data.avatarUrl, 58, 56, 148)
    ctx.fillStyle = COLORS.text
    ctx.font = `bold 39px ${this.fontFamily}`
    ctx.fillText(
      this.truncateText(ctx, data.nickname || String(data.userId), 450),
      232,
      91,
    )
    ctx.fillStyle = COLORS.secondary
    ctx.font = `20px ${this.fontFamily}`
    ctx.fillText(
      `📍 ${data.location?.emoji || ""}${data.location?.name || "未知钓点"}  ·  ${data.weather?.emoji || ""}${data.weather?.name || "未知天气"}`,
      234,
      132,
    )
    ctx.fillStyle = COLORS.accentDark
    ctx.font = `bold 21px ${this.fontFamily}`
    ctx.fillText(
      this.truncateText(
        ctx,
        `${data.profession?.icon || "🎓"} ${data.profession?.name || "尚未选择职业"}${data.profession?.title ? ` · ${data.profession.title}` : ""}`,
        450,
      ),
      234,
      174,
    )

    this.drawPanel(ctx, 706, 65, 226, 112, {
      fill: "rgba(255, 249, 226, 0.96)",
      border: "rgba(218, 169, 70, 0.34)",
      radius: 22,
      shadow: false,
    })
    ctx.fillStyle = "#9B6A25"
    ctx.font = `18px ${this.fontFamily}`
    ctx.fillText("当前余额", 730, 98)
    ctx.fillStyle = "#C17D17"
    ctx.font = `bold 30px ${this.fontFamily}`
    ctx.fillText(this.formatNumber(data.balance), 730, 136)
    ctx.fillStyle = "#A87A35"
    ctx.font = `16px ${this.fontFamily}`
    ctx.fillText("樱花币", 730, 161)

    this.drawPanel(ctx, 32, 252, 936, 164, { fill: COLORS.panelSoft })
    const level = Math.max(1, Math.floor(toFiniteNumber(data.level, 1)))
    const expCurrent = Math.max(0, toFiniteNumber(data.exp?.current))
    const expStart = Math.max(0, toFiniteNumber(data.exp?.levelStart))
    const expEnd = Math.max(expStart + 1, toFiniteNumber(data.exp?.levelEnd, expStart + 1))
    const levelProgress = (expCurrent - expStart) / (expEnd - expStart)
    ctx.fillStyle = COLORS.text
    ctx.font = `bold 28px ${this.fontFamily}`
    ctx.fillText(`钓鱼 Lv.${level}`, 58, 296)
    ctx.fillStyle = COLORS.secondary
    ctx.font = `17px ${this.fontFamily}`
    ctx.fillText(
      `经验 ${this.formatNumber(Math.max(0, expCurrent - expStart))}/${this.formatNumber(expEnd - expStart)}`,
      58,
      326,
    )
    this.drawProgressBar(ctx, 58, 344, 500, 22, levelProgress)

    const stamina = data.stamina || {}
    ctx.fillStyle = COLORS.text
    ctx.font = `bold 24px ${this.fontFamily}`
    ctx.fillText(`⚡ 体力 ${stamina.current || 0}/${stamina.max || 0}`, 620, 296)
    ctx.fillStyle = COLORS.secondary
    ctx.font = `17px ${this.fontFamily}`
    const staminaNote = stamina.nextRecoveryMinutes > 0
      ? `约 ${stamina.nextRecoveryMinutes} 分钟后恢复 · 下竿消耗 ${stamina.cost || 1}`
      : `体力充足 · 下竿消耗 ${stamina.cost || 1}`
    ctx.fillText(staminaNote, 620, 326)
    this.drawProgressBar(
      ctx,
      620,
      344,
      304,
      22,
      stamina.max > 0 ? stamina.current / stamina.max : 0,
      { startColor: "#81C995", endColor: "#48A86B" },
    )
    ctx.fillStyle = COLORS.muted
    ctx.font = `15px ${this.fontFamily}`
    ctx.fillText(`累计经验 ${this.formatNumber(expCurrent)}`, 58, 394)

    ctx.fillStyle = COLORS.text
    ctx.font = `bold 28px ${this.fontFamily}`
    ctx.fillText("当前装备", 38, 462)
    const equipment = Array.isArray(data.equipment) ? data.equipment : []
    const equipmentGap = 18
    const equipmentWidth = (936 - equipmentGap * 2) / 3
    for (let index = 0; index < 3; index++) {
      const item = equipment[index] || {
        handler: ["fishing_rod", "fishing_line", "fishing_bait"][index],
        name: "未装备",
        details: [],
      }
      await this.drawStatusEquipmentCard(
        ctx,
        item,
        32 + index * (equipmentWidth + equipmentGap),
        482,
        equipmentWidth,
        246,
      )
    }

    const infoTop = 758
    const infoWidth = 459
    this.drawPanel(ctx, 32, infoTop, infoWidth, 238, {
      fill: "rgba(255, 246, 247, 0.94)",
      border: "rgba(196, 86, 99, 0.3)",
    })
    await this.drawItemImage(ctx, "torpedo", 56, infoTop + 50, 100, "💣")
    ctx.fillStyle = COLORS.text
    ctx.font = `bold 25px ${this.fontFamily}`
    ctx.fillText("鱼雷与鱼价", 178, infoTop + 43)
    const torpedo = data.torpedo || {}
    ctx.fillStyle = torpedo.dangerousCount > 0 ? COLORS.danger : COLORS.success
    ctx.font = `18px ${this.fontFamily}`
    ctx.fillText(
      torpedo.dangerousCount > 0
        ? `威胁鱼雷 ${torpedo.dangerousCount} 个，请小心` 
        : "当前没有威胁你的鱼雷",
      178,
      infoTop + 81,
    )
    ctx.fillStyle = COLORS.secondary
    ctx.fillText(
      torpedo.deployed
        ? `已投放 1 个 · 剩余约 ${torpedo.remainingMinutes} 分钟`
        : "你尚未投放鱼雷",
      178,
      infoTop + 116,
    )
    ctx.fillText(`鱼塘共潜伏 ${torpedo.totalCount || 0} 个鱼雷`, 178, infoTop + 151)
    ctx.fillStyle = torpedo.priceBoostActive ? COLORS.warning : COLORS.secondary
    ctx.font = `bold 18px ${this.fontFamily}`
    ctx.fillText(
      torpedo.priceBoostActive
        ? `鱼价 ×1.5 · 剩余 ${torpedo.priceBoostRemainingMinutes} 分钟`
        : "当前鱼价正常",
      178,
      infoTop + 190,
    )

    this.drawPanel(ctx, 509, infoTop, infoWidth, 238, { fill: COLORS.panelSoft })
    ctx.fillStyle = COLORS.text
    ctx.font = `bold 25px ${this.fontFamily}`
    ctx.fillText("垂钓统计", 535, infoTop + 43)
    const stats = data.stats || {}
    const statEntries = [
      ["今日垂钓", `${this.formatNumber(stats.todayCount)} 次`],
      ["累计渔获", `${this.formatNumber(stats.totalCatch)} 次`],
      ["累计收益", `${this.formatNumber(stats.totalEarnings)} 币`],
      ["被鱼雷炸中", `${this.formatNumber(stats.torpedoHits)} 次`],
    ]
    statEntries.forEach(([label, value], index) => {
      const col = index % 2
      const row = Math.floor(index / 2)
      const x = 535 + col * 205
      const y = infoTop + 87 + row * 72
      ctx.fillStyle = COLORS.muted
      ctx.font = `16px ${this.fontFamily}`
      ctx.fillText(label, x, y)
      ctx.fillStyle = COLORS.accentDark
      ctx.font = `bold 22px ${this.fontFamily}`
      ctx.fillText(value, x, y + 30)
    })

    ctx.fillStyle = COLORS.text
    ctx.font = `bold 28px ${this.fontFamily}`
    ctx.fillText("生效中的状态", 38, 1030)
    const visibleEffects = effects.length > 0
      ? effects
      : [{ icon: "🌸", name: "状态良好", detail: "暂无额外效果", tone: "neutral" }]
    const effectWidth = 459
    const effectGap = 18
    visibleEffects.forEach((effect, index) => {
      const col = index % 2
      const row = Math.floor(index / 2)
      const x = 32 + col * (effectWidth + effectGap)
      const y = effectsTop + row * 78
      const toneColor = effect.tone === "danger"
        ? COLORS.danger
        : effect.tone === "warning"
          ? COLORS.warning
          : effect.tone === "positive"
            ? COLORS.success
            : COLORS.accent
      this.drawPanel(ctx, x, y, effectWidth, 62, {
        fill: "rgba(255, 255, 255, 0.82)",
        border: `${toneColor}38`,
        radius: 18,
        shadow: false,
      })
      ctx.fillStyle = toneColor
      ctx.font = `bold 19px ${this.fontFamily}`
      ctx.fillText(`${effect.icon || "✨"} ${effect.name}`, x + 18, y + 27)
      ctx.fillStyle = COLORS.secondary
      ctx.font = `15px ${this.fontFamily}`
      ctx.fillText(
        this.truncateText(ctx, String(effect.detail || "生效中"), effectWidth - 36),
        x + 18,
        y + 49,
      )
    })

    return canvas.toBuffer("image/png")
  }
}
