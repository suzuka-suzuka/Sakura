import { createCanvas, loadImage } from "@napi-rs/canvas"
import EconomyImageGenerator from "./ImageGenerator.js"
import path from "node:path"
import fs from "node:fs"
import { pluginresources } from "../path.js"

const FISH_DEX_COLUMNS = 5

function groupFishDexSectionsByRarity(sections) {
  return (Array.isArray(sections) ? sections : [])
    .filter((section) => Array.isArray(section?.entries) && section.entries.length > 0)
    .map((section) => [{ ...section, entries: [...section.entries] }])
}

// 稀有度对应的卡片底色与分区强调色
const RARITY_CELL_COLORS = {
  "垃圾": 'rgba(150, 150, 150, 0.6)',
  "普通": 'rgba(255, 255, 255, 0.6)',
  "精品": 'rgba(200, 255, 200, 0.6)',
  "稀有": 'rgba(200, 220, 255, 0.6)',
  "史诗": 'rgba(230, 200, 255, 0.6)',
  "传说": 'rgba(255, 220, 180, 0.6)',
  "宝藏": 'rgba(255, 215, 0, 0.6)',
  "噩梦": 'rgba(220, 20, 60, 0.6)'
}

const RARITY_ACCENT_COLORS = {
  "垃圾": '#9E9E9E',
  "普通": '#B0BEC5',
  "精品": '#66BB6A',
  "稀有": '#42A5F5',
  "史诗": '#AB47BC',
  "传说": '#FF9800',
  "宝藏": '#FFB300',
  "噩梦": '#E53935'
}

export default class FishingImageGenerator extends EconomyImageGenerator {
  constructor() {
    super()
    this.fontFamily = 'ZhuZiAYuan, "MotoyaMaru", "Noto Color Emoji", "Segoe UI Emoji", "Noto Sans SC", sans-serif'
    this.fishImgPath = path.join(pluginresources, "fish", "img")
  }

  // 绘制鱼的图片（正方形）
  async drawFishImage(ctx, fishId, x, y, size) {
    const imagePath = path.join(this.fishImgPath, `${fishId}.png`)
    try {
      if (fs.existsSync(imagePath)) {
        const image = await loadImage(imagePath)
        // 绘制圆角矩形裁剪
        ctx.save()
        this.drawRoundedRect(ctx, x, y, size, size, 10)
        ctx.clip()
        ctx.drawImage(image, x, y, size, size)
        ctx.restore()
      } else {
        // 如果图片不存在，绘制占位符
        ctx.fillStyle = 'rgba(200, 200, 200, 0.5)'
        this.drawRoundedRect(ctx, x, y, size, size, 10)
        ctx.fill()
        ctx.fillStyle = '#888'
        ctx.font = `bold 32px ${this.fontFamily}`
        ctx.textAlign = 'center'
        ctx.fillText('🐟', x + size / 2, y + size / 2 + 10)
        ctx.textAlign = 'left'
      }
    } catch (err) {
      // 加载失败时绘制占位符
      ctx.fillStyle = 'rgba(200, 200, 200, 0.5)'
      this.drawRoundedRect(ctx, x, y, size, size, 10)
      ctx.fill()
      ctx.fillStyle = '#888'
      ctx.font = `bold 32px ${this.fontFamily}`
      ctx.textAlign = 'center'
      ctx.fillText('🐟', x + size / 2, y + size / 2 + 10)
      ctx.textAlign = 'left'
    }
  }

  // 剪影：离屏画布 source-in，借助鱼图透明通道生成纯色轮廓
  async drawFishSilhouette(ctx, fishId, x, y, size) {
    const imagePath = path.join(this.fishImgPath, `${fishId}.png`)
    try {
      if (fs.existsSync(imagePath)) {
        const image = await loadImage(imagePath)
        const off = createCanvas(size, size)
        const offCtx = off.getContext('2d')
        offCtx.drawImage(image, 0, 0, size, size)
        offCtx.globalCompositeOperation = 'source-in'
        offCtx.fillStyle = 'rgba(74, 68, 88, 0.92)'
        offCtx.fillRect(0, 0, size, size)
        ctx.drawImage(off, x, y)
        return
      }
    } catch (err) { }
    // 图片缺失时退回鱼形占位
    ctx.fillStyle = 'rgba(74, 68, 88, 0.35)'
    this.drawRoundedRect(ctx, x, y, size, size, 10)
    ctx.fill()
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)'
    ctx.font = `bold 40px ${this.fontFamily}`
    ctx.textAlign = 'center'
    ctx.fillText('🐟', x + size / 2, y + size / 2 + 14)
    ctx.textAlign = 'left'
  }

  async generateFishDexPages(data) {
    const pageSections = groupFishDexSectionsByRarity(data.sections)
    const pages = pageSections.length > 0 ? pageSections : [[]]
    const images = []

    for (let index = 0; index < pages.length; index++) {
      images.push(await this.generateFishDex({
        ...data,
        sections: pages[index],
        pageIndex: index + 1,
        pageCount: pages.length,
      }))
    }

    return images
  }

  // 三态图鉴：已收录彩图 / 目击剪影 / 未发现问号；locationLabel 存在时表示按钓点筛选视图
  async generateFishDex({
    targetName,
    targetId,
    userData,
    sections,
    collected,
    sighted,
    total,
    locationLabel = null,
    pageIndex = null,
    pageCount = null,
  }) {
    const width = 800
    const padding = 20
    const columns = FISH_DEX_COLUMNS
    const cellGap = 12
    const cellWidth = (width - padding * 2 - cellGap * (columns - 1)) / columns
    const cellHeight = 180
    const sectionTitleHeight = 56
    const headerHeight = 240

    let contentHeight = 0
    for (const section of sections) {
      const rows = Math.ceil(section.entries.length / columns)
      contentHeight += sectionTitleHeight + rows * (cellHeight + cellGap)
    }
    const height = headerHeight + contentHeight + padding

    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext('2d')

    this.drawSakuraBackground(ctx, width, height)

    // Header
    const avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${targetId}&s=640`
    await this.drawAvatar(ctx, avatarUrl, 40, 40, 140)

    ctx.fillStyle = '#5D4037'
    ctx.font = `bold 40px ${this.fontFamily}`
    const title = `${targetName} 的钓鱼图鉴`
    const hasPageLabel = pageCount > 1 && pageIndex > 0
    if (hasPageLabel) {
      ctx.fillText(this.truncateText(ctx, title, width - 330), 200, 88)
      ctx.fillStyle = '#AD6A85'
      ctx.font = `bold 22px ${this.fontFamily}`
      ctx.textAlign = 'right'
      ctx.fillText(`第 ${pageIndex}/${pageCount} 页`, width - padding, 86)
      ctx.textAlign = 'left'
    } else {
      ctx.fillText(title, 200, 88)
    }

    ctx.fillStyle = '#5D4037'
    ctx.font = `26px ${this.fontFamily}`
    const locationSuffix = locationLabel ? ` · 📍${locationLabel}` : ""
    ctx.fillText(`📖 已收录 ${collected}/${total} · 👀 目击 ${sighted}${locationSuffix}`, 200, 130)

    const barX = 200
    const barY = 146
    const barWidth = width - barX - padding * 2
    const barHeight = 16
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)'
    this.drawRoundedRect(ctx, barX, barY, barWidth, barHeight, 8)
    ctx.fill()
    if (total > 0 && collected > 0) {
      const ratio = Math.min(1, collected / total)
      ctx.fillStyle = '#FF80AB'
      this.drawRoundedRect(ctx, barX, barY, Math.max(barHeight, Math.round(barWidth * ratio)), barHeight, 8)
      ctx.fill()
    }

    ctx.fillStyle = '#795548'
    ctx.font = `22px ${this.fontFamily}`
    ctx.fillText(
      `🎣 总钓鱼 ${userData.total_catch || 0} 次 · 💰 总收益 ${userData.total_earnings || 0} · 💥 被炸 ${userData.torpedo_hits || 0} 次`,
      200,
      205
    )

    let cursorY = headerHeight
    for (const section of sections) {
      // 分区标题：稀有度色块 + 名称 + 收集进度
      const accent = RARITY_ACCENT_COLORS[section.rarity] || '#9E9E9E'
      ctx.fillStyle = accent
      this.drawRoundedRect(ctx, padding, cursorY + 12, 10, 30, 5)
      ctx.fill()

      ctx.fillStyle = '#5D4037'
      ctx.font = `bold 28px ${this.fontFamily}`
      ctx.fillText(section.rarity, padding + 24, cursorY + 38)
      const titleWidth = ctx.measureText(section.rarity).width

      ctx.fillStyle = accent
      ctx.font = `bold 22px ${this.fontFamily}`
      ctx.fillText(`${section.collected}/${section.total}`, padding + 24 + titleWidth + 14, cursorY + 37)

      cursorY += sectionTitleHeight

      for (let i = 0; i < section.entries.length; i++) {
        const entry = section.entries[i]
        const col = i % columns
        const row = Math.floor(i / columns)
        const x = padding + col * (cellWidth + cellGap)
        const y = cursorY + row * (cellHeight + cellGap)

        if (entry.status === 'collected') {
          ctx.fillStyle = RARITY_CELL_COLORS[entry.rarity] || 'rgba(255, 255, 255, 0.6)'
        } else if (entry.status === 'sighted') {
          ctx.fillStyle = 'rgba(176, 176, 186, 0.45)'
        } else {
          ctx.fillStyle = 'rgba(158, 158, 168, 0.3)'
        }
        this.drawRoundedRect(ctx, x, y, cellWidth, cellHeight, 12)
        ctx.fill()

        const imgSize = 96
        const imgX = x + (cellWidth - imgSize) / 2
        const imgY = y + 10

        if (entry.status === 'collected') {
          await this.drawFishImage(ctx, entry.fishId, imgX, imgY, imgSize)
        } else if (entry.status === 'sighted') {
          await this.drawFishSilhouette(ctx, entry.fishId, imgX, imgY, imgSize)
        } else {
          ctx.fillStyle = 'rgba(93, 64, 55, 0.12)'
          this.drawRoundedRect(ctx, imgX, imgY, imgSize, imgSize, 10)
          ctx.fill()
          ctx.fillStyle = 'rgba(93, 64, 55, 0.5)'
          ctx.font = `bold 46px ${this.fontFamily}`
          ctx.textAlign = 'center'
          ctx.fillText('?', imgX + imgSize / 2, imgY + imgSize / 2 + 16)
          ctx.textAlign = 'left'
        }

        ctx.textAlign = 'center'
        const centerX = x + cellWidth / 2
        if (entry.status === 'unknown') {
          ctx.fillStyle = 'rgba(93, 64, 55, 0.55)'
          ctx.font = `bold 20px ${this.fontFamily}`
          ctx.fillText('？？？', centerX, y + 132)
        } else {
          ctx.fillStyle = '#5D4037'
          ctx.font = `bold 19px ${this.fontFamily}`
          ctx.fillText(this.truncateText(ctx, String(entry.name), cellWidth - 12), centerX, y + 132)

          ctx.fillStyle = '#795548'
          ctx.font = `16px ${this.fontFamily}`
          if (entry.status === 'collected') {
            ctx.fillText(`捕获 ×${entry.successCount}`, centerX, y + 155)
            if (entry.maxWeight > 0) {
              ctx.fillText(`最大 ${Math.round(entry.maxWeight * 100) / 100}`, centerX, y + 174)
            }
          } else {
            ctx.fillText(`逃走 ${entry.escapeCount} 次`, centerX, y + 155)
          }
        }
        ctx.textAlign = 'left'
      }

      cursorY += Math.ceil(section.entries.length / columns) * (cellHeight + cellGap)
    }

    return canvas.toBuffer('image/png')
  }

  async generateFishingRankingImage(data) {
    const itemHeight = 100
    const headerHeight = 120
    const padding = 20
    const listHeight = data.list.length * (itemHeight + padding)
    const height = headerHeight + listHeight + padding

    const canvas = createCanvas(this.width, height)
    const ctx = canvas.getContext('2d')

    this.drawSakuraBackground(ctx, this.width, height)

    // 标题
    ctx.fillStyle = "#FF1493"
    ctx.font = `bold 40px ${this.fontFamily}`
    ctx.textAlign = "center"
    ctx.fillText(data.title, this.width / 2, 80)
    ctx.textAlign = "left"

    for (let i = 0; i < data.list.length; i++) {
      const item = data.list[i]
      const y = headerHeight + i * (itemHeight + padding)

      // 卡片背景
      ctx.fillStyle = "rgba(255, 255, 255, 0.9)"
      ctx.shadowColor = "rgba(255, 105, 180, 0.15)"
      ctx.shadowBlur = 8
      this.drawRoundedRect(ctx, 20, y, this.width - 40, itemHeight, 15)
      ctx.fill()
      ctx.shadowBlur = 0

      // 排名
      ctx.font = `bold 36px ${this.fontFamily}`
      if (item.rank <= 3) {
        ctx.fillStyle = item.rank == 1 ? "#FF1493" : (item.rank == 2 ? "#FF69B4" : "#FFB3D9")
      } else {
        ctx.fillStyle = "#FFC0CB"
      }
      ctx.textAlign = "center"
      ctx.fillText(`${item.rank}`, 70, y + 65)
      ctx.textAlign = "left"

      // 头像
      await this.drawAvatar(ctx, item.avatarUrl, 120, y + 10, 80)

      // 昵称
      ctx.fillStyle = "#666666"
      ctx.font = `bold 24px ${this.fontFamily}`

      const nicknameX = 220
      // 右侧显示收益和次数
      const valueText = `💰 ${item.totalEarnings}`
      const countText = `🎣 ${item.totalCatch}次`

      ctx.fillStyle = "#FF1493"
      ctx.font = `bold 26px ${this.fontFamily}`
      ctx.textAlign = "right"
      ctx.fillText(valueText, this.width - 50, y + 45)

      ctx.fillStyle = "#888888"
      ctx.font = `20px ${this.fontFamily}`
      ctx.fillText(countText, this.width - 50, y + 75)
      ctx.textAlign = "left"

      // 昵称（左侧）
      ctx.fillStyle = "#666666"
      ctx.font = `bold 24px ${this.fontFamily}`
      const maxNicknameWidth = this.width - 280
      const lines = this.wrapText(ctx, item.nickname, maxNicknameWidth)

      if (lines.length > 2) {
        lines[1] = lines[1] + '...'
        lines.length = 2
      }

      if (lines.length === 1) {
        ctx.fillText(lines[0], nicknameX, y + 60)
      } else {
        ctx.font = `bold 20px ${this.fontFamily}`
        ctx.fillText(lines[0], nicknameX, y + 45)
        ctx.fillText(lines[1], nicknameX, y + 75)
      }
    }

    return canvas.toBuffer("image/png")
  }

  truncateText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text
    let len = text.length
    while (len > 0 && ctx.measureText(text.substring(0, len) + '...').width > maxWidth) {
      len--
    }
    return text.substring(0, len) + '...'
  }

  async generateCatchResult(data) {
    const width = 600
    const height = 850
    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext('2d')

    this.drawSakuraBackground(ctx, width, height)

    // 卡片背景
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)"
    ctx.shadowColor = "rgba(0, 0, 0, 0.1)"
    ctx.shadowBlur = 20
    this.drawRoundedRect(ctx, 40, 40, width - 80, height - 80, 30)
    ctx.fill()
    ctx.shadowBlur = 0

    // 标题
    ctx.fillStyle = "#FF69B4"
    ctx.font = `bold 48px ${this.fontFamily}`
    ctx.textAlign = "center"
    ctx.fillText("🎉 钓鱼成功！", width / 2, 120)

    // 鱼的头像
    const avatarSize = 200
    const avatarX = (width - avatarSize) / 2
    const avatarY = 160

    // 头像光环
    ctx.beginPath()
    ctx.arc(width / 2, avatarY + avatarSize / 2, avatarSize / 2 + 10, 0, Math.PI * 2)
    ctx.fillStyle = data.rarity.color === '🟠' ? '#FFD700' : // 传说
      data.rarity.color === '🟣' ? '#DA70D6' : // 史诗
        data.rarity.color === '🔵' ? '#87CEEB' : // 稀有
          data.rarity.color === '🟢' ? '#90EE90' : '#E0E0E0' // 精良/普通
    ctx.fill()

    await this.drawAvatar(ctx, data.fishAvatarUrl, avatarX, avatarY, avatarSize)

    // 鱼的名字（不包含身份）
    ctx.fillStyle = "#333333"
    ctx.font = `bold 36px ${this.fontFamily}`
    const fullName = `${data.fishNameBonus}【${data.fishName}】`

    // 简单的自动换行处理
    const lines = this.wrapText(ctx, fullName, width - 120)
    let textY = 420
    for (const line of lines) {
      ctx.fillText(line, width / 2, textY)
      textY += 45
    }

    // 身份（放在名字下方）
    if (data.role === "owner" || data.role === "admin") {
      textY += 10
      ctx.fillStyle = data.role === "owner" ? "#FFD700" : "#87CEEB"
      ctx.font = `bold 28px ${this.fontFamily}`
      const roleName = data.role === "owner" ? "👑 群主" : "⭐ 管理员"
      ctx.fillText(roleName, width / 2, textY)
      textY += 10
    }

    // 稀有度
    textY += 20
    ctx.font = `bold 32px ${this.fontFamily}`
    ctx.fillStyle = data.rarity.color === '🟠' ? '#FF8C00' :
      data.rarity.color === '🟣' ? '#800080' :
        data.rarity.color === '🔵' ? '#0000CD' :
          data.rarity.color === '🟢' ? '#006400' : '#696969'
    ctx.fillText(`${data.rarity.color} ${data.rarity.name}`, width / 2, textY)

    // 新鲜度
    textY += 50
    ctx.fillStyle = "#666666"
    ctx.font = `24px ${this.fontFamily}`
    const freshnessPercent = (data.freshness * 100).toFixed(2) + "%"
    ctx.fillText(`新鲜度：${freshnessPercent}`, width / 2, textY)

    // 重量
    textY += 35
    ctx.fillText(`重量：${data.weight}`, width / 2, textY)

    // 收益
    textY += 60
    ctx.fillStyle = "#FF1493"
    ctx.font = `bold 40px ${this.fontFamily}`
    ctx.fillText(`💰 +${data.price} 樱花币`, width / 2, textY)

    // 底部装饰
    ctx.fillStyle = "#FFB6C1"
    ctx.font = `20px ${this.fontFamily}`
    ctx.fillText("Sakura Fishing System", width / 2, height - 40)

    return canvas.toBuffer('image/png')
  }
}
