import { createCanvas, GlobalFonts } from "@napi-rs/canvas"
import path from "node:path"
import { pluginresources } from "../../path.js"
import {
  PHASES,
  PLAYER_STATUS,
} from "../constants.js"
import { buildPublicView } from "./PublicView.js"

const WIDTH = 1120
const HEIGHT = 780
const BOARD_X = 30
const BOARD_Y = 30
const CELL = 100
const PANEL_X = 755
const PANEL_WIDTH = 335
const FONT_FAMILY = "MonopolyRounded"

let fontReady = false

function ensureFont() {
  if (fontReady) return
  fontReady = true
  try {
    GlobalFonts.registerFromPath(
      path.join(
        pluginresources,
        "sign",
        "font",
        "FZFWZhuZiAYuanJWD.ttf"
      ),
      FONT_FAMILY
    )
  } catch (error) {
    globalThis.logger?.warn?.(
      `[大富翁] 字体加载失败，将使用系统字体：${error.message}`
    )
  }
}

function font(size, weight = "normal") {
  return `${weight} ${size}px "${FONT_FAMILY}", "Microsoft YaHei", sans-serif`
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

function fitText(ctx, text, maxWidth, startSize, minSize = 10) {
  let size = startSize
  while (size > minSize) {
    ctx.font = font(size, "bold")
    if (ctx.measureText(text).width <= maxWidth) break
    size -= 1
  }
  return size
}

function splitText(ctx, text, maxWidth, maxLines = 2) {
  const chars = Array.from(String(text))
  const lines = []
  let current = ""
  for (const char of chars) {
    const candidate = current + char
    if (current && ctx.measureText(candidate).width > maxWidth) {
      lines.push(current)
      current = char
      if (lines.length >= maxLines - 1) break
    } else {
      current = candidate
    }
  }
  const consumed = lines.join("").length + current.length
  if (current) {
    const truncated = consumed < chars.length
    lines.push(truncated ? `${current.slice(0, -1)}…` : current)
  }
  return lines.slice(0, maxLines)
}

function groupColor(map, tile) {
  if (tile.type !== "property") return null
  return (
    map.propertyGroups.find((group) => group.id === tile.groupId)?.color ||
    "#90A4AE"
  )
}

function tileBackground(tile) {
  const colors = {
    start: "#FFF3E0",
    chance: "#EDE7F6",
    tax: "#FFEBEE",
    bonus: "#E8F5E9",
    jail: "#ECEFF1",
    go_to_jail: "#FBE9E7",
    rest: "#E0F2F1",
    property: "#FFFFFF",
  }
  return colors[tile.type] || "#FFFFFF"
}

function tileIcon(tile) {
  const icons = {
    start: "起",
    chance: "?",
    tax: "税",
    bonus: "奖",
    jail: "牢",
    go_to_jail: "捕",
    rest: "休",
  }
  return icons[tile.type] || ""
}

function drawTile(ctx, map, view, tile) {
  const x = BOARD_X + tile.position.x * CELL
  const y = BOARD_Y + tile.position.y * CELL
  const propertyState = view.propertyStates[String(tile.id)]
  const isCurrentTile = view.players.some(
    (player) =>
      player.userId === view.currentPlayerId && player.position === tile.id
  )
  const isPending = view.pendingDecision?.tileId === tile.id

  ctx.fillStyle = tileBackground(tile)
  ctx.fillRect(x, y, CELL, CELL)
  ctx.strokeStyle = "#B0BEC5"
  ctx.lineWidth = 1
  ctx.strokeRect(x, y, CELL, CELL)

  if (tile.type === "property") {
    ctx.fillStyle = groupColor(map, tile)
    ctx.fillRect(x + 1, y + 1, CELL - 2, 15)
    if (propertyState?.ownerColor) {
      ctx.fillStyle = propertyState.ownerColor
      ctx.fillRect(x + 4, y + CELL - 10, CELL - 8, 6)
    }
  } else {
    const icon = tileIcon(tile)
    ctx.font = font(21, "bold")
    ctx.fillStyle = "#455A64"
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(icon, x + CELL / 2, y + 27)
  }

  ctx.font = font(14, "bold")
  ctx.fillStyle = "#263238"
  ctx.textAlign = "center"
  ctx.textBaseline = "top"
  const nameY = tile.type === "property" ? y + 23 : y + 45
  const lines = splitText(ctx, tile.name, CELL - 12, 2)
  lines.forEach((line, index) =>
    ctx.fillText(line, x + CELL / 2, nameY + index * 17)
  )

  ctx.font = font(11)
  ctx.fillStyle = "#607D8B"
  ctx.textBaseline = "bottom"
  let detail = ""
  if (tile.type === "property") {
    detail =
      propertyState?.ownerId == null
        ? `¥${tile.price}`
        : `Lv.${propertyState.level}`
  } else if (tile.type === "tax") {
    detail = `-${tile.amount}`
  } else if (tile.type === "bonus") {
    detail = `+${tile.amount}`
  }
  if (detail) ctx.fillText(detail, x + CELL / 2, y + CELL - 13)

  if (isCurrentTile || isPending) {
    ctx.strokeStyle = isPending ? "#FF9800" : "#FFD54F"
    ctx.lineWidth = isPending ? 5 : 3
    ctx.strokeRect(x + 2, y + 2, CELL - 4, CELL - 4)
  }
}

function tokenOffsets(count) {
  const layouts = {
    1: [[0, 0]],
    2: [[-12, 0], [12, 0]],
    3: [[-14, -8], [14, -8], [0, 14]],
    4: [[-13, -13], [13, -13], [-13, 13], [13, 13]],
    5: [[-16, -14], [0, -14], [16, -14], [-9, 13], [9, 13]],
    6: [[-17, -14], [0, -14], [17, -14], [-17, 14], [0, 14], [17, 14]],
  }
  return layouts[Math.min(6, Math.max(1, count))]
}

function drawTokens(ctx, map, view) {
  const byTile = new Map()
  for (const player of view.players) {
    if (!byTile.has(player.position)) byTile.set(player.position, [])
    byTile.get(player.position).push(player)
  }

  for (const [tileId, players] of byTile.entries()) {
    const tile = map.tiles.find((item) => item.id === Number(tileId))
    if (!tile) continue
    const centerX = BOARD_X + tile.position.x * CELL + CELL / 2
    const centerY = BOARD_Y + tile.position.y * CELL + 72
    const offsets = tokenOffsets(players.length)
    players.forEach((player, index) => {
      const [dx, dy] = offsets[index]
      const radius = players.length > 4 ? 10 : 12
      ctx.beginPath()
      ctx.arc(centerX + dx, centerY + dy, radius, 0, Math.PI * 2)
      ctx.fillStyle = player.active ? player.color : "#B0BEC5"
      ctx.fill()
      ctx.strokeStyle = "#FFFFFF"
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.font = font(players.length > 4 ? 9 : 10, "bold")
      ctx.fillStyle = "#FFFFFF"
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText(
        Array.from(player.displayName)[0] || "?",
        centerX + dx,
        centerY + dy + 0.5
      )
    })
  }
}

function drawCenter(ctx, view) {
  const x = BOARD_X + CELL + 18
  const y = BOARD_Y + CELL + 18
  const width = CELL * 5 - 36
  const height = CELL * 5 - 36
  fillRounded(ctx, x, y, width, height, 22, "#FFFDF8")
  strokeRounded(ctx, x, y, width, height, 22, "#E0D7C8", 2)

  ctx.textAlign = "center"
  ctx.textBaseline = "top"
  ctx.fillStyle = "#4E342E"
  ctx.font = font(32, "bold")
  ctx.fillText(view.mapName, x + width / 2, y + 32)
  ctx.font = font(15)
  ctx.fillStyle = "#8D6E63"
  ctx.fillText("QQ群短局大富翁", x + width / 2, y + 76)

  const current = view.players.find(
    (player) => player.userId === view.currentPlayerId
  )
  fillRounded(ctx, x + 42, y + 118, width - 84, 112, 16, "#F5F0E8")
  ctx.fillStyle = "#5D4037"
  ctx.font = font(18, "bold")
  ctx.fillText(
    view.phase === PHASES.ENDED
      ? "游戏结束"
      : `第 ${view.round}/${view.roundLimit} 轮`,
    x + width / 2,
    y + 138
  )
  ctx.font = font(24, "bold")
  ctx.fillStyle = current?.color || "#607D8B"
  ctx.fillText(
    current ? `当前：${current.displayName}` : view.phaseLabel,
    x + width / 2,
    y + 172
  )

  ctx.fillStyle = "#6D4C41"
  ctx.font = font(17)
  const diceText = view.lastDice
    ? `上一骰：${view.lastDice.value} 点`
    : "等待第一枚骰子"
  ctx.fillText(diceText, x + width / 2, y + 258)

  const pendingText =
    view.pendingDecision?.type === "purchase"
      ? "等待选择：购买 / 放弃"
      : view.pendingDecision?.type === "upgrade"
        ? "等待选择：升级 / 放弃"
        : view.phase === PHASES.AWAITING_ROLL
          ? "发送 #掷骰"
          : view.phaseLabel
  fillRounded(ctx, x + 62, y + 305, width - 124, 52, 14, "#FFF3E0")
  ctx.font = font(18, "bold")
  ctx.fillStyle = "#E65100"
  ctx.fillText(pendingText, x + width / 2, y + 320)

  ctx.font = font(13)
  ctx.fillStyle = "#8D6E63"
  ctx.fillText(
    "游戏现金与 Sakura 主经济相互独立",
    x + width / 2,
    y + height - 45
  )
}

function statusText(player) {
  if (player.status === PLAYER_STATUS.BANKRUPT) return "已破产"
  if (player.status === PLAYER_STATUS.SURRENDERED) return "已认输"
  if (player.jailTurns > 0) return "看守所"
  return player.tileName
}

function drawPlayersPanel(ctx, view) {
  fillRounded(ctx, PANEL_X, BOARD_Y, PANEL_WIDTH, 720, 20, "#263238")
  ctx.textAlign = "left"
  ctx.textBaseline = "top"
  ctx.fillStyle = "#FFFFFF"
  ctx.font = font(25, "bold")
  ctx.fillText("玩家资产", PANEL_X + 22, BOARD_Y + 20)
  ctx.font = font(13)
  ctx.fillStyle = "#B0BEC5"
  ctx.fillText(
    `${view.players.length} 人｜${view.phaseLabel}`,
    PANEL_X + 22,
    BOARD_Y + 56
  )

  const cardHeight = Math.min(100, Math.floor(625 / Math.max(1, view.players.length)))
  view.players.forEach((player, index) => {
    const y = BOARD_Y + 82 + index * cardHeight
    const current = player.userId === view.currentPlayerId
    fillRounded(
      ctx,
      PANEL_X + 14,
      y,
      PANEL_WIDTH - 28,
      cardHeight - 8,
      13,
      current ? "#37474F" : "#303E44"
    )
    if (current) {
      strokeRounded(
        ctx,
        PANEL_X + 14,
        y,
        PANEL_WIDTH - 28,
        cardHeight - 8,
        13,
        "#FFD54F",
        2
      )
    }

    ctx.beginPath()
    ctx.arc(PANEL_X + 38, y + 27, 12, 0, Math.PI * 2)
    ctx.fillStyle = player.active ? player.color : "#78909C"
    ctx.fill()

    const nameSize = fitText(
      ctx,
      player.displayName,
      PANEL_WIDTH - 100,
      18,
      13
    )
    ctx.font = font(nameSize, "bold")
    ctx.fillStyle = "#FFFFFF"
    ctx.fillText(player.displayName, PANEL_X + 58, y + 14)

    ctx.font = font(13)
    ctx.fillStyle = "#CFD8DC"
    ctx.fillText(
      `现金 ${player.cash.toLocaleString("zh-CN")}  ·  地产 ${player.propertyCount}`,
      PANEL_X + 26,
      y + 45
    )
    ctx.fillStyle = "#90A4AE"
    ctx.fillText(
      `净资产 ${player.netWorth.toLocaleString("zh-CN")}  ·  ${statusText(player)}`,
      PANEL_X + 26,
      y + 65
    )
  })
}

export function renderBoard(state, map) {
  ensureFont()
  const view = buildPublicView(state, map)
  const canvas = createCanvas(WIDTH, HEIGHT)
  const ctx = canvas.getContext("2d")

  const gradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT)
  gradient.addColorStop(0, "#F7F2E8")
  gradient.addColorStop(1, "#E8DED0")
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, WIDTH, HEIGHT)

  for (const tile of map.tiles) drawTile(ctx, map, view, tile)
  drawCenter(ctx, view)
  drawTokens(ctx, map, view)
  drawPlayersPanel(ctx, view)

  return canvas.toBuffer("image/png")
}
