import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas"
import fs from "node:fs"
import path from "node:path"

import { pluginresources } from "../path.js"
import { CFG, ROSTER, combatRoleOf } from "./roster.js"
import {
  exDrawQueueOf,
  exHandOf,
  regenOf,
  tmplOf,
  turnCostOf,
} from "./engine.js"
import { describeEffect } from "./format.js"

const FONT_NAME = "BaBattleRounded"
const FONT_FAMILY = `"${FONT_NAME}", "Microsoft YaHei", "Noto Sans SC", sans-serif`
const MAP_WIDTH = 1200
const MAP_HEIGHT = 1800
const CARD_WIDTH = 900
const CARD_HEIGHT = 1280
const GUIDE_WIDTH = 1200
const GUIDE_HEIGHT = 1800
const ASSET_DIR = path.join(pluginresources, "ba", "characters")

export const BATTLE_LAYOUT = Object.freeze({
  width: MAP_WIDTH,
  height: MAP_HEIGHT,
  lanes: Object.freeze([170, 455, 745, 1030]),
  redGround: Object.freeze([505, 565, 505, 565]),
  blueGround: Object.freeze([1245, 1185, 1245, 1185]),
  healthOffsetY: -273,
  healthBarOffsetY: 48,
  shieldBarOffsetY: 35,
  unitWidth: 244,
  unitHeight: 300,
})

export const GUIDE_LAYOUT = Object.freeze({
  width: GUIDE_WIDTH,
  height: GUIDE_HEIGHT,
})

export const ARMOR_VISUAL = Object.freeze({
  轻装: { color: "#E75A64", dark: "#9E2630", soft: "#F9D9DC", label: "轻装甲" },
  重装: { color: "#F0C44E", dark: "#926C08", soft: "#FFF0B8", label: "重装甲" },
  特殊: { color: "#559DE4", dark: "#2163A3", soft: "#D9EBFC", label: "特殊装甲" },
  弹力: { color: "#A875DE", dark: "#663AA2", soft: "#EBDDFA", label: "弹力装甲" },
})

export const ATTACK_VISUAL = Object.freeze({
  爆发: { color: "#F05B5B", soft: "#FCE1DC" },
  贯通: { color: "#F0C547", soft: "#FAEDC7" },
  神秘: { color: "#4E9FE8", soft: "#DCE8FC" },
  振动: { color: "#A969DA", soft: "#EDDEF8" },
})

const EFFECT_VISUAL = Object.freeze({
  爆发: { color: "#F05B5B", soft: "rgba(240,91,91,0.18)" },
  贯通: { color: "#F0C547", soft: "rgba(240,197,71,0.18)" },
  神秘: { color: "#4E9FE8", soft: "rgba(78,159,232,0.18)" },
  振动: { color: "#A969DA", soft: "rgba(169,105,218,0.18)" },
  持续: { color: "#E9854F", soft: "rgba(233,133,79,0.18)" },
  治疗: { color: "#52DB7C", soft: "rgba(82,219,124,0.18)" },
  Cost: { color: "#F6C85F", soft: "rgba(246,200,95,0.18)" },
  增益: { color: "#64D9A4", soft: "rgba(100,217,164,0.18)" },
  减益: { color: "#F081A4", soft: "rgba(240,129,164,0.18)" },
})

const SIDE_VISUAL = Object.freeze([
  { name: "蓝方", color: "#56A8F2", dark: "#1E5F9B", soft: "rgba(73, 155, 231, 0.17)" },
  { name: "红方", color: "#F06B73", dark: "#A62D38", soft: "rgba(236, 84, 96, 0.17)" },
])

let fontReady = false

function ensureFont() {
  if (fontReady) return
  fontReady = true
  try {
    GlobalFonts.registerFromPath(
      path.join(pluginresources, "sign", "font", "FZFWZhuZiAYuanJWD.ttf"),
      FONT_NAME
    )
  } catch (error) {
    globalThis.logger?.warn?.(`[档案对战] 字体加载失败：${error.message}`)
  }
}

function font(size, weight = "normal") {
  return `${weight} ${size}px ${FONT_FAMILY}`
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value) || 0))
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

function sectorPath(ctx, cx, cy, radius, progress) {
  const end = -Math.PI / 2 + Math.PI * 2 * clamp(progress)
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.lineTo(cx, cy - radius)
  ctx.arc(cx, cy, radius, -Math.PI / 2, end)
  ctx.closePath()
}

function fillRounded(ctx, x, y, width, height, radius, color) {
  roundedRect(ctx, x, y, width, height, radius)
  ctx.fillStyle = color
  ctx.fill()
}

function strokeRounded(ctx, x, y, width, height, radius, color, lineWidth = 1) {
  roundedRect(ctx, x, y, width, height, radius)
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.stroke()
}

function fitText(ctx, text, maxWidth, startSize, minSize = 12, weight = "bold") {
  let size = startSize
  while (size > minSize) {
    ctx.font = font(size, weight)
    if (ctx.measureText(String(text)).width <= maxWidth) break
    size -= 1
  }
  return size
}

function wrapText(ctx, text, maxWidth, maxLines = Infinity) {
  const lines = []
  for (const paragraph of String(text || "").split("\n")) {
    let line = ""
    for (const char of paragraph) {
      const next = line + char
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line)
        line = char
        if (lines.length >= maxLines) break
      } else {
        line = next
      }
    }
    if (lines.length >= maxLines) break
    if (line) lines.push(line)
  }
  return lines.slice(0, maxLines)
}

function drawWrapped(ctx, text, x, y, maxWidth, options = {}) {
  const {
    size = 20,
    lineHeight = Math.round(size * 1.35),
    color = "#EAF2FF",
    weight = "normal",
    maxLines = 2,
  } = options
  ctx.save()
  ctx.font = font(size, weight)
  ctx.fillStyle = color
  ctx.textAlign = "left"
  ctx.textBaseline = "alphabetic"
  const all = wrapText(ctx, text, maxWidth, maxLines + 1)
  const lines = all.slice(0, maxLines)
  if (all.length > maxLines && lines.length) {
    let last = `${lines[lines.length - 1]}…`
    while (last.length > 1 && ctx.measureText(last).width > maxWidth) {
      last = `${last.slice(0, -2)}…`
    }
    lines[lines.length - 1] = last
  }
  lines.forEach((line, index) => ctx.fillText(line, x, y + lineHeight * index))
  ctx.restore()
  return lines.length
}

function drawPill(ctx, text, x, y, options = {}) {
  const {
    fill = "rgba(255,255,255,0.12)",
    color = "#F4F7FF",
    border = null,
    size = 17,
    height = 32,
    paddingX = 12,
    weight = "bold",
  } = options
  ctx.save()
  ctx.font = font(size, weight)
  const width = Math.ceil(ctx.measureText(String(text)).width) + paddingX * 2
  fillRounded(ctx, x, y, width, height, height / 2, fill)
  if (border) strokeRounded(ctx, x, y, width, height, height / 2, border, 1.2)
  ctx.fillStyle = color
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(String(text), x + width / 2, y + height / 2 + 1)
  ctx.restore()
  return width
}

function mix(hex, target = "#FFFFFF", ratio = 0.5) {
  const read = (value) => {
    const n = Number.parseInt(String(value).replace("#", ""), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const a = read(hex)
  const b = read(target)
  const values = a.map((v, index) => Math.round(v * (1 - ratio) + b[index] * ratio))
  return `#${values.map((v) => v.toString(16).padStart(2, "0")).join("")}`
}

function polygonPath(ctx, points) {
  ctx.beginPath()
  points.forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.closePath()
}

function guidePageDefinitions() {
  const strong = CFG.AFF_STRONG.toFixed(2)
  const resist = CFG.AFF_WEAK.toFixed(2)
  return [
    {
      tab: "FLOW / TURN",
      title: "开局与回合",
      subtitle: "从发起对战，到看懂一次完整的回合结算",
      sections: [
        {
          title: "开局四步",
          accent: "#58B8F6",
          height: 390,
          items: [
            { label: "01  发起", text: "#档案对战 @某人；不 @ 时会成为公开邀战。" },
            { label: "02  应战", text: "对手发送 #应战，完整角色图鉴随后在群里统一发送一次。" },
            { label: "03  暗配队", text: "双方各自私聊 bot 发 4 个编号或角色名，例如 14 5 9 1；顺序就是 1~4 号位。" },
            { label: "04  揭晓", text: `双方都提交后公开阵容并随机先手；行动图直接进入先手回合，满编显示先手可用 2、后手预计 ${CFG.COST_START + CFG.SECOND_BONUS + 2} Cost。` },
          ],
        },
        {
          title: "统一口径",
          accent: "#66D2C0",
          height: 360,
          items: [
            { label: "回合", text: "一方从 Cost 回复到状态、冷却结算，完成一次行动，叫 1 回合。" },
            { label: "轮", text: "先手与后手各完成 1 回合，合起来才叫 1 轮。" },
            { label: "结算图", text: "开局和每个回合结算后都只发 1 张图，不再附文字战报；箭头回放刚结束的行动。" },
          ],
        },
        {
          title: "角色如何行动",
          accent: "#F2C85B",
          height: 610,
          items: [
            { label: "对位", text: "普攻与普通技能锁定对应号位；嘲讽可改目标，EX 按技能规则指定。" },
            { label: "优先级", text: "EX → 普通技能 → 普攻；同一角色在一个回合中只执行一种动作。" },
            { label: "释放 EX", text: "该角色本回合不再触发小技能或普攻；已就绪小技能保留到其下个回合。" },
            { label: "自动行动", text: "没放 EX 且小技能就绪时，小技能替代普攻；未就绪时才进行普攻。" },
            { label: "眩晕", text: "目标下一次行动跳过且不能放 EX；若小技能正好就绪，本次技能被吞掉并重置冷却。" },
          ],
        },
      ],
    },
    {
      tab: "COMMAND / COST",
      title: "指令与 EX 窗口",
      subtitle: "群内公开出招；每次释放后，按实时窗口继续判断",
      sections: [
        {
          title: "出招指令",
          accent: "#58B8F6",
          height: 450,
          labelWidth: 205,
          items: [
            { label: "过", text: "本回合不释放 EX；Cost 仍按正常规则回复。" },
            { label: "ex 1", text: "窗口内 1 号位释放 EX，目标采用技能默认规则。" },
            { label: "ex 1>3", text: "1 号位释放 EX，并指定敌方 3 号位。" },
            { label: "ex 2>友3", text: "2 号位释放治疗或护盾 EX，指定己方 3 号位。" },
            { label: "ex 1>3 4", text: "先让 1 号位打敌 3，再按图中公开补牌顺序释放 4 号位。" },
          ],
        },
        {
          title: "Cost 与常用入口",
          accent: "#F2C85B",
          height: 380,
          labelWidth: 205,
          items: [
            { label: "自动回复", text: `行动图显示已计入本回合回复的可用值；每回合回复存活人数 × ${CFG.COST_REGEN_PER_UNIT}，满编 +2。` },
            { label: "开局补偿", text: `底层起始值先手 ${CFG.COST_START}、后手 ${CFG.COST_START + CFG.SECOND_BONUS}；开局图已进入先手回合，显示 2 / ${CFG.COST_START + CFG.SECOND_BONUS + 2}。` },
            { label: "额外回费", text: "共鸣的小技能回复 3 Cost；即使伤害显示 MISS，回费仍然生效。" },
            { label: "其他指令", text: "#档案图鉴 [角色]（群聊）　#档案攻略　#认输　#结束对战" },
          ],
        },
        {
          title: "两格 EX 窗口",
          accent: "#A978E6",
          height: 530,
          items: [
            { label: "2 / 4", text: "每队 4 张角色 EX 牌；窗口展示 2 张，旁边公开剩余补牌顺序。" },
            { label: "只能选窗口", text: "角色在队伍里不等于随时能放；出招必须命中当前窗口。" },
            { label: "用后补牌", text: "用掉一张后立即补一张；照着补牌顺序可在一条指令中连续释放。" },
            { label: "轮回", text: "满编时同一角色最早隔 2 次 EX 回来，但每个回合最多释放一次。" },
            { label: "减员", text: "阵亡角色的牌会从窗口、牌库与弃牌区移除，存活者轮牌随之加快。" },
          ],
        },
      ],
    },
    {
      tab: "HUD / STATUS",
      title: "战场图与状态",
      subtitle: "颜色先看攻击与装甲；图标只表达层数，不表达剩余时间",
      sections: [
        {
          title: "属性相克与血条",
          accent: "#F07A83",
          height: 375,
          labelWidth: 230,
          items: [
            { label: "爆发 → 轻装", text: `红色 WEAK ×${strong}　｜　重装 RESIST ×${resist}`, color: ATTACK_VISUAL.爆发.color },
            { label: "贯通 → 重装", text: `黄色 WEAK ×${strong}　｜　特殊 RESIST ×${resist}`, color: ATTACK_VISUAL.贯通.color },
            { label: "神秘 → 特殊", text: `蓝色 WEAK ×${strong}　｜　轻装 RESIST ×${resist}`, color: ATTACK_VISUAL.神秘.color },
            { label: "振动 → 弹力", text: `紫色 WEAK ×${strong}　｜　特殊 RESIST ×${resist}`, color: ATTACK_VISUAL.振动.color },
          ],
        },
        {
          title: "战报图怎么读",
          accent: "#58B8F6",
          height: 350,
          labelWidth: 205,
          items: [
            { label: "伤害箭头", text: "颜色跟随攻击属性；多段伤害逐段写数字，不会合并。" },
            { label: "伤害标记", text: "WEAK / RESIST 表示克制；暴击数字放大并标 CRIT；闪避显示 MISS。" },
            { label: "治疗 / 范围", text: "治疗使用绿色箭头与绿色数字、不带 +；范围技能先圈目标区再连箭头。", color: "#52DB7C" },
            { label: "红色 !", text: "敌方普通技能已就绪，预警它在接下来的敌方回合可能释放。", color: "#F05B5B" },
          ],
        },
        {
          title: "状态规则",
          accent: "#66D2C0",
          height: 635,
          labelWidth: 205,
          items: [
            { label: "命中", text: "同一角色的三类攻击共用面板命中；MISS 只取消伤害，附加的减益仍生效。" },
            { label: "Buff / Debuff", text: "施放瞬间生效；进攻 Buff 与即时属性 Debuff 把当前回合算作第 1 回合。" },
            { label: "刷新与层数", text: "同一施加者刷新；不同施加者同类效果分层乘算。角标只写层数，最后一回合图标变浅。" },
            { label: "护盾", text: "白色假血条独立在真血上方，满盾时与真血等长；按敌方回合计时，重复施加以后一次为准。", color: "#F4F7FF" },
            { label: "灼烧", text: "从施加者下个自身回合的行动时点开始跳伤；固定命中，施加者眩晕或阵亡也不延后。", color: "#E9854F" },
            { label: "眩晕", text: "吞掉目标下一次行动；若普通技能当时就绪，也视为已经释放并重新进入完整冷却。", color: "#F081A4" },
          ],
        },
      ],
    },
  ]
}

export class BaBattleImageGenerator {
  constructor() {
    ensureFont()
    this.assetCache = new Map()
    this.cardCache = new Map()
    this.guidePageCache = null
  }

  async loadCharacterAsset(id) {
    if (!this.assetCache.has(id)) {
      this.assetCache.set(id, this.readCharacterAsset(id))
    }
    return this.assetCache.get(id)
  }

  async readCharacterAsset(id) {
    const file = path.join(ASSET_DIR, `${id}.png`)
    if (!fs.existsSync(file)) return null
    try {
      const image = await loadImage(file)
      const middle = this.characterSplit(image)
      return {
        image,
        portrait: this.alphaBounds(image, 0, 0, Math.max(1, middle - 6), image.height),
        chibi: this.alphaBounds(image, middle + 6, 0, Math.max(1, image.width - middle - 6), image.height),
      }
    } catch (error) {
      globalThis.logger?.warn?.(`[档案对战] 角色资产 ${id} 加载失败：${error.message}`)
      return null
    }
  }

  /** 在双形态透明图的中部寻找留白带，避免长武器越过画布中线时被裁掉。 */
  characterSplit(image) {
    const canvas = createCanvas(image.width, image.height)
    const ctx = canvas.getContext("2d")
    ctx.drawImage(image, 0, 0)
    const pixels = ctx.getImageData(0, 0, image.width, image.height).data
    const from = Math.floor(image.width * 0.35)
    const to = Math.floor(image.width * 0.72)
    const clear = []
    for (let x = from; x <= to; x++) {
      let occupied = 0
      for (let y = 0; y < image.height; y += 3) {
        if (pixels[(y * image.width + x) * 4 + 3] >= 16 && ++occupied > 2) break
      }
      clear.push(occupied <= 2)
    }

    let bestStart = -1
    let bestEnd = -1
    let runStart = -1
    for (let i = 0; i <= clear.length; i++) {
      if (clear[i] && runStart < 0) runStart = i
      if ((!clear[i] || i === clear.length) && runStart >= 0) {
        const runEnd = i - 1
        if (runEnd - runStart > bestEnd - bestStart) {
          bestStart = runStart
          bestEnd = runEnd
        }
        runStart = -1
      }
    }
    if (bestStart >= 0 && bestEnd - bestStart >= 5) {
      return from + Math.floor((bestStart + bestEnd) / 2)
    }
    return Math.floor(image.width / 2)
  }

  alphaBounds(image, sx, sy, sw, sh) {
    const canvas = createCanvas(sw, sh)
    const ctx = canvas.getContext("2d")
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh)
    const pixels = ctx.getImageData(0, 0, sw, sh).data
    let left = sw
    let top = sh
    let right = -1
    let bottom = -1
    for (let y = 0; y < sh; y += 2) {
      for (let x = 0; x < sw; x += 2) {
        if (pixels[(y * sw + x) * 4 + 3] < 16) continue
        left = Math.min(left, x)
        top = Math.min(top, y)
        right = Math.max(right, x)
        bottom = Math.max(bottom, y)
      }
    }
    if (right < left || bottom < top) return { sx, sy, sw, sh }
    const pad = 10
    left = Math.max(0, left - pad)
    top = Math.max(0, top - pad)
    right = Math.min(sw - 1, right + pad)
    bottom = Math.min(sh - 1, bottom + pad)
    return {
      sx: sx + left,
      sy: sy + top,
      sw: right - left + 1,
      sh: bottom - top + 1,
    }
  }

  drawAssetPart(ctx, asset, part, x, y, width, height, options = {}) {
    if (!asset?.image || !asset?.[part]) return false
    const source = asset[part]
    const scale = Math.min(width / source.sw, height / source.sh) * (options.scale || 1)
    const drawWidth = source.sw * scale
    const drawHeight = source.sh * scale
    const drawX = x + (width - drawWidth) / 2 + (options.offsetX || 0)
    const drawY = y + height - drawHeight + (options.offsetY || 0)
    ctx.save()
    if (options.alpha != null) ctx.globalAlpha = options.alpha
    if (options.flipX) {
      ctx.translate(drawX + drawWidth, 0)
      ctx.scale(-1, 1)
      ctx.drawImage(
        asset.image,
        source.sx,
        source.sy,
        source.sw,
        source.sh,
        0,
        drawY,
        drawWidth,
        drawHeight
      )
    } else {
      ctx.drawImage(
        asset.image,
        source.sx,
        source.sy,
        source.sw,
        source.sh,
        drawX,
        drawY,
        drawWidth,
        drawHeight
      )
    }
    ctx.restore()
    return true
  }

  drawCharacterFallback(ctx, tmpl, x, y, width, height, chibi = false) {
    const attack = ATTACK_VISUAL[tmpl.atkType]
    const armor = ARMOR_VISUAL[tmpl.defType]
    const size = Math.min(width, height) * (chibi ? 0.55 : 0.7)
    const cx = x + width / 2
    const cy = y + height * 0.52
    const gradient = ctx.createLinearGradient(cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2)
    gradient.addColorStop(0, attack.color)
    gradient.addColorStop(1, chibi ? armor.color : mix(attack.color, "#FFFFFF", 0.25))
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(cx, cy, size / 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = "rgba(255,255,255,0.94)"
    ctx.font = font(chibi ? 54 : 72, "bold")
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(tmpl.name.slice(0, 1), cx, cy + 2)
  }

  drawMapBackground(ctx, state) {
    // 战场只保留纯白底，让角色、血条和行动回放成为唯一视觉重点。
    ctx.fillStyle = "#FFFFFF"
    ctx.fillRect(0, 0, MAP_WIDTH, 1420)

    // 操作区继续使用纯色深蓝，和白色战场做清晰但克制的分区。
    ctx.fillStyle = "#102A43"
    ctx.fillRect(0, 1420, MAP_WIDTH, MAP_HEIGHT - 1420)
    ctx.fillStyle = state.round >= CFG.SD_START ? "#EF6B5B" : "#47B3E8"
    ctx.fillRect(0, 1420, MAP_WIDTH, 5)
  }

  drawHeader(ctx, state) {
    polygonPath(ctx, [[34, 24], [1124, 24], [1166, 61], [1166, 130], [76, 130], [34, 96]])
    ctx.fillStyle = "rgba(8,25,43,0.90)"
    ctx.fill()
    polygonPath(ctx, [[34, 24], [1124, 24], [1141, 39], [49, 39]])
    ctx.fillStyle = "#58C5ED"
    ctx.fill()

    ctx.fillStyle = "#F7FBFE"
    ctx.font = font(19, "bold")
    ctx.textAlign = "left"
    ctx.fillText("BATTLE", 67, 69)
    ctx.font = font(43, "bold")
    ctx.fillText(String(state.round).padStart(2, "0"), 66, 112)
    ctx.fillStyle = "#91B7CE"
    ctx.font = font(13, "bold")
    ctx.fillText("轮数", 124, 107)

    const drawTeamBar = (sideIndex, y) => {
      const side = state.sides[sideIndex]
      const visual = SIDE_VISUAL[sideIndex]
      const hp = side.units.reduce((sum, unit) => sum + Math.max(0, unit.hp), 0)
      const maxhp = side.units.reduce((sum, unit) => sum + unit.maxhp, 0)
      const ratio = maxhp > 0 ? clamp(hp / maxhp) : 0
      ctx.fillStyle = visual.color
      ctx.font = font(15, "bold")
      ctx.textAlign = "right"
      const sideLabel = `${visual.name} ${side.name}`
      let clipped = sideLabel
      while (clipped.length > 2 && ctx.measureText(clipped).width > 176) clipped = `${clipped.slice(0, -2)}…`
      ctx.fillText(clipped, 370, y + 13)
      fillRounded(ctx, 390, y, 454, 18, 9, "rgba(255,255,255,0.13)")
      if (ratio > 0) {
        const gradient = ctx.createLinearGradient(390, y, 844, y)
        gradient.addColorStop(0, mix(visual.color, "#FFFFFF", 0.28))
        gradient.addColorStop(1, visual.color)
        fillRounded(ctx, 390, y, Math.max(18, 454 * ratio), 18, 9, gradient)
      }
      ctx.fillStyle = "#DDEBF3"
      ctx.font = font(13, "bold")
      ctx.textAlign = "left"
      ctx.fillText(`${Math.round(ratio * 100)}%`, 856, y + 14)
    }
    drawTeamBar(1, 54)
    drawTeamBar(0, 91)

    const activeText = state.phase === "done"
      ? state.winner === -1 ? "DRAW" : `${SIDE_VISUAL[state.winner]?.name || ""} WIN`
      : `${SIDE_VISUAL[state.activeSide].name}行动`
    const activeColor = state.phase === "done"
      ? "#F5CE59"
      : SIDE_VISUAL[state.activeSide].color
    fillRounded(ctx, 933, 51, 190, 49, 11, "rgba(255,255,255,0.08)")
    strokeRounded(ctx, 933, 51, 190, 49, 11, activeColor, 2)
    ctx.fillStyle = activeColor
    ctx.font = font(fitText(ctx, activeText, 158, 20, 15), "bold")
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(activeText, 1028, 76)
    ctx.textBaseline = "alphabetic"

    if (state.round >= CFG.SD_START) {
      const level = state.round - CFG.SD_START + 1
      drawPill(ctx, `白热化 ×${level}`, 931, 105, {
        fill: "rgba(238,84,71,0.20)", color: "#FF9B88", border: "#EF6B5B",
        size: 13, height: 25, paddingX: 10,
      })
    }
  }

  drawSideSummary(ctx, state, sideIndex, x, y, width, height) {
    const side = state.sides[sideIndex]
    const visual = SIDE_VISUAL[sideIndex]
    const active = state.phase === "command" && state.activeSide === sideIndex
    const storedCost = Math.max(0, Math.min(CFG.COST_MAX, Math.floor(side.cost)))
    const available = state.phase === "command" ? turnCostOf(side) : storedCost

    polygonPath(ctx, [[x + 24, y], [x + width, y], [x + width - 22, y + height], [x, y + height]])
    ctx.fillStyle = active ? "rgba(10,32,51,0.88)" : "rgba(14,34,49,0.72)"
    ctx.fill()
    ctx.strokeStyle = active ? visual.color : "rgba(255,255,255,0.48)"
    ctx.lineWidth = active ? 3 : 1.4
    ctx.stroke()
    ctx.fillStyle = visual.color
    ctx.fillRect(x + 16, y + 10, 6, height - 20)

    ctx.fillStyle = "#F5FAFC"
    ctx.font = font(20, "bold")
    ctx.textAlign = "left"
    let sideName = `${visual.name} · ${side.name}`
    while (sideName.length > 2 && ctx.measureText(sideName).width > 240) sideName = `${sideName.slice(0, -2)}…`
    ctx.fillText(sideName, x + 38, y + 28)
    ctx.fillStyle = active ? visual.color : "#B9CED9"
    ctx.font = font(13, "bold")
    ctx.fillText(`${state.first === sideIndex ? "先手" : "后手"}${active ? " · 行动中" : ""}`, x + 38, y + 50)

    ctx.fillStyle = "#AFC5D1"
    ctx.font = font(12, "bold")
    ctx.fillText("COST", x + 300, y + 18)
    ctx.fillStyle = "#FFFFFF"
    ctx.font = font(25, "bold")
    ctx.fillText(`${available}`, x + 300, y + 47)
    ctx.fillStyle = "#AFC5D1"
    ctx.font = font(12, "bold")
    ctx.fillText(
      `/ ${CFG.COST_MAX}　${active ? "本回合" : state.phase === "command" ? "下回合预计" : "结算值"}`,
      x + 331,
      y + 46
    )

    const hand = exHandOf(state, sideIndex).filter((pos) => side.units[pos]?.alive)
    const queue = exDrawQueueOf(state, sideIndex).filter((pos) => side.units[pos]?.alive)
    ctx.fillStyle = "#AFC5D1"
    ctx.font = font(12, "bold")
    ctx.fillText("PUBLIC EX WINDOW", x + 474, y + 18)
    ctx.textAlign = "right"
    ctx.fillText(
      queue.length ? `NEXT ${queue.map((pos) => pos + 1).join(" → ")}` : "NEXT 回补当前牌",
      x + width - 20,
      y + 18
    )
    ctx.textAlign = "left"
    for (let index = 0; index < CFG.EX_HAND_SIZE; index++) {
      const pos = hand[index]
      const cardX = x + 474 + index * 226
      if (pos == null) {
        fillRounded(ctx, cardX, y + 25, 210, 29, 8, "rgba(255,255,255,0.08)")
        continue
      }
      const unit = side.units[pos]
      const tmpl = tmplOf(unit)
      const ready = unit.alive && unit.stun <= 0 && available >= tmpl.ex.cost
      fillRounded(ctx, cardX, y + 25, 210, 29, 8, ready ? visual.soft : "rgba(255,255,255,0.08)")
      strokeRounded(ctx, cardX, y + 25, 210, 29, 8, ready ? visual.color : "rgba(255,255,255,0.20)", 1)
      fillRounded(ctx, cardX + 4, y + 28, 36, 23, 7, ready ? visual.color : "#566D7B")
      ctx.fillStyle = "#FFFFFF"
      ctx.font = font(13, "bold")
      ctx.textAlign = "center"
      ctx.fillText(String(tmpl.ex.cost), cardX + 22, y + 45)
      ctx.textAlign = "left"
      ctx.fillStyle = ready ? "#F8FCFF" : "#9EB1BC"
      ctx.font = font(14, "bold")
      ctx.fillText(`${pos + 1}.${tmpl.name}${unit.stun > 0 ? " · 晕" : ""}`, cardX + 48, y + 45)
    }
  }

  drawHealthBar(ctx, unit, tmpl, x, y, width) {
    const armor = ARMOR_VISUAL[tmpl.defType]
    const ratio = unit.maxhp > 0 ? clamp(unit.hp / unit.maxhp) : 0
    fillRounded(ctx, x, y, width, 17, 8.5, "rgba(7,20,31,0.82)")
    if (ratio > 0) {
      const fillWidth = Math.max(17, width * ratio)
      const gradient = ctx.createLinearGradient(x, y, x + fillWidth, y)
      gradient.addColorStop(0, mix(armor.color, "#FFFFFF", 0.22))
      gradient.addColorStop(1, armor.color)
      fillRounded(ctx, x, y, Math.min(width, fillWidth), 17, 8.5, gradient)
    }
    strokeRounded(ctx, x, y, width, 17, 8.5, "rgba(255,255,255,0.88)", 2)
  }

  async drawUnitCard(ctx, state, sideIndex, unit, x, y, width, height) {
    const tmpl = tmplOf(unit)
    const armor = ARMOR_VISUAL[tmpl.defType]
    const artY = y + 74
    const opponent = state.phase === "command" && sideIndex !== state.activeSide
    const skillWarning = this.shouldShowSkillWarning(state, sideIndex, unit)

    ctx.save()
    ctx.globalAlpha = unit.alive ? 1 : 0.34
    ctx.fillStyle = "rgba(24,52,59,0.20)"
    ctx.beginPath()
    ctx.ellipse(x + width / 2, y + height - 18, width * 0.37, 22, 0, 0, Math.PI * 2)
    ctx.fill()
    const asset = await this.loadCharacterAsset(tmpl.id)
    const drawn = this.drawAssetPart(ctx, asset, "chibi", x + 3, artY, width - 6, height - 73, {
      scale: sideIndex === 1 ? 0.98 : 1.04,
      flipX: sideIndex === 1,
    })
    if (!drawn) this.drawCharacterFallback(ctx, tmpl, x + 3, artY, width - 6, height - 73, true)
    ctx.restore()

    if (skillWarning) this.drawSkillWarning(ctx, x + width / 2, y + 91)

    // 血条上方只放状态标识；身份依靠位置编号和角色小人识别。
    // 敌方就绪小技能改用小人上方的红色感叹号预警，避免再与蓝色“技”重复提示。
    const statuses = this.unitStatusIcons(unit).filter((status) => !(opponent && status.key === "skill"))
    let iconX = x + 10
    for (const status of statuses.slice(0, 5)) {
      this.drawStatusIcon(ctx, status, iconX, y + 2, 30)
      iconX += 34
    }
    fillRounded(ctx, x + width - 43, y + 4, 32, 27, 8, unit.alive ? armor.color : "#66747B")
    ctx.fillStyle = "#FFFFFF"
    ctx.font = font(15, "bold")
    ctx.textAlign = "center"
    ctx.fillText(String(unit.idx + 1), x + width - 27, y + 23)
    if (unit.shield > 0) {
      const shieldMax = Math.max(Number(unit.shieldMax) || 0, Number(unit.shield) || 0, 1)
      const shieldRatio = clamp(unit.shield / shieldMax)
      const shieldX = x + 14
      const shieldWidth = width - 28
      // 满容量时与真血条等长；受击后按剩余护盾 / 本次初始容量缩短。
      fillRounded(ctx, shieldX, y + BATTLE_LAYOUT.shieldBarOffsetY, shieldWidth, 8, 4, "rgba(20,42,53,0.72)")
      fillRounded(ctx, shieldX, y + BATTLE_LAYOUT.shieldBarOffsetY, Math.max(8, shieldWidth * shieldRatio), 8, 4, "#FFFFFF")
    }
    this.drawHealthBar(ctx, unit, tmpl, x + 14, y + BATTLE_LAYOUT.healthBarOffsetY, width - 28)
  }

  shouldShowSkillWarning(state, sideIndex, unit) {
    return state.phase === "command" &&
      sideIndex !== state.activeSide &&
      unit.alive &&
      unit.stun <= 0 &&
      unit.skillCd <= 0
  }

  drawSkillWarning(ctx, x, y) {
    ctx.save()
    ctx.shadowColor = "rgba(255,44,66,0.72)"
    ctx.shadowBlur = 16
    ctx.beginPath()
    ctx.arc(x, y, 20, 0, Math.PI * 2)
    ctx.fillStyle = "rgba(255,255,255,0.96)"
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.strokeStyle = "#FF334D"
    ctx.lineWidth = 4
    ctx.stroke()
    ctx.fillStyle = "#EF233C"
    ctx.font = font(29, "bold")
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText("!", x, y + 1)
    ctx.restore()
  }

  unitStatusIcons(unit) {
    // 阵亡已经由角色灰化和空血条表达，不再额外显示“倒”或 DOWN 标记。
    if (!unit.alive) return []
    const icons = []
    if (unit.shield > 0) icons.push({ key: "shield", label: "盾", expiring: unit.shieldTurns === 1, tone: "shield" })
    if (unit.stun > 0) icons.push({ key: "stun", label: "晕", expiring: unit.stun === 1, tone: "bad" })
    if (unit.taunt > 0) icons.push({ key: "taunt", label: "嘲", expiring: unit.taunt === 1, tone: "bad" })
    if (unit.reflect > 0) icons.push({ key: "reflect", label: "返", expiring: unit.reflectTurns === 1, tone: "good" })
    if (unit.dots?.length) {
      const layers = new Map()
      for (const dot of unit.dots) layers.set(dot.sourceKey, dot)
      const active = [...layers.values()]
      icons.push({
        key: "dot",
        label: "灼",
        layers: active.length,
        expiring: active.every((dot) => dot.turns === 1),
        tone: "bad",
      })
    }
    const grouped = new Map()
    for (const buff of unit.buffs || []) {
      if ((buff.turns || 0) >= 9999) continue
      const effectKind = buff.effectKind
      const key = `${effectKind}:${buff.stat}`
      const current = grouped.get(key) || { stat: buff.stat, effectKind, layers: new Map() }
      current.layers.set(buff.sourceKey, buff)
      grouped.set(key, current)
    }
    const names = { atk: "攻", dfs: "防", dmg_deal: "伤", dmg_take: "受" }
    for (const [key, data] of grouped) {
      const layers = [...data.layers.values()]
      icons.push({
        key,
        label: names[data.stat] || "效",
        layers: layers.length,
        expiring: layers.every((status) => status.turns === 1),
        tone: data.effectKind === "debuff" ? "bad" : "good",
      })
    }
    if (unit.skillCd <= 0) icons.push({ key: "skill", label: "技", tone: "ready" })
    return icons
  }

  drawStatusIcon(ctx, status, x, y, size) {
    const colors = {
      good: ["#53C99A", "#DFFFF3"],
      bad: ["#E66E77", "#FFE2E3"],
      ready: ["#4EA9E8", "#E1F5FF"],
      shield: ["#FFFFFF", "#FFFFFF"],
      neutral: ["#697984", "#E8EEF0"],
    }
    const [fill, textColor] = colors[status.tone] || colors.neutral
    ctx.save()
    // 不显示剩余回合数字；只在最后一个有效回合把整个图标淡化。
    if (status.expiring) ctx.globalAlpha = 0.48
    fillRounded(ctx, x, y, size, size, 8, "rgba(8,28,42,0.86)")
    strokeRounded(ctx, x, y, size, size, 8, fill, 2)
    ctx.fillStyle = textColor
    ctx.font = font(14, "bold")
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(status.label, x + size / 2, y + size / 2 + 1)
    ctx.textBaseline = "alphabetic"
    // 角标只代表来自不同施加者的层数，单层与不可叠加状态都不画角标。
    if (status.layers > 1) {
      ctx.beginPath()
      ctx.arc(x + size - 3, y + size - 3, 8, 0, Math.PI * 2)
      ctx.fillStyle = fill
      ctx.fill()
      ctx.fillStyle = "#FFFFFF"
      ctx.font = font(9, "bold")
      ctx.textBaseline = "middle"
      ctx.fillText(String(status.layers), x + size - 3, y + size - 2)
      ctx.textBaseline = "alphabetic"
    }
    ctx.restore()
  }

  drawArena(ctx, state) {
    ctx.save()
    ctx.setLineDash([9, 12])
    ctx.lineWidth = 2
    for (let index = 0; index < 4; index++) {
      const red = state.sides[1].units[index]
      const blue = state.sides[0].units[index]
      const alive = red?.alive && blue?.alive
      const x1 = BATTLE_LAYOUT.lanes[index]
      const y1 = BATTLE_LAYOUT.redGround[index] + 38
      const x2 = BATTLE_LAYOUT.lanes[index]
      const y2 = BATTLE_LAYOUT.blueGround[index] - 52
      const gradient = ctx.createLinearGradient(x1, y1, x2, y2)
      gradient.addColorStop(0, alive ? "rgba(230,94,103,0.40)" : "rgba(109,129,133,0.18)")
      gradient.addColorStop(1, alive ? "rgba(54,146,216,0.40)" : "rgba(109,129,133,0.18)")
      ctx.strokeStyle = gradient
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.bezierCurveTo(x1 - 26, 700, x2 + 26, 850, x2, y2)
      ctx.stroke()
    }
    ctx.restore()

    ctx.fillStyle = "rgba(19,60,75,0.70)"
    ctx.font = font(14, "bold")
    ctx.textAlign = "center"
    ctx.fillText("ENGAGEMENT LINE", 600, 806)
  }

  unitEffectPoint(ref) {
    if (!ref || !Number.isInteger(ref.pos) || (ref.side !== 0 && ref.side !== 1)) return null
    const ground = ref.side === 0 ? BATTLE_LAYOUT.blueGround[ref.pos] : BATTLE_LAYOUT.redGround[ref.pos]
    return {
      x: BATTLE_LAYOUT.lanes[ref.pos],
      y: ground - 92,
      side: ref.side,
      pos: ref.pos,
    }
  }

  drawArrowPath(ctx, from, to, color, offset = 0) {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const length = Math.max(1, Math.hypot(dx, dy))
    const nx = -dy / length
    const ny = dx / length
    const startX = from.x + dx * 0.22 + nx * offset
    const startY = from.y + dy * 0.22 + ny * offset
    const endX = from.x + dx * 0.78 + nx * offset
    const endY = from.y + dy * 0.78 + ny * offset
    const curveX = (startX + endX) / 2 + nx * (22 + Math.abs(offset) * 0.2)
    const curveY = (startY + endY) / 2 + ny * (22 + Math.abs(offset) * 0.2)

    ctx.save()
    ctx.shadowColor = color
    ctx.shadowBlur = 10
    ctx.strokeStyle = color
    ctx.lineWidth = 5
    ctx.lineCap = "round"
    ctx.beginPath()
    ctx.moveTo(startX, startY)
    ctx.quadraticCurveTo(curveX, curveY, endX, endY)
    ctx.stroke()
    const angle = Math.atan2(endY - curveY, endX - curveX)
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(endX, endY)
    ctx.lineTo(endX - 19 * Math.cos(angle - Math.PI / 6), endY - 19 * Math.sin(angle - Math.PI / 6))
    ctx.lineTo(endX - 19 * Math.cos(angle + Math.PI / 6), endY - 19 * Math.sin(angle + Math.PI / 6))
    ctx.closePath()
    ctx.fill()
    ctx.restore()
    return { x: curveX, y: curveY }
  }

  effectLabelLayout(ctx, event, anchor, index, total, shift = { x: 0, y: 0 }) {
    const isMiss = event.type === "miss"
    const isCost = event.type === "cost"
    const amount = isMiss ? "MISS" : isCost ? `COST ${event.amount}` : String(event.amount)
    const qualifier = event.affinity === "weak"
      ? "WEAK"
      : event.affinity === "resist"
        ? "RESIST"
        : event.burn
          ? "BURN"
          : ""
    const size = event.crit ? 25 : isMiss ? 17 : 16
    const rows = total > 3 ? 2 : 1
    const columns = Math.ceil(total / rows)
    const row = total > 3 ? index % 2 : 0
    const column = total > 3 ? Math.floor(index / 2) : index
    const offset = (column - (columns - 1) / 2) * 64
    const x = anchor.x + offset + (shift.x || 0)
    const y = anchor.y - 14 + row * 62 + (shift.y || 0)

    ctx.font = font(size, "bold")
    const amountWidth = ctx.measureText(amount).width
    ctx.font = font(11, "bold")
    const qualifierWidth = qualifier ? ctx.measureText(qualifier).width + 8 : 0
    const width = Math.max(42, amountWidth + 18, qualifierWidth + 16)
    const height = qualifier ? size + 25 : size + 13
    return { amount, qualifier, size, x, y, width, height }
  }

  effectLabelBounds(layout, event, padding = 7) {
    return {
      left: layout.x - layout.width / 2 - padding,
      right: layout.x + layout.width / 2 + padding,
      top: layout.y - layout.height / 2 - padding - (event.crit ? 15 : 0),
      bottom: layout.y + layout.height / 2 + padding,
    }
  }

  effectLabelsOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  }

  placeEffectLabels(ctx, jobs) {
    const occupied = []
    const placements = []
    const candidates = [
      { x: 0, y: 0 },
      { x: 0, y: -68 }, { x: 0, y: 68 },
      { x: -78, y: 0 }, { x: 78, y: 0 },
      { x: -78, y: -68 }, { x: 78, y: -68 },
      { x: -78, y: 68 }, { x: 78, y: 68 },
      { x: 0, y: -136 }, { x: 0, y: 136 },
      { x: -156, y: 0 }, { x: 156, y: 0 },
    ]

    for (const job of jobs) {
      let shift = candidates[0]
      let bounds = null
      for (const candidate of candidates) {
        const layout = this.effectLabelLayout(ctx, job.event, job.anchor, job.index, job.total, candidate)
        const nextBounds = this.effectLabelBounds(layout, job.event)
        const insideArena = nextBounds.left >= 28 && nextBounds.right <= MAP_WIDTH - 28 &&
          nextBounds.top >= 245 && nextBounds.bottom <= 1310
        if (insideArena && occupied.every((current) => !this.effectLabelsOverlap(nextBounds, current))) {
          shift = candidate
          bounds = nextBounds
          break
        }
      }
      const layout = this.effectLabelLayout(ctx, job.event, job.anchor, job.index, job.total, shift)
      const placedBounds = bounds || this.effectLabelBounds(layout, job.event)
      occupied.push(placedBounds)
      placements.push({ ...job, shift, bounds: placedBounds })
      this.drawEffectLabel(ctx, job.event, job.anchor, job.index, job.total, job.color, shift)
    }
    return placements
  }

  drawEffectLabel(ctx, event, anchor, index, total, color, shift = { x: 0, y: 0 }) {
    const { amount, qualifier, size, x, y, width, height } = this.effectLabelLayout(
      ctx,
      event,
      anchor,
      index,
      total,
      shift
    )

    ctx.save()
    fillRounded(ctx, x - width / 2, y - height / 2, width, height, 10, "rgba(8,24,36,0.88)")
    strokeRounded(ctx, x - width / 2, y - height / 2, width, height, 10, color, event.crit ? 3 : 1.5)
    ctx.fillStyle = color
    ctx.font = font(size, "bold")
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(amount, x, y - (qualifier ? 7 : 0))
    if (qualifier) {
      ctx.fillStyle = qualifier === "WEAK" ? "#FF9E88" : qualifier === "BURN" ? EFFECT_VISUAL.持续.color : "#C9D4D9"
      ctx.font = font(11, "bold")
      ctx.fillText(qualifier, x, y + size / 2 + 5)
    }
    if (event.crit) {
      ctx.fillStyle = "#FFE46C"
      ctx.font = font(10, "bold")
      ctx.fillText("CRIT", x, y - height / 2 - 7)
    }
    ctx.restore()
  }

  drawAreaEffect(ctx, targets, color, kind, source) {
    if (!targets.length) return null
    const minX = Math.min(...targets.map((point) => point.x)) - 95
    const maxX = Math.max(...targets.map((point) => point.x)) + 95
    const minY = Math.min(...targets.map((point) => point.y)) - 105
    const maxY = Math.max(...targets.map((point) => point.y)) + 120
    ctx.save()
    ctx.setLineDash([14, 9])
    fillRounded(ctx, minX, minY, maxX - minX, maxY - minY, 55, `${color}22`)
    strokeRounded(ctx, minX, minY, maxX - minX, maxY - minY, 55, color, 4)
    ctx.setLineDash([])
    ctx.fillStyle = color
    ctx.font = font(12, "bold")
    ctx.textAlign = "left"
    ctx.fillText(kind, minX + 20, minY + 27)
    ctx.restore()
    const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
    if (source) this.drawArrowPath(ctx, source, center, color)
    return center
  }

  drawSupportPulse(ctx, point, color) {
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = 4
    ctx.shadowColor = color
    ctx.shadowBlur = 12
    for (const radius of [58, 78]) {
      ctx.globalAlpha = radius === 58 ? 0.88 : 0.46
      ctx.beginPath()
      ctx.ellipse(point.x, point.y + 28, radius, radius * 0.42, 0, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.restore()
  }

  drawBattleEffects(ctx, state, events) {
    const list = Array.isArray(events) ? events : []
    if (!list.length) return
    const actions = []
    let current = null
    for (const event of list) {
      if (event?.type === "action") {
        current = { header: event, events: [] }
        actions.push(current)
      } else if (current && ["damage", "miss", "heal", "shield", "buff", "debuff", "cost"].includes(event?.type)) {
        current.events.push(event)
      } else if (!current && event?.type === "damage" && event.target) {
        actions.push({
          header: { source: event.target, action: "dot", kind: "damage", targetType: "self" },
          events: [event],
        })
      }
    }
    // 每次实际行动都保留；同一技能的多段命中共用轨迹、数字逐段排列。
    const visible = actions.filter((action) => action.events.length).slice(-8)
    const pairUse = new Map()
    const labelJobs = []

    for (const action of visible) {
      const source = this.unitEffectPoint(action.header.source)
      if (!source) continue
      const targetMap = new Map()
      for (const event of action.events) {
        const point = this.unitEffectPoint(event.target)
        if (!point) continue
        const key = `${point.side}:${point.pos}`
        if (!targetMap.has(key)) targetMap.set(key, { point, events: [] })
        targetMap.get(key).events.push(event)
      }
      const groups = [...targetMap.values()]
      if (!groups.length) continue
      const harmful = action.header.kind === "damage" || groups.some((group) => group.events.some((event) => ["damage", "miss", "debuff"].includes(event.type)))
      const type = harmful ? action.events.find((event) => event.attackType)?.attackType || tmplOf(state.sides[source.side].units[source.pos]).atkType : "治疗"
      const visual = harmful
        ? EFFECT_VISUAL[type] || EFFECT_VISUAL.持续
        : action.events.some((event) => event.type === "debuff")
          ? EFFECT_VISUAL.减益
          : action.events.some((event) => event.type === "heal")
            ? EFFECT_VISUAL.治疗
            : EFFECT_VISUAL.增益
      const isArea = ["enemy_all", "ally_all", "lane_splash"].includes(action.header.targetType)
      const repeatedPair = groups.length === 1 && groups[0].events.filter((event) => ["damage", "miss", "heal"].includes(event.type)).length > 1
      let areaCenter = null
      if (isArea) {
        areaCenter = this.drawAreaEffect(ctx, groups.map((group) => group.point), visual.color, harmful ? "AREA" : "SUPPORT", source)
      }

      for (const group of groups) {
        const groupHasDamage = group.events.some((event) => ["damage", "miss"].includes(event.type))
        const groupDamageType = group.events.find((event) =>
          ["damage", "miss"].includes(event.type) && event.attackType
        )?.attackType
        const groupVisual = groupHasDamage
          ? EFFECT_VISUAL[groupDamageType] || visual
          : group.events.some((event) => event.type === "heal")
            ? EFFECT_VISUAL.治疗
            : group.events.some((event) => event.type === "cost")
              ? EFFECT_VISUAL.Cost
            : group.events.some((event) => event.type === "debuff")
              ? EFFECT_VISUAL.减益
              : EFFECT_VISUAL.增益
        const key = `${source.side}:${source.pos}>${group.point.side}:${group.point.pos}`
        const used = pairUse.get(key) || 0
        pairUse.set(key, used + 1)
        let anchor
        if (isArea) {
          anchor = { x: group.point.x, y: group.point.y - 92 }
        } else if (source.side === group.point.side && source.pos === group.point.pos) {
          this.drawSupportPulse(ctx, group.point, groupVisual.color)
          anchor = { x: group.point.x, y: group.point.y - 108 }
        } else {
          anchor = this.drawArrowPath(ctx, source, group.point, groupVisual.color, repeatedPair ? 0 : used * 12)
        }
        const numeric = group.events.filter((event) => ["damage", "miss", "heal", "cost"].includes(event.type))
        numeric.forEach((event, index) => labelJobs.push({
          event,
          anchor: anchor || areaCenter || group.point,
          index,
          total: numeric.length,
          color: event.type === "heal"
            ? EFFECT_VISUAL.治疗.color
            : event.type === "cost"
              ? EFFECT_VISUAL.Cost.color
              : EFFECT_VISUAL[event.attackType]?.color || groupVisual.color,
        }))
      }
    }

    // 所有箭头、范围圈和脉冲先画完，最后统一画数字标签。
    // 否则 EX 的弯折轨迹或后续普攻直线会覆盖先前动作的伤害数字。
    this.placeEffectLabels(ctx, labelJobs)
  }

  drawArmorLegend(ctx, x, y) {
    ctx.fillStyle = "#8EB0C2"
    ctx.font = font(12, "bold")
    ctx.textAlign = "left"
    ctx.fillText("装甲血条", x, y + 14)
    let cursor = x + 73
    for (const [type, visual] of Object.entries(ARMOR_VISUAL)) {
      fillRounded(ctx, cursor, y + 4, 19, 11, 5.5, visual.color)
      ctx.fillStyle = "#C5D8E2"
      ctx.font = font(11, "bold")
      ctx.fillText(type, cursor + 24, y + 14)
      cursor += 82
    }
    fillRounded(ctx, cursor, y + 4, 19, 11, 5.5, "#FFFFFF")
    ctx.fillStyle = "#C5D8E2"
    ctx.fillText("护盾", cursor + 24, y + 14)
  }

  async drawExSkillIcon(ctx, state, sideIndex, pos, x, y, size) {
    const side = state.sides[sideIndex]
    const unit = side.units[pos]
    // 规则层会在阵亡时清牌并补位；绘制层再兜底，避免旧状态把阵亡头像带进窗口。
    if (!unit?.alive) return
    const tmpl = tmplOf(unit)
    const effect = EFFECT_VISUAL[tmpl.atkType]
    const active = state.phase === "command" && state.activeSide === sideIndex
    const available = active ? turnCostOf(side) : Math.floor(side.cost)
    const usable = active && unit.stun <= 0
    const progress = clamp(available / Math.max(1, tmpl.ex.cost))
    const ready = usable && progress >= 1
    const cx = x + size / 2
    const cy = y + size / 2
    const radius = size / 2 - 5
    const asset = await this.loadCharacterAsset(tmpl.id)
    const drawPortrait = (grayscale = false) => {
      ctx.save()
      if (grayscale) ctx.filter = "grayscale(1) brightness(0.62)"
      const drawn = this.drawAssetPart(ctx, asset, "chibi", x + 3, y + 4, size - 6, size - 8, { scale: 1.16 })
      if (!drawn) {
        if (grayscale) ctx.globalAlpha = 0.48
        this.drawCharacterFallback(ctx, tmpl, x + 3, y + 4, size - 6, size - 8, true)
      }
      ctx.restore()
    }

    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.clip()
    ctx.fillStyle = ready ? "#263A49" : "#465057"
    ctx.fillRect(x, y, size, size)

    if (ready) {
      ctx.fillStyle = effect.color
      ctx.globalAlpha = 0.72
      ctx.fillRect(x, y, size, size)
      ctx.globalAlpha = 1
      drawPortrait(false)
    } else {
      // 未就绪时整张头像灰显；当前 Cost 所占比例用属性色扇区从 12 点方向顺时针揭开。
      drawPortrait(true)
      ctx.fillStyle = "rgba(29,36,41,0.44)"
      ctx.fillRect(x, y, size, size)
      if (usable && progress > 0) {
        ctx.save()
        sectorPath(ctx, cx, cy, radius, progress)
        ctx.clip()
        ctx.fillStyle = effect.color
        ctx.globalAlpha = 0.58
        ctx.fillRect(x, y, size, size)
        ctx.globalAlpha = 1
        drawPortrait(false)
        ctx.fillStyle = effect.color
        ctx.globalAlpha = 0.18
        ctx.fillRect(x, y, size, size)
        ctx.restore()
      }
    }
    ctx.restore()

    ctx.save()
    if (ready) {
      ctx.shadowColor = effect.color
      ctx.shadowBlur = 18
    }
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.strokeStyle = ready ? "#FFFFFF" : "rgba(192,211,220,0.72)"
    ctx.lineWidth = ready ? 5 : 3
    ctx.stroke()
    if (!ready && usable && progress > 0) {
      ctx.beginPath()
      ctx.arc(cx, cy, radius - 1.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress)
      ctx.strokeStyle = effect.color
      ctx.lineWidth = 5
      ctx.stroke()
    }
    ctx.restore()

    ctx.beginPath()
    ctx.arc(x + size - 22, y + 23, 23, 0, Math.PI * 2)
    ctx.fillStyle = ready ? effect.color : "#61747E"
    ctx.fill()
    ctx.strokeStyle = "#FFFFFF"
    ctx.lineWidth = 2.5
    ctx.stroke()
    ctx.fillStyle = "#FFFFFF"
    ctx.font = font(22, "bold")
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(String(tmpl.ex.cost), x + size - 22, y + 24)
    ctx.textBaseline = "alphabetic"

    if (unit.stun > 0) {
      fillRounded(ctx, cx - 34, y + size - 28, 68, 23, 8, "rgba(9,25,37,0.88)")
      ctx.fillStyle = "#FFFFFF"
      ctx.font = font(10, "bold")
      ctx.textAlign = "center"
      ctx.fillText("眩晕", cx, y + size - 12)
    }
  }

  drawExDrawQueue(ctx, state, sideIndex, x, y, width) {
    const side = state.sides[sideIndex]
    const queue = exDrawQueueOf(state, sideIndex).filter((pos) => side.units[pos]?.alive)

    ctx.fillStyle = "#AFC5D1"
    ctx.font = font(12, "bold")
    ctx.textAlign = "left"
    ctx.fillText("补牌顺序", x, y + 16)

    if (!queue.length) {
      ctx.fillStyle = "#7593A4"
      ctx.font = font(11, "bold")
      ctx.fillText(state.phase === "done" ? "战斗已结束" : "用牌后由当前存活牌回补", x, y + 48)
      return
    }

    for (let index = 0; index < queue.length; index++) {
      const pos = queue[index]
      const tmpl = tmplOf(side.units[pos])
      const effect = EFFECT_VISUAL[tmpl.atkType]
      const rowY = y + 28 + index * 52
      fillRounded(ctx, x, rowY, width, 42, 10, "rgba(255,255,255,0.07)")
      strokeRounded(ctx, x, rowY, width, 42, 10, `${effect.color}AA`, 1.5)
      ctx.fillStyle = effect.color
      fillRounded(ctx, x + 5, rowY + 5, 74, 32, 8, effect.color)
      ctx.fillStyle = "#FFFFFF"
      ctx.font = font(11, "bold")
      ctx.textAlign = "center"
      ctx.fillText(index === 0 ? "下一张" : "随后", x + 42, rowY + 26)
      ctx.textAlign = "left"
      ctx.font = font(14, "bold")
      ctx.fillText(`${pos + 1}.${tmpl.name}`, x + 92, rowY + 26)
      ctx.textAlign = "right"
      ctx.fillStyle = "#C9DAE3"
      ctx.font = font(12, "bold")
      ctx.fillText(`${tmpl.ex.cost} COST`, x + width - 14, rowY + 26)
    }
  }

  drawCostGauge(ctx, state, sideIndex, x, y, width) {
    const side = state.sides[sideIndex]
    const visual = SIDE_VISUAL[sideIndex]
    const active = state.phase === "command" && state.activeSide === sideIndex
    const stored = Math.max(0, Math.min(CFG.COST_MAX, Math.floor(side.cost)))
    const available = active ? turnCostOf(side) : stored

    ctx.save()
    ctx.beginPath()
    ctx.arc(x + 48, y + 39, 43, 0, Math.PI * 2)
    ctx.fillStyle = "rgba(8,23,37,0.95)"
    ctx.fill()
    ctx.strokeStyle = visual.color
    ctx.lineWidth = 4
    ctx.stroke()
    ctx.fillStyle = "#FFFFFF"
    ctx.font = font(31, "bold")
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(String(available), x + 48, y + 36)
    ctx.fillStyle = "#AFC5D1"
    ctx.font = font(10, "bold")
    ctx.fillText("COST", x + 48, y + 61)
    ctx.textBaseline = "alphabetic"
    ctx.restore()

    const barX = x + 108
    const gap = 7
    const segmentWidth = (width - 108 - gap * (CFG.COST_MAX - 1)) / CFG.COST_MAX
    for (let index = 0; index < CFG.COST_MAX; index++) {
      const filled = index < available
      const bonus = filled && index >= stored
      const segmentX = barX + index * (segmentWidth + gap)
      polygonPath(ctx, [
        [segmentX + 6, y + 23],
        [segmentX + segmentWidth, y + 23],
        [segmentX + segmentWidth - 6, y + 52],
        [segmentX, y + 52],
      ])
      ctx.fillStyle = filled ? visual.color : "rgba(154,184,199,0.18)"
      ctx.fill()
      if (bonus) {
        ctx.strokeStyle = "#FFFFFF"
        ctx.lineWidth = 2
        ctx.stroke()
      }
    }
    ctx.fillStyle = "#91ADBC"
    ctx.font = font(11, "bold")
    ctx.textAlign = "left"
    ctx.fillText(
      active
        ? `本回合回复 +${regenOf(side)} · 当前可用 ${available}`
        : `结算 Cost ${stored}/${CFG.COST_MAX}`,
      barX,
      y + 72
    )
  }

  async drawCommandHud(ctx, state) {
    const sideIndex = state.phase === "done"
      ? state.winner === 0 || state.winner === 1 ? state.winner : state.activeSide
      : state.activeSide
    const side = state.sides[sideIndex]
    const visual = SIDE_VISUAL[sideIndex]
    const hand = exHandOf(state, sideIndex).filter((pos) => side.units[pos]?.alive)

    ctx.fillStyle = "#F5FAFD"
    ctx.font = font(17, "bold")
    ctx.textAlign = "left"
    ctx.fillText(state.phase === "done" ? "FINAL WINDOW" : `${visual.name.toUpperCase()} EX WINDOW`, 50, 1490)
    ctx.fillStyle = visual.color
    ctx.font = font(12, "bold")
    ctx.fillText(state.phase === "done" ? "战斗已结束" : `${side.name} · 圆角数字是 Cost，灰罩扇区显示充能进度`, 50, 1513)

    for (let index = 0; index < CFG.EX_HAND_SIZE; index++) {
      const pos = hand[index]
      if (pos == null) continue
      await this.drawExSkillIcon(ctx, state, sideIndex, pos, 330 + index * 218, 1458, 160)
    }

    this.drawExDrawQueue(ctx, state, sideIndex, 770, 1458, 374)
    this.drawCostGauge(ctx, state, sideIndex, 46, 1664, 1108)
    this.drawArmorLegend(ctx, 590, 1758)
    ctx.fillStyle = "#69899A"
    ctx.font = font(10, "bold")
    ctx.textAlign = "left"
    ctx.fillText(`SEED ${state.seed}`, 47, 1783)
    ctx.textAlign = "right"
    ctx.fillText("箭头与数值回放刚结算的行动", 1152, 1783)
  }

  async generateBattleMap(state, options = {}) {
    const canvas = createCanvas(MAP_WIDTH, MAP_HEIGHT)
    const ctx = canvas.getContext("2d")
    this.drawMapBackground(ctx, state)
    this.drawArena(ctx, state)
    this.drawHeader(ctx, state)

    this.drawSideSummary(ctx, state, 1, 92, 151, 1016, 65)
    const unitWidth = BATTLE_LAYOUT.unitWidth
    const unitHeight = BATTLE_LAYOUT.unitHeight
    for (let i = 0; i < 4; i++) {
      await this.drawUnitCard(
        ctx,
        state,
        1,
        state.sides[1].units[i],
        BATTLE_LAYOUT.lanes[i] - unitWidth / 2,
        BATTLE_LAYOUT.redGround[i] + BATTLE_LAYOUT.healthOffsetY,
        unitWidth,
        unitHeight
      )
    }

    for (let i = 0; i < 4; i++) {
      await this.drawUnitCard(
        ctx,
        state,
        0,
        state.sides[0].units[i],
        BATTLE_LAYOUT.lanes[i] - unitWidth / 2,
        BATTLE_LAYOUT.blueGround[i] + BATTLE_LAYOUT.healthOffsetY,
        unitWidth,
        unitHeight
      )
    }
    this.drawBattleEffects(ctx, state, options.events || [])
    this.drawSideSummary(ctx, state, 0, 92, 1332, 1016, 65)
    await this.drawCommandHud(ctx, state)
    return canvas.toBuffer("image/png")
  }

  drawCardBackground(ctx, tmpl) {
    const attack = ATTACK_VISUAL[tmpl.atkType]
    const gradient = ctx.createLinearGradient(0, 0, CARD_WIDTH, CARD_HEIGHT)
    gradient.addColorStop(0, mix(attack.color, "#10182B", 0.72))
    gradient.addColorStop(0.52, "#16243B")
    gradient.addColorStop(1, mix(attack.color, "#10182B", 0.86))
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)

    const glow = ctx.createRadialGradient(690, 350, 20, 690, 350, 520)
    glow.addColorStop(0, `${attack.color}55`)
    glow.addColorStop(1, "rgba(0,0,0,0)")
    ctx.fillStyle = glow
    ctx.fillRect(280, 0, 620, 900)

    ctx.save()
    ctx.globalAlpha = 0.09
    ctx.strokeStyle = "#D5E7F7"
    for (let i = -CARD_HEIGHT; i < CARD_WIDTH + CARD_HEIGHT; i += 72) {
      ctx.beginPath()
      ctx.moveTo(i, 0)
      ctx.lineTo(i + CARD_HEIGHT, CARD_HEIGHT)
      ctx.stroke()
    }
    ctx.restore()

    ctx.strokeStyle = attack.color
    ctx.lineWidth = 13
    roundedRect(ctx, 12, 12, CARD_WIDTH - 24, CARD_HEIGHT - 24, 34)
    ctx.stroke()
    ctx.strokeStyle = mix(attack.color, "#FFFFFF", 0.55)
    ctx.lineWidth = 2
    roundedRect(ctx, 25, 25, CARD_WIDTH - 50, CARD_HEIGHT - 50, 26)
    ctx.stroke()
  }

  drawStatCell(ctx, label, value, x, y, width, options = {}) {
    fillRounded(ctx, x, y, width, 72, 16, "rgba(7,14,27,0.68)")
    strokeRounded(ctx, x, y, width, 72, 16, "rgba(151,183,214,0.20)", 1)
    ctx.fillStyle = "#8FA6C0"
    ctx.font = font(15, "bold")
    ctx.textAlign = "left"
    ctx.fillText(label, x + 14, y + 24)
    ctx.fillStyle = options.color || "#F2F6FC"
    ctx.font = font(24, "bold")
    ctx.fillText(String(value), x + 14, y + 55)
  }

  drawSkillPanel(ctx, title, text, x, y, width, height, accent) {
    fillRounded(ctx, x, y, width, height, 20, "rgba(7,14,27,0.82)")
    strokeRounded(ctx, x, y, width, height, 20, `${accent}88`, 1.5)
    fillRounded(ctx, x + 14, y + 14, 8, height - 28, 4, accent)
    ctx.fillStyle = accent
    ctx.font = font(20, "bold")
    ctx.textAlign = "left"
    ctx.fillText(title, x + 38, y + 36)
    drawWrapped(ctx, text, x + 38, y + 70, width - 62, {
      size: 19,
      lineHeight: 27,
      maxLines: Math.max(1, Math.floor((height - 82) / 27) + 1),
      color: "#CDD9E8",
    })
  }

  async generateCharacterCard(tmpl) {
    if (this.cardCache.has(tmpl.id)) return this.cardCache.get(tmpl.id)
    const promise = this.renderCharacterCard(tmpl)
    this.cardCache.set(tmpl.id, promise)
    return promise
  }

  async renderCharacterCard(tmpl) {
    const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT)
    const ctx = canvas.getContext("2d")
    const armor = ARMOR_VISUAL[tmpl.defType]
    const attack = ATTACK_VISUAL[tmpl.atkType]
    const combatRole = combatRoleOf(tmpl)
    this.drawCardBackground(ctx, tmpl)

    const asset = await this.loadCharacterAsset(tmpl.id)
    const drawn = this.drawAssetPart(ctx, asset, "portrait", 350, 118, 520, 660, { scale: 1.02 })
    if (!drawn) this.drawCharacterFallback(ctx, tmpl, 350, 118, 520, 660, false)
    const artFade = ctx.createLinearGradient(0, 520, 0, 790)
    artFade.addColorStop(0, "rgba(17,29,48,0)")
    artFade.addColorStop(1, "rgba(17,29,48,0.98)")
    ctx.fillStyle = artFade
    ctx.fillRect(330, 480, 550, 315)

    const index = ROSTER.indexOf(tmpl) + 1
    drawPill(ctx, `NO.${String(index).padStart(2, "0")}`, 48, 47, {
      fill: "rgba(255,255,255,0.10)", color: "#CBD7E6", border: "rgba(255,255,255,0.18)", size: 17,
    })
    ctx.fillStyle = "#F8FAFD"
    ctx.font = font(fitText(ctx, tmpl.name, 450, 56, 38), "bold")
    ctx.textAlign = "left"
    ctx.fillText(tmpl.name, 48, 133)
    drawPill(ctx, combatRole, 48, 148, {
      fill: `${attack.color}24`, color: mix(attack.color, "#FFFFFF", 0.2), border: `${attack.color}88`,
      size: 16, height: 31, paddingX: 12,
    })

    let chipX = 48
    chipX += drawPill(ctx, `${tmpl.atkType}攻击`, chipX, 191, {
      fill: attack.soft, color: attack.color, size: 16, height: 31, paddingX: 11,
    }) + 8
    drawPill(ctx, armor.label, chipX, 191, {
      fill: armor.soft, color: armor.dark, border: armor.color, size: 16, height: 31, paddingX: 11,
    })

    const statX = 48
    const statWidth = 154
    const statGap = 10
    this.drawStatCell(ctx, "生命", `${tmpl.hp}`, statX, 248, statWidth * 2 + statGap, { color: attack.color })
    this.drawStatCell(ctx, "攻击", tmpl.atk, statX, 330, statWidth)
    this.drawStatCell(ctx, "防御", tmpl.dfs, statX + statWidth + statGap, 330, statWidth)
    this.drawStatCell(ctx, "命中", tmpl.acc, statX, 412, statWidth)
    this.drawStatCell(ctx, "闪避", tmpl.dodge, statX + statWidth + statGap, 412, statWidth)
    this.drawStatCell(ctx, "暴击", `${Math.round(tmpl.crit * 100)}%`, statX, 494, statWidth)
    this.drawStatCell(ctx, "EX Cost", tmpl.ex.cost, statX + statWidth + statGap, 494, statWidth, { color: attack.color })

    this.drawSkillPanel(
      ctx,
      `普通技能 · CD${tmpl.skill.cd}`,
      describeEffect(tmpl.skill),
      48,
      748,
      804,
      190,
      attack.color
    )
    this.drawSkillPanel(
      ctx,
      `EX 技能 · ${tmpl.ex.cost} Cost`,
      describeEffect(tmpl.ex),
      48,
      954,
      804,
      240,
      attack.color
    )
    ctx.fillStyle = "#758BA5"
    ctx.font = font(14)
    ctx.textAlign = "center"
    ctx.fillText("档案对战原创角色 · 普攻 / 普技 / EX 共用角色命中", CARD_WIDTH / 2, 1245)
    return canvas.toBuffer("image/png")
  }

  drawGuideBackground(ctx, page, index, total) {
    const gradient = ctx.createLinearGradient(0, 0, GUIDE_WIDTH, GUIDE_HEIGHT)
    gradient.addColorStop(0, "#071321")
    gradient.addColorStop(0.48, "#10253B")
    gradient.addColorStop(1, "#081522")
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, GUIDE_WIDTH, GUIDE_HEIGHT)

    const cyanGlow = ctx.createRadialGradient(1040, 110, 20, 1040, 110, 620)
    cyanGlow.addColorStop(0, "rgba(71, 184, 242, 0.24)")
    cyanGlow.addColorStop(1, "rgba(71, 184, 242, 0)")
    ctx.fillStyle = cyanGlow
    ctx.fillRect(350, 0, 850, 760)

    const blueGlow = ctx.createRadialGradient(80, 1660, 20, 80, 1660, 560)
    blueGlow.addColorStop(0, "rgba(75, 112, 210, 0.16)")
    blueGlow.addColorStop(1, "rgba(75, 112, 210, 0)")
    ctx.fillStyle = blueGlow
    ctx.fillRect(0, 1060, 720, 740)

    ctx.save()
    ctx.globalAlpha = 0.075
    ctx.strokeStyle = "#A6DDF8"
    ctx.lineWidth = 1
    for (let x = -GUIDE_HEIGHT; x < GUIDE_WIDTH + GUIDE_HEIGHT; x += 82) {
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x + GUIDE_HEIGHT, GUIDE_HEIGHT)
      ctx.stroke()
    }
    ctx.restore()

    drawPill(ctx, "档案攻略", 58, 50, {
      fill: "rgba(88,184,246,0.18)",
      border: "rgba(116,207,255,0.6)",
      color: "#BCEAFF",
      size: 19,
      height: 38,
      paddingX: 18,
    })
    drawPill(ctx, page.tab, 205, 50, {
      fill: "rgba(255,255,255,0.07)",
      color: "#8AA6C3",
      size: 16,
      height: 38,
      paddingX: 16,
    })

    ctx.save()
    ctx.textAlign = "right"
    ctx.fillStyle = "rgba(140, 213, 250, 0.14)"
    ctx.font = font(128, "bold")
    ctx.fillText(String(index + 1).padStart(2, "0"), 1145, 167)
    ctx.restore()

    ctx.fillStyle = "#F4F8FF"
    ctx.font = font(54, "bold")
    ctx.textAlign = "left"
    ctx.fillText(page.title, 58, 168)
    drawWrapped(ctx, page.subtitle, 60, 218, 900, {
      size: 23,
      lineHeight: 31,
      color: "#91ABC6",
      maxLines: 1,
    })

    const rule = ctx.createLinearGradient(58, 0, 1142, 0)
    rule.addColorStop(0, "rgba(88,184,246,0.9)")
    rule.addColorStop(0.42, "rgba(88,184,246,0.22)")
    rule.addColorStop(1, "rgba(88,184,246,0)")
    ctx.fillStyle = rule
    ctx.fillRect(58, 256, 1084, 3)

    ctx.fillStyle = "#6F89A7"
    ctx.font = font(16, "bold")
    ctx.textAlign = "right"
    ctx.fillText(`4V4 · v5　${index + 1} / ${total}`, 1142, 240)
  }

  drawGuideSection(ctx, section, x, y, width) {
    const height = section.height
    ctx.save()
    ctx.shadowColor = "rgba(0,0,0,0.24)"
    ctx.shadowBlur = 18
    ctx.shadowOffsetY = 7
    fillRounded(ctx, x, y, width, height, 25, "rgba(8, 24, 41, 0.90)")
    ctx.restore()
    strokeRounded(ctx, x, y, width, height, 25, "rgba(164, 208, 235, 0.14)", 1.4)
    fillRounded(ctx, x, y, 8, height, 4, section.accent)

    ctx.fillStyle = "#F0F6FF"
    ctx.font = font(29, "bold")
    ctx.textAlign = "left"
    ctx.fillText(section.title, x + 30, y + 45)

    ctx.fillStyle = "rgba(144, 190, 219, 0.55)"
    ctx.font = font(15, "bold")
    ctx.textAlign = "right"
    ctx.fillText(String(section.items.length).padStart(2, "0"), x + width - 28, y + 42)

    const headerHeight = 66
    const bottomPadding = 14
    const rowsHeight = height - headerHeight - bottomPadding
    const rowHeight = rowsHeight / section.items.length
    const labelWidth = section.labelWidth || 185

    section.items.forEach((item, itemIndex) => {
      const rowY = y + headerHeight + rowHeight * itemIndex
      if (itemIndex > 0) {
        ctx.strokeStyle = "rgba(152, 190, 218, 0.10)"
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x + 28, rowY)
        ctx.lineTo(x + width - 28, rowY)
        ctx.stroke()
      }

      const tone = item.color || section.accent
      const labelHeight = Math.min(44, rowHeight - 18)
      const labelY = rowY + (rowHeight - labelHeight) / 2
      fillRounded(
        ctx,
        x + 28,
        labelY,
        labelWidth,
        labelHeight,
        13,
        mix(tone, "#0A192A", 0.76)
      )
      strokeRounded(ctx, x + 28, labelY, labelWidth, labelHeight, 13, mix(tone, "#FFFFFF", 0.15), 1.2)
      fillRounded(ctx, x + 39, labelY + 11, 5, labelHeight - 22, 3, tone)

      const labelSize = fitText(ctx, item.label, labelWidth - 38, 21, 15, "bold")
      ctx.font = font(labelSize, "bold")
      ctx.fillStyle = mix(tone, "#FFFFFF", 0.42)
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText(item.label, x + 28 + labelWidth / 2 + 6, labelY + labelHeight / 2 + 1)

      const bodyX = x + 28 + labelWidth + 28
      const bodyWidth = width - labelWidth - 112
      const bodySize = rowHeight >= 88 ? 22 : 21
      const lineHeight = Math.round(bodySize * 1.38)
      ctx.font = font(bodySize)
      const lineCount = Math.min(2, wrapText(ctx, item.text, bodyWidth, 2).length || 1)
      const bodyY = rowY + rowHeight / 2 - ((lineCount - 1) * lineHeight) / 2 + 8
      drawWrapped(ctx, item.text, bodyX, bodyY, bodyWidth, {
        size: bodySize,
        lineHeight,
        color: "#C8D8E8",
        maxLines: 2,
      })
    })
  }

  renderGuidePage(page, index, total) {
    const canvas = createCanvas(GUIDE_WIDTH, GUIDE_HEIGHT)
    const ctx = canvas.getContext("2d")
    this.drawGuideBackground(ctx, page, index, total)

    let y = 290
    for (const section of page.sections) {
      this.drawGuideSection(ctx, section, 58, y, GUIDE_WIDTH - 116)
      y += section.height + 20
    }

    ctx.fillStyle = "rgba(157, 201, 228, 0.22)"
    ctx.fillRect(58, 1750, 1084, 1)
    for (let dot = 0; dot < total; dot++) {
      fillRounded(
        ctx,
        58 + dot * 28,
        1770,
        dot === index ? 20 : 8,
        8,
        4,
        dot === index ? "#58B8F6" : "#40566E"
      )
    }
    ctx.fillStyle = "#627C98"
    ctx.font = font(15, "bold")
    ctx.textAlign = "right"
    ctx.fillText("SAKURA ARCHIVE BATTLE", 1142, 1780)
    return canvas.toBuffer("image/webp", 92)
  }

  async generateGuidePages() {
    if (!this.guidePageCache) {
      const pages = guidePageDefinitions()
      this.guidePageCache = pages.map((page, index) => this.renderGuidePage(page, index, pages.length))
    }
    return this.guidePageCache
  }

  async generateRosterCards() {
    // Skia 的字体绘制在多张画布同时首绘时偶发缺字，顺序生成后缓存 Buffer。
    const cards = []
    for (const tmpl of ROSTER) cards.push(await this.generateCharacterCard(tmpl))
    return cards
  }
}

export const baBattleImageGenerator = new BaBattleImageGenerator()
