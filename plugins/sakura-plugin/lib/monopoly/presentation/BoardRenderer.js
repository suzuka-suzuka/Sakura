import {
  createCanvas,
  GlobalFonts,
  loadImage,
} from "@napi-rs/canvas"
import path from "node:path"
import { pluginresources } from "../../path.js"
import {
  PHASES,
} from "../constants.js"
import { buildPublicView } from "./PublicView.js"

const CELL = 104
const BOARD_X = 30
const BOARD_Y = 30
const PAGE_MARGIN = 30
const PANEL_GAP = 24
const CENTER_GUTTER = 86
const FONT_FAMILY = "MonopolyRounded"

let fontReady = false
let diceAssetsPromise = null

function loadDiceAssets() {
  if (!diceAssetsPromise) {
    diceAssetsPromise = Promise.all(
      Array.from({ length: 6 }, async (_, index) => {
        const value = index + 1
        const image = await loadImage(
          path.join(pluginresources, "flychess", "img", `${value}.jpg`)
        )
        return [value, image]
      })
    )
      .then((entries) => Object.fromEntries(entries))
      .catch(() => ({}))
  }
  return diceAssetsPromise
}

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

function fitText(ctx, text, maxWidth, startSize, minSize = 9) {
  let size = startSize
  while (size > minSize) {
    ctx.font = font(size, "bold")
    if (ctx.measureText(text).width <= maxWidth) break
    size -= 1
  }
  return size
}

function groupColor(map, tile) {
  if (!hasColorGroupStripe(tile)) return null
  return (
    map.propertyGroups.find((group) => group.id === tile.groupId)?.color ||
    "#90A4AE"
  )
}

function hasColorGroupStripe(tile) {
  return (
    tile.type === "property" &&
    (tile.propertyKind || "street") === "street"
  )
}

function mixWithWhite(hex, whiteRatio = 0.84) {
  const normalized = String(hex || "#90A4AE").replace("#", "")
  const value = Number.parseInt(normalized, 16)
  if (!Number.isFinite(value)) return "#F3F5F6"
  const channels = [
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  ].map((channel) =>
    Math.round(channel * (1 - whiteRatio) + 255 * whiteRatio)
  )
  return `#${channels
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`
}

function tileSide(map, tile) {
  const { columns, rows } = map.board.layout
  if (tile.position.y === rows - 1) return "bottom"
  if (tile.position.x === 0) return "left"
  if (tile.position.y === 0) return "top"
  return "right"
}

function tileRect(tile) {
  return {
    x: BOARD_X + tile.position.x * CELL,
    y: BOARD_Y + tile.position.y * CELL,
    width: CELL,
    height: CELL,
  }
}

function innerStripeRect(map, tile, rect) {
  const thickness = 14
  const inset = 1
  const side = tileSide(map, tile)
  if (side === "bottom") {
    return {
      x: rect.x + inset,
      y: rect.y + inset,
      width: CELL - inset * 2,
      height: thickness,
    }
  }
  if (side === "top") {
    return {
      x: rect.x + inset,
      y: rect.y + CELL - thickness - inset,
      width: CELL - inset * 2,
      height: thickness,
    }
  }
  if (side === "left") {
    return {
      x: rect.x + CELL - thickness - inset,
      y: rect.y + inset,
      width: thickness,
      height: CELL - inset * 2,
    }
  }
  return {
    x: rect.x + inset,
    y: rect.y + inset,
    width: thickness,
    height: CELL - inset * 2,
  }
}

function outerOwnerStripeRect(map, tile, rect) {
  const thickness = 7
  const inset = 1
  const side = tileSide(map, tile)
  if (side === "bottom") {
    return {
      x: rect.x + inset,
      y: rect.y + CELL - thickness - inset,
      width: CELL - inset * 2,
      height: thickness,
    }
  }
  if (side === "top") {
    return {
      x: rect.x + inset,
      y: rect.y + inset,
      width: CELL - inset * 2,
      height: thickness,
    }
  }
  if (side === "left") {
    return {
      x: rect.x + inset,
      y: rect.y + inset,
      width: thickness,
      height: CELL - inset * 2,
    }
  }
  return {
    x: rect.x + CELL - thickness - inset,
    y: rect.y + inset,
    width: thickness,
    height: CELL - inset * 2,
  }
}

function tileContentRect(map, tile, rect) {
  if (tile.type !== "property") {
    return {
      x: rect.x + 8,
      y: rect.y + 8,
      width: CELL - 16,
      height: CELL - 16,
    }
  }
  const side = tileSide(map, tile)
  const stripeSpace = hasColorGroupStripe(tile) ? 17 : 6
  const ownerSpace = 8
  const padding = 6
  if (side === "bottom") {
    return {
      x: rect.x + padding,
      y: rect.y + stripeSpace,
      width: CELL - padding * 2,
      height: CELL - stripeSpace - ownerSpace,
    }
  }
  if (side === "top") {
    return {
      x: rect.x + padding,
      y: rect.y + ownerSpace,
      width: CELL - padding * 2,
      height: CELL - stripeSpace - ownerSpace,
    }
  }
  if (side === "left") {
    return {
      x: rect.x + ownerSpace,
      y: rect.y + padding,
      width: CELL - stripeSpace - ownerSpace,
      height: CELL - padding * 2,
    }
  }
  return {
    x: rect.x + stripeSpace,
    y: rect.y + padding,
    width: CELL - stripeSpace - ownerSpace,
    height: CELL - padding * 2,
  }
}

function drawBuildingMarker(ctx, map, tile, stripe, propertyState) {
  if (
    propertyState?.propertyKind !== "street" ||
    propertyState.level <= 0
  ) {
    return
  }

  const side = tileSide(map, tile)
  const horizontal = side === "top" || side === "bottom"
  const isHotel = propertyState.hotels === 1
  const count = isHotel ? 1 : propertyState.houses
  const itemLength = isHotel ? 24 : 9
  const gap = 3
  const totalLength = count * itemLength + Math.max(0, count - 1) * gap
  const start = horizontal
    ? stripe.x + (stripe.width - totalLength) / 2
    : stripe.y + (stripe.height - totalLength) / 2

  for (let index = 0; index < count; index++) {
    const offset = start + index * (itemLength + gap)
    const x = horizontal
      ? offset
      : stripe.x + (stripe.width - (isHotel ? 9 : 8)) / 2
    const y = horizontal
      ? stripe.y + (stripe.height - (isHotel ? 9 : 8)) / 2
      : offset
    const width = horizontal ? itemLength : isHotel ? 9 : 8
    const height = horizontal ? (isHotel ? 9 : 8) : itemLength

    fillRounded(
      ctx,
      x,
      y,
      width,
      height,
      2,
      isHotel ? "#E64A19" : "#159A6B"
    )
    ctx.strokeStyle = "#FFFFFF"
    ctx.lineWidth = 1
    ctx.stroke()
  }
}

function propertyNumber(tile, propertyState) {
  if (propertyState?.mortgaged) return "抵押"
  return String(
    propertyState?.ownerId == null
      ? tile.price
      : propertyState.rent ?? tile.price
  )
}

function centeredTileLayout(
  ctx,
  content,
  name,
  number = null,
  tokenCount = 0
) {
  const characterCount = Array.from(String(name)).length
  const preferredSize = characterCount <= 2 ? 27 : 22
  let nameSize = fitText(
    ctx,
    name,
    content.width - 2,
    preferredSize,
    15
  )
  const hasNumber = number !== null && number !== undefined
  const textGap = 2
  const tokenRows = tokenCount > 3 ? 2 : tokenCount > 0 ? 1 : 0
  const tokenHeight = tokenRows === 0 ? 0 : tokenRows * 11 + (tokenRows - 1) * 3
  const tokenGap = tokenRows > 0 ? 4 : 0
  const fixedHeight =
    (hasNumber ? textGap : 0) + tokenGap + tokenHeight
  const textLines = hasNumber ? 2 : 1
  nameSize = Math.min(
    nameSize,
    Math.floor((content.height - fixedHeight) / textLines)
  )
  const numberSize = nameSize
  const totalHeight =
    nameSize +
    (hasNumber ? textGap + numberSize : 0) +
    tokenGap +
    tokenHeight
  const top = content.y + (content.height - totalHeight) / 2
  const centerX = content.x + content.width / 2
  const tokenTop =
    top +
    nameSize +
    (hasNumber ? textGap + numberSize : 0) +
    tokenGap
  return {
    centerX,
    top,
    nameSize,
    numberSize,
    hasNumber,
    textGap,
    tokenCenterY: tokenTop + tokenHeight / 2,
  }
}

function drawCenteredTileText(
  ctx,
  content,
  name,
  number = null,
  {
    nameColor = "#263238",
    numberColor = "#37474F",
    tokenCount = 0,
  } = {}
) {
  const layout = centeredTileLayout(
    ctx,
    content,
    name,
    number,
    tokenCount
  )
  ctx.textAlign = "center"
  ctx.textBaseline = "top"
  ctx.font = font(layout.nameSize, "bold")
  ctx.fillStyle = nameColor
  ctx.fillText(name, layout.centerX, layout.top)

  if (layout.hasNumber) {
    ctx.font = font(layout.numberSize, "bold")
    ctx.fillStyle = numberColor
    ctx.fillText(
      String(number),
      layout.centerX,
      layout.top + layout.nameSize + layout.textGap
    )
  }
  return layout
}

function drawPropertyTile(
  ctx,
  map,
  tile,
  rect,
  content,
  propertyState,
  tokenCount
) {
  if (hasColorGroupStripe(tile)) {
    const stripe = innerStripeRect(map, tile, rect)
    ctx.fillStyle = groupColor(map, tile)
    ctx.fillRect(stripe.x, stripe.y, stripe.width, stripe.height)
    drawBuildingMarker(ctx, map, tile, stripe, propertyState)
  }

  if (propertyState?.ownerColor) {
    const ownerStripe = outerOwnerStripeRect(map, tile, rect)
    ctx.fillStyle = propertyState.ownerColor
    ctx.fillRect(
      ownerStripe.x,
      ownerStripe.y,
      ownerStripe.width,
      ownerStripe.height
    )
  }

  drawCenteredTileText(
    ctx,
    content,
    tile.name,
    propertyNumber(tile, propertyState),
    { tokenCount }
  )
}

function drawSpecialTile(ctx, tile, content, tokenCount) {
  const amount =
    tile.type === "tax" || tile.type === "bonus"
      ? String(tile.amount)
      : null
  drawCenteredTileText(
    ctx,
    content,
    tile.name,
    amount,
    {
      nameColor:
        tile.type === "tax" || tile.type === "go_to_jail"
          ? "#B02A2A"
          : "#263238",
      numberColor: tile.type === "tax" ? "#B02A2A" : "#37474F",
      tokenCount,
    }
  )
}

function drawTile(ctx, map, view, tile) {
  const rect = tileRect(tile)
  const propertyState = view.propertyStates[String(tile.id)]
  const tokenCount = view.players.filter(
    (player) => player.position === tile.id
  ).length

  ctx.fillStyle = propertyState?.ownerColor
    ? mixWithWhite(propertyState.ownerColor)
    : "#FFFFFF"
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
  ctx.strokeStyle = "#B8C3C9"
  ctx.lineWidth = 1
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height)

  const content = tileContentRect(map, tile, rect)
  if (tile.type === "property") {
    drawPropertyTile(
      ctx,
      map,
      tile,
      rect,
      content,
      propertyState,
      tokenCount
    )
  } else {
    drawSpecialTile(ctx, tile, content, tokenCount)
  }
}

function tokenOffsets(count) {
  const layouts = {
    1: [[0, 0]],
    2: [[-8, 0], [8, 0]],
    3: [[-12, 0], [0, 0], [12, 0]],
    4: [[-8, -7], [8, -7], [-8, 7], [8, 7]],
    5: [[-12, -7], [0, -7], [12, -7], [-7, 7], [7, 7]],
    6: [[-12, -7], [0, -7], [12, -7], [-12, 7], [0, 7], [12, 7]],
  }
  return layouts[Math.min(6, Math.max(1, count))]
}

function tokenAnchor(ctx, map, view, tile, tokenCount) {
  const rect = tileRect(tile)
  const content = tileContentRect(map, tile, rect)
  const propertyState = view.propertyStates[String(tile.id)]
  const number =
    tile.type === "property"
      ? propertyNumber(tile, propertyState)
      : tile.type === "tax" || tile.type === "bonus"
        ? String(tile.amount)
        : null
  const layout = centeredTileLayout(
    ctx,
    content,
    tile.name,
    number,
    tokenCount
  )
  return {
    x: layout.centerX,
    y: layout.tokenCenterY,
  }
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
    const anchor = tokenAnchor(ctx, map, view, tile, players.length)
    const offsets = tokenOffsets(players.length)
    players.forEach((player, index) => {
      const [dx, dy] = offsets[index]
      const radius = players.length > 3 ? 5 : 6
      ctx.beginPath()
      ctx.arc(anchor.x + dx, anchor.y + dy, radius, 0, Math.PI * 2)
      ctx.fillStyle = player.active ? player.color : "#B0BEC5"
      ctx.fill()
      ctx.strokeStyle = "#FFFFFF"
      ctx.lineWidth = 1.5
      ctx.stroke()
    })
  }
}

// 这些事件只是回合流转或查询回执，不代表某个玩家刚刚行动过
const NON_ACTION_EVENTS = new Set([
  "turn_started",
  "jail_turn_skipped",
  // 开窗和弃权说的是「谁该接话」，不是「谁刚行动过」
  "counter_window_opened",
  "counter_declined",
  "status_requested",
  "rules_requested",
  "rule_error",
  "game_created",
  "player_joined",
  "player_left",
  "host_changed",
  "game_started",
  "game_ended",
  "lobby_expired",
  "ranking_tie_break",
  "resolution_limit_reached",
])

// 本帧在汇报谁的行动：购买回执仍属于刚买地的人，而不是已经接棒的下一位
function frameSubjectId(view, events) {
  const acted = [...(events || [])]
    .reverse()
    .find(
      (event) =>
        event?.playerId != null && !NON_ACTION_EVENTS.has(event.type)
    )
  return (
    acted?.playerId ??
    view.pendingDecision?.playerId ??
    view.pendingDebt?.payerId ??
    null
  )
}

// 骰子与足迹只在属于本帧主语时展示，掷骰前不留上一手的残影
function rollBelongsToFrame(view, subjectId) {
  const dice = view.lastDice
  if (!dice) return false
  if (subjectId != null) return String(dice.playerId) === String(subjectId)
  return (
    view.currentPlayerId != null &&
    String(dice.playerId) === String(view.currentPlayerId) &&
    dice.turnSeq === view.turnSeq
  )
}

function buildFrame(view, events) {
  const subjectId = frameSubjectId(view, events)
  return {
    subjectId,
    rollVisible: rollBelongsToFrame(view, subjectId),
  }
}

function playerOf(view, playerId) {
  if (playerId == null) return null
  return (
    view.players.find((player) => player.userId === String(playerId)) ||
    null
  )
}

function focusPlayer(view, frame) {
  if (!frame.rollVisible) {
    return (
      playerOf(view, view.currentPlayerId) ||
      playerOf(view, frame.subjectId)
    )
  }
  return (
    playerOf(view, view.lastMove?.playerId) ||
    playerOf(view, view.lastDice?.playerId) ||
    playerOf(view, frame.subjectId) ||
    playerOf(view, view.currentPlayerId)
  )
}

function viewPlayerLabel(view, playerId) {
  return (
    view.players.find((player) => player.userId === String(playerId))
      ?.label || "未知玩家"
  )
}

function itemLabel(map, itemId) {
  return map.items?.find((item) => item.id === itemId)?.name || itemId
}

function eventNoticeLines(events, view, map) {
  const lines = []
  const tileName = (tileId) =>
    map.tiles.find((tile) => tile.id === Number(tileId))?.name ||
    `格子${tileId}`
  const amount = (value) => Number(value || 0).toLocaleString("zh-CN")

  for (const event of events || []) {
    const player = viewPlayerLabel(view, event.playerId)
    if (event.type === "game_created") {
      lines.push("大富翁房间已创建")
    } else if (event.type === "player_joined") {
      lines.push(`${player}已加入 · 当前 ${event.playerCount} 人`)
    } else if (event.type === "player_left") {
      lines.push(`玩家${event.playerNumber}已退出 · 当前 ${event.playerCount} 人`)
    } else if (event.type === "host_changed") {
      lines.push(`房主已移交给${player}`)
    } else if (event.type === "game_started") {
      lines.push(`游戏开始 · 每人 ${amount(event.startingCash)}`)
    } else if (event.type === "start_reward") {
      lines.push(`经过起点 · 获得 ${amount(event.amount)}`)
    } else if (event.type === "property_purchased") {
      lines.push(`${player}买下${tileName(event.tileId)} · ${amount(event.amount)}`)
    } else if (event.type === "property_upgraded") {
      lines.push(`${tileName(event.tileId)}升级为${event.building}`)
    } else if (event.type === "building_sold") {
      lines.push(
        `${tileName(event.tileId)}降为${event.building} · 收回 ${amount(event.amount)}`
      )
    } else if (event.type === "property_mortgaged") {
      lines.push(`${tileName(event.tileId)}已抵押 · 获得 ${amount(event.amount)}`)
    } else if (event.type === "property_redeemed") {
      lines.push(`${tileName(event.tileId)}已赎回 · 支付 ${amount(event.amount)}`)
    } else if (event.type === "mortgaged_property_visited") {
      lines.push(`${tileName(event.tileId)}已抵押 · 本次不收租`)
    } else if (event.type === "payment") {
      const recipient = event.recipientId
        ? viewPlayerLabel(view, event.recipientId)
        : "银行"
      const reason = event.reason === "rent" ? "租金" : "费用"
      lines.push(
        `${viewPlayerLabel(view, event.payerId)}向${recipient}支付${reason} ${amount(event.paid)}`
      )
    } else if (event.type === "auto_liquidated") {
      const parts = []
      if (event.sold > 0) parts.push(`拆房 ${event.sold}`)
      if (event.mortgaged > 0) parts.push(`抵押 ${event.mortgaged}`)
      lines.push(
        `${player}自动变现 · ${parts.join(" · ")} · 共 ${amount(event.amount)}`
      )
    } else if (event.type === "properties_transferred") {
      const interest = event.interest > 0 ? ` · 利息 ${amount(event.interest)}` : ""
      lines.push(
        `${player}的 ${event.count} 处地产转给${viewPlayerLabel(view, event.recipientId)}${interest}`
      )
    } else if (event.type === "debt_required") {
      lines.push(
        `${viewPlayerLabel(view, event.payerId)}尚缺 ${amount(event.shortfall)}，等待筹款`
      )
    } else if (event.type === "debt_resolved") {
      lines.push(
        event.bankrupt
          ? `${player}无法清偿 · 已破产`
          : `${player}已完成欠款结算`
      )
    } else if (event.type === "chance_drawn") {
      const card = map.chanceDecks
        .flatMap((deck) => deck.cards)
        .find((item) => item.id === event.cardId)
      lines.push(`机会 · ${card?.name || event.cardId}`)
    } else if (event.type === "item_granted") {
      lines.push(`${player}获得道具 · ${itemLabel(map, event.itemId)}`)
    } else if (event.type === "item_capped") {
      lines.push(`${player}的${itemLabel(map, event.itemId)}已达上限 · 本次作废`)
    } else if (event.type === "item_used" && event.reason === "jail") {
      // 主动使用和打否决另有专门的行，这里只播报自动消耗的保释令
      lines.push(`${player}使用${itemLabel(map, event.itemId)} · 免去看守所`)
    } else if (event.type === "item_targeted") {
      const detail = event.detail ? ` · ${event.detail}` : ""
      lines.push(
        `${player}对${viewPlayerLabel(view, event.victimId)}使用${itemLabel(map, event.itemId)}${detail}`
      )
    } else if (event.type === "item_negated") {
      lines.push(
        `${player}打出否决令 · ${itemLabel(map, event.itemId)}失效`
      )
    } else if (event.type === "counter_chain_resolved") {
      lines.push(
        `否决链 ${event.depth} 层 · ${itemLabel(map, event.itemId)}最终生效`
      )
    } else if (event.type === "property_seized") {
      lines.push(
        `${player}征收${viewPlayerLabel(view, event.recipientId)}的${tileName(event.tileId)} · 支付 ${amount(event.amount)}`
      )
    } else if (event.type === "property_swapped") {
      lines.push(
        `${player}用${tileName(event.givenTileId)}换走${viewPlayerLabel(view, event.recipientId)}的${tileName(event.takenTileId)}`
      )
    } else if (event.type === "building_demolished") {
      lines.push(
        `${viewPlayerLabel(view, event.recipientId)}的${tileName(event.tileId)}被拆 · 补偿 ${amount(event.amount)}`
      )
    } else if (event.type === "item_fizzled") {
      lines.push(`${itemLabel(map, event.itemId)}目标已失效 · 本次落空`)
    } else if (event.type === "repairs_assessed" && event.amount > 0) {
      lines.push(
        `${player}维修 ${event.houses} 房 ${event.hotels} 旅馆 · 共 ${amount(event.amount)}`
      )
    } else if (event.type === "cash_granted") {
      lines.push(`${player}获得 ${amount(event.amount)}`)
    } else if (
      event.type === "sent_to_jail" &&
      event.reason !== "consecutive_doubles"
    ) {
      lines.push(`${player}前往监狱 · 下回合停一次`)
    } else if (event.type === "extra_roll_awarded") {
      lines.push(`${player}掷出对子 · 可以再次掷骰`)
    } else if (event.type === "triple_doubles_jail") {
      lines.push(`${player}连续三次对子 · 直接入狱`)
    } else if (event.type === "decision_declined") {
      lines.push(`已放弃购买${tileName(event.tileId)}`)
    } else if (event.type === "roll_timed_out") {
      lines.push(`${player}掷骰超时 · ${event.count}/${event.limit}`)
    } else if (event.type === "jail_turn_skipped") {
      lines.push(`${player}本回合在监狱中度过`)
    } else if (event.type === "tile_no_effect") {
      lines.push(
        event.tileType === "jail"
          ? `${player}正在探访监狱`
          : `${player}在${tileName(event.tileId)}休息`
      )
    } else if (event.type === "resolution_limit_reached") {
      lines.push("事件连锁已到安全上限，本次停止")
    } else if (event.type === "ranking_tie_break") {
      lines.push("净资产相同 · 已自动掷骰决定名次")
    } else if (event.type === "player_surrendered") {
      lines.push(`${player}已认输`)
    } else if (event.type === "game_ended") {
      if (event.forced) {
        lines.push("本局已强制结束 · 不计算胜者")
      } else {
        const winnerId = event.winnerIds?.[0]
        lines.push(
          winnerId
            ? `本局结束 · ${viewPlayerLabel(view, winnerId)}获胜`
            : "本局游戏结束"
        )
        for (const entry of (event.rankings || view.rankings).slice(0, 3)) {
          lines.push(
            `第${entry.rank}名 ${viewPlayerLabel(view, entry.userId)} · 净资产 ${amount(entry.netWorth)}`
          )
        }
      }
    } else if (event.type === "lobby_expired") {
      lines.push("等待超时 · 房间已自动解散")
    } else if (event.type === "rules_requested") {
      lines.push("双骰相加 · 对子再掷 · 连续三次对子入狱")
      lines.push("同色组均衡建造 · 4 房升旅馆 · 卖房半价")
      lines.push("抵押不收租 · 赎回为抵押本金加一成")
    } else if (event.type === "rule_error") {
      lines.push(`操作未生效 · ${event.message}`)
    }
  }
  return lines.slice(-4)
}

function innerFocusAnchor(map, tile, distance = 42) {
  const rect = tileRect(tile)
  const side = tileSide(map, tile)
  if (side === "bottom") {
    return { x: rect.x + CELL / 2, y: rect.y - distance }
  }
  if (side === "top") {
    return { x: rect.x + CELL / 2, y: rect.y + CELL + distance }
  }
  if (side === "left") {
    return { x: rect.x + CELL + distance, y: rect.y + CELL / 2 }
  }
  return { x: rect.x - distance, y: rect.y + CELL / 2 }
}

function deeperFocusAnchor(map, tile, anchor, distance = 32) {
  const side = tileSide(map, tile)
  if (side === "bottom") return { x: anchor.x, y: anchor.y - distance }
  if (side === "top") return { x: anchor.x, y: anchor.y + distance }
  if (side === "left") return { x: anchor.x + distance, y: anchor.y }
  return { x: anchor.x - distance, y: anchor.y }
}

function drawDashedArrow(ctx, start, control1, control2, end) {
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(start.x, start.y)
  ctx.bezierCurveTo(
    control1.x,
    control1.y,
    control2.x,
    control2.y,
    end.x,
    end.y
  )
  ctx.strokeStyle = "#6F7477"
  ctx.lineWidth = 2
  ctx.setLineDash([6, 6])
  ctx.stroke()
  ctx.setLineDash([])

  const angle = Math.atan2(
    end.y - control2.y,
    end.x - control2.x
  )
  const arrowSize = 8
  ctx.beginPath()
  ctx.moveTo(end.x, end.y)
  ctx.lineTo(
    end.x - arrowSize * Math.cos(angle - Math.PI / 6),
    end.y - arrowSize * Math.sin(angle - Math.PI / 6)
  )
  ctx.moveTo(end.x, end.y)
  ctx.lineTo(
    end.x - arrowSize * Math.cos(angle + Math.PI / 6),
    end.y - arrowSize * Math.sin(angle + Math.PI / 6)
  )
  ctx.stroke()
  ctx.restore()
}

function drawTurnFocus(ctx, map, view, frame) {
  const player = focusPlayer(view, frame)
  if (!player) return
  const move = frame.rollVisible ? view.lastMove : null
  const fromTile = move
    ? map.tiles.find((item) => item.id === move.fromTileId)
    : null
  const toTile = map.tiles.find(
    (item) => item.id === (move?.toTileId ?? player.position)
  )
  if (!toTile) return

  if (fromTile && fromTile.id !== toTile.id) {
    const fromRect = tileRect(fromTile)
    ctx.save()
    ctx.fillStyle = "rgba(255, 255, 255, 0.52)"
    ctx.fillRect(
      fromRect.x + 2,
      fromRect.y + 2,
      fromRect.width - 4,
      fromRect.height - 4
    )
    ctx.strokeStyle = "#AAB0B3"
    ctx.lineWidth = 2
    ctx.setLineDash([4, 4])
    ctx.strokeRect(
      fromRect.x + 3,
      fromRect.y + 3,
      fromRect.width - 6,
      fromRect.height - 6
    )
    ctx.restore()

    const start = innerFocusAnchor(map, fromTile)
    const end = innerFocusAnchor(map, toTile)
    const control1 = deeperFocusAnchor(map, fromTile, start)
    const control2 = deeperFocusAnchor(map, toTile, end)
    drawDashedArrow(ctx, start, control1, control2, end)

    ctx.beginPath()
    ctx.arc(start.x, start.y, 5, 0, Math.PI * 2)
    ctx.fillStyle = "#8A9093"
    ctx.fill()
    ctx.strokeStyle = "#FFFFFF"
    ctx.lineWidth = 1.5
    ctx.stroke()
  }

  const rect = tileRect(toTile)

  ctx.strokeStyle = "#1F2325"
  ctx.lineWidth = 4
  ctx.strokeRect(
    rect.x + 2.5,
    rect.y + 2.5,
    rect.width - 5,
    rect.height - 5
  )
}

function drawCenterCard(
  ctx,
  x,
  y,
  width,
  height,
  fill = "#F5F0E8",
  stroke = "#E1D8CA"
) {
  fillRounded(ctx, x, y, width, height, 16, fill)
  strokeRounded(ctx, x, y, width, height, 16, stroke, 1.5)
}

function drawDiceFace(ctx, image, value, x, y, size) {
  fillRounded(ctx, x, y, size, size, 12, "#FFFFFF")
  if (image) {
    ctx.save()
    roundedRect(ctx, x, y, size, size, 12)
    ctx.clip()
    ctx.drawImage(image, x, y, size, size)
    ctx.restore()
    return
  }
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillStyle = value ? "#455A64" : "#B0BEC5"
  ctx.font = font(value ? 34 : 44, "bold")
  ctx.fillText(value || "?", x + size / 2, y + size / 2)
}

function centerButtons(view) {
  if (view.phase === PHASES.AWAITING_PURCHASE) {
    return [
      { label: "购买 · y", fill: "#E8F5E9", color: "#18794E" },
      { label: "放弃 · n", fill: "#F5F5F5", color: "#546E7A" },
    ]
  }
  if (view.phase === PHASES.AWAITING_DEBT) {
    return [
      { label: "卖房 / 抵押", fill: "#FFF3E0", color: "#D05A00" },
      { label: "强制结算", fill: "#FFEBEE", color: "#C62828" },
    ]
  }
  if (view.phase === PHASES.AWAITING_COUNTER) {
    return [
      { label: "否决", fill: "#EDE7F6", color: "#5E35B1" },
      { label: "不管", fill: "#F5F5F5", color: "#546E7A" },
    ]
  }
  if (view.phase === PHASES.LOBBY) {
    return [
      { label: "加入大富翁", fill: "#E3F2FD", color: "#1565C0" },
      { label: "开始大富翁", fill: "#E8F5E9", color: "#18794E" },
    ]
  }
  if (view.phase === PHASES.AWAITING_ROLL) {
    return [
      { label: "掷骰 · r", fill: "#E3F2FD", color: "#1565C0" },
    ]
  }
  return []
}

function drawCenterButtons(ctx, buttons, x, y, width, height) {
  if (buttons.length === 0) return
  const gap = 14
  const buttonWidth =
    (width - gap * (buttons.length - 1)) / buttons.length
  buttons.forEach((button, index) => {
    const buttonX = x + index * (buttonWidth + gap)
    drawCenterCard(
      ctx,
      buttonX,
      y,
      buttonWidth,
      height,
      button.fill,
      button.color
    )
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillStyle = button.color
    ctx.font = font(20, "bold")
    ctx.fillText(
      button.label,
      buttonX + buttonWidth / 2,
      y + height / 2
    )
  })
}

function centerAssetPlayer(view, frame) {
  if (view.pendingDebt) {
    return view.players.find(
      (player) => player.userId === view.pendingDebt.payerId
    )
  }
  const subject = playerOf(view, frame.subjectId)
  if (subject) return subject
  const current = view.players.find(
    (player) => player.userId === view.currentPlayerId
  )
  if (current) return current
  if (view.phase === PHASES.ENDED) {
    return [...view.players].sort(
      (left, right) =>
        (left.rank || Number.MAX_SAFE_INTEGER) -
        (right.rank || Number.MAX_SAFE_INTEGER)
    )[0]
  }
  return view.players.find(
    (player) => player.userId === view.hostUserId
  ) || view.players[0]
}

function drawCenter(ctx, map, view, events = [], diceImages = {}, frame) {
  const { columns, rows } = map.board.layout
  const x = BOARD_X + CELL + CENTER_GUTTER
  const y = BOARD_Y + CELL + CENTER_GUTTER
  const width = (columns - 2) * CELL - CENTER_GUTTER * 2
  const height = (rows - 2) * CELL - CENTER_GUTTER * 2
  fillRounded(ctx, x, y, width, height, 28, "#FFFDF9")
  strokeRounded(ctx, x, y, width, height, 28, "#E1D8CA", 2)

  const contentX = x + 32
  const contentWidth = width - 64
  const gap = 14
  const assetPlayer = centerAssetPlayer(view, frame)
  const role = view.pendingDebt
    ? "欠款玩家"
    : view.phase === PHASES.LOBBY
      ? assetPlayer?.userId === view.hostUserId
        ? "房主"
        : "已加入玩家"
      : view.phase === PHASES.ENDED
        ? "第一名"
        : assetPlayer?.userId === view.currentPlayerId
          ? "当前玩家"
          : "本次行动"
  const headerY = y + 24
  const headerHeight = 64
  drawCenterCard(ctx, contentX, headerY, contentWidth, headerHeight, "#F1F6F8")
  ctx.save()
  roundedRect(ctx, contentX, headerY, contentWidth, headerHeight, 16)
  ctx.clip()
  ctx.fillStyle = assetPlayer?.color || "#90A4AE"
  ctx.fillRect(contentX, headerY, 9, headerHeight)
  ctx.restore()
  ctx.textAlign = "left"
  ctx.textBaseline = "top"
  ctx.fillStyle = "#78909C"
  ctx.font = font(13, "bold")
  ctx.fillText(
    assetPlayer ? role : "等待玩家加入",
    contentX + 24,
    headerY + 11
  )
  ctx.fillStyle = assetPlayer?.color || "#455A64"
  ctx.font = font(25, "bold")
  ctx.fillText(
    assetPlayer?.label || "暂无玩家",
    contentX + 24,
    headerY + 30
  )
  ctx.textAlign = "right"
  ctx.textBaseline = "middle"
  ctx.fillStyle = "#607D8B"
  ctx.font = font(15, "bold")
  ctx.fillText(
    view.phaseLabel,
    contentX + contentWidth - 22,
    headerY + headerHeight / 2
  )

  const topY = y + 104
  const topHeight = 118
  const totalWidth = 190
  const diceWidth = contentWidth - totalWidth - gap
  const totalX = contentX + diceWidth + gap
  drawCenterCard(ctx, contentX, topY, diceWidth, topHeight, "#F4F7F8")
  drawCenterCard(ctx, totalX, topY, totalWidth, topHeight, "#EEF4F7")

  const diceValues = frame.rollVisible ? view.lastDice.values : []
  const diceSize = 84
  const diceGap = 24
  const diceStartX =
    contentX + (diceWidth - diceSize * 2 - diceGap) / 2
  drawDiceFace(
    ctx,
    diceImages[diceValues[0]],
    diceValues[0],
    diceStartX,
    topY + 17,
    diceSize
  )
  drawDiceFace(
    ctx,
    diceImages[diceValues[1]],
    diceValues[1],
    diceStartX + diceSize + diceGap,
    topY + 17,
    diceSize
  )

  ctx.textAlign = "center"
  ctx.textBaseline = "top"
  ctx.fillStyle = "#607D8B"
  ctx.font = font(15, "bold")
  ctx.fillText("总点数", totalX + totalWidth / 2, topY + 15)
  ctx.fillStyle = frame.rollVisible ? "#263238" : "#B0BEC5"
  ctx.font = font(48, "bold")
  ctx.fillText(
    frame.rollVisible ? String(view.lastDice.total) : "?",
    totalX + totalWidth / 2,
    topY + 39
  )
  if (frame.rollVisible && view.lastDice.isDouble) {
    ctx.fillStyle = "#D84315"
    ctx.font = font(14, "bold")
    ctx.fillText("对子", totalX + totalWidth / 2, topY + 96)
  }

  const moveY = y + 236
  drawCenterCard(ctx, contentX, moveY, contentWidth, 56, "#F7F4EF")
  const shownMove = frame.rollVisible ? view.lastMove : null
  const fromName = shownMove
    ? map.tiles.find((tile) => tile.id === shownMove.fromTileId)?.name
    : null
  const toName = shownMove
    ? map.tiles.find((tile) => tile.id === shownMove.toTileId)?.name
    : null
  const moveText =
    fromName && toName ? `${fromName}  →  ${toName}` : "等待掷骰"
  const moveSize = fitText(ctx, moveText, contentWidth - 38, 24, 15)
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillStyle = "#455A64"
  ctx.font = font(moveSize, "bold")
  ctx.fillText(moveText, contentX + contentWidth / 2, moveY + 28)

  const detailY = y + 306
  const detailHeight = 72
  drawCenterCard(ctx, contentX, detailY, contentWidth, detailHeight, "#FFF7E8")
  const pendingTile = view.pendingDecision
    ? map.tiles.find((tile) => tile.id === view.pendingDecision.tileId)
    : null
  const notices = eventNoticeLines(events, view, map)
  ctx.textAlign = "center"
  ctx.textBaseline = "top"
  if (pendingTile && view.phase === PHASES.AWAITING_PURCHASE) {
    ctx.fillStyle = "#5D4037"
    ctx.font = font(23, "bold")
    ctx.fillText(pendingTile.name, contentX + contentWidth / 2, detailY + 10)
    ctx.fillStyle = "#D05A00"
    ctx.font = font(19, "bold")
    ctx.fillText(
      `售价 ${pendingTile.price.toLocaleString("zh-CN")}`,
      contentX + contentWidth / 2,
      detailY + 40
    )
  } else if (view.pendingDebt) {
    const debtor = centerAssetPlayer(view, frame)
    const shortfall = Math.max(
      0,
      view.pendingDebt.amount - (debtor?.cash || 0)
    )
    ctx.fillStyle = "#C62828"
    ctx.font = font(21, "bold")
    ctx.fillText(
      `${debtor?.label || "玩家"}欠款 ${view.pendingDebt.amount.toLocaleString("zh-CN")}`,
      contentX + contentWidth / 2,
      detailY + 10
    )
    ctx.fillStyle = "#6D4C41"
    ctx.font = font(17, "bold")
    ctx.fillText(
      `当前现金 ${(debtor?.cash || 0).toLocaleString("zh-CN")} · 尚缺 ${shortfall.toLocaleString("zh-CN")}`,
      contentX + contentWidth / 2,
      detailY + 41
    )
  } else {
    const fallback =
      view.phase === PHASES.LOBBY
        ? `等待加入 · ${view.players.length}/${map.gameDefaults.maxPlayers} 人`
        : view.phase === PHASES.ENDED
          ? "本局游戏结束"
          : `等待${playerOf(view, view.currentPlayerId)?.label || "当前玩家"}操作`
    const lines = notices.length ? notices : [fallback]
    const lineGap = lines.length >= 4 ? 17 : lines.length === 3 ? 21 : 26
    const startY =
      detailY + (detailHeight - lineGap * lines.length) / 2 - 1
    lines.slice(-4).forEach((line, index) => {
      const size = fitText(ctx, line, contentWidth - 34, 17, 11)
      ctx.fillStyle = "#5D4037"
      ctx.font = font(size, "bold")
      ctx.fillText(
        line,
        contentX + contentWidth / 2,
        startY + index * lineGap
      )
    })
  }

  drawCenterButtons(
    ctx,
    centerButtons(view),
    contentX,
    y + 392,
    contentWidth,
    52
  )

  const financeY = y + 460
  const financeGap = 14
  const financeWidth = (contentWidth - financeGap) / 2
  const financeCards = [
    {
      label: "当前现金",
      value: assetPlayer?.cash,
      fill: "#EAF4FB",
      color: "#1976A8",
    },
    {
      label: "当前净资产",
      value: assetPlayer?.netWorth,
      fill: "#FFF4DF",
      color: "#B76A00",
    },
  ]
  financeCards.forEach((item, index) => {
    const cardX = contentX + index * (financeWidth + financeGap)
    drawCenterCard(ctx, cardX, financeY, financeWidth, 68, item.fill)
    ctx.textAlign = "left"
    ctx.textBaseline = "top"
    ctx.fillStyle = item.color
    ctx.font = font(13, "bold")
    ctx.fillText(item.label, cardX + 18, financeY + 11)
    ctx.font = font(26, "bold")
    ctx.fillText(
      item.value == null ? "—" : item.value.toLocaleString("zh-CN"),
      cardX + 18,
      financeY + 31
    )
  })

  const countsY = y + 542
  const countGap = 10
  const countWidth = (contentWidth - countGap * 4) / 5
  const countCards = [
    { label: "地产", value: assetPlayer?.propertyCount, color: "#546E7A" },
    { label: "抵押", value: assetPlayer?.mortgagedCount, color: "#8D6E63" },
    { label: "房屋", value: assetPlayer?.houseCount, color: "#18875B" },
    { label: "旅馆", value: assetPlayer?.hotelCount, color: "#D04444" },
    { label: "道具", value: assetPlayer?.itemCount, color: "#6A4FB6" },
  ]
  countCards.forEach((item, index) => {
    const cardX = contentX + index * (countWidth + countGap)
    drawCenterCard(ctx, cardX, countsY, countWidth, 58, "#F6F8F8")
    ctx.textAlign = "center"
    ctx.textBaseline = "top"
    ctx.fillStyle = "#78909C"
    ctx.font = font(12, "bold")
    ctx.fillText(item.label, cardX + countWidth / 2, countsY + 8)
    ctx.fillStyle = item.color
    ctx.font = font(22, "bold")
    ctx.fillText(
      item.value == null ? "—" : String(item.value),
      cardX + countWidth / 2,
      countsY + 27
    )
  })

  const bankY = y + 614
  const bankGap = 16
  const bankWidth = (contentWidth - bankGap) / 2
  for (const [index, item] of [
    {
      label: "银行房屋",
      value: view.buildingSupply.houses,
      fill: "#E8F5E9",
      color: "#18794E",
    },
    {
      label: "银行旅馆",
      value: view.buildingSupply.hotels,
      fill: "#FFEBEE",
      color: "#C62828",
    },
  ].entries()) {
    const cardX = contentX + index * (bankWidth + bankGap)
    drawCenterCard(ctx, cardX, bankY, bankWidth, 76, item.fill)
    ctx.textAlign = "center"
    ctx.textBaseline = "top"
    ctx.fillStyle = item.color
    ctx.font = font(15, "bold")
    ctx.fillText(item.label, cardX + bankWidth / 2, bankY + 11)
    ctx.font = font(27, "bold")
    ctx.fillText(
      String(item.value),
      cardX + bankWidth / 2,
      bankY + 35
    )
  }
}

const PANEL_ROW_HEIGHT = 46
const PANEL_ROW_GAP = 8
const PANEL_HEAD = 74

function panelMetrics(map, playerCount) {
  const boardWidth = map.board.layout.columns * CELL
  const boardHeight = map.board.layout.rows * CELL
  const rows = Math.max(0, Number(playerCount) || 0)
  const panelHeight =
    rows === 0
      ? 96
      : PANEL_HEAD +
        rows * PANEL_ROW_HEIGHT +
        (rows - 1) * PANEL_ROW_GAP +
        16
  return {
    boardWidth,
    boardHeight,
    panelX: BOARD_X,
    panelY: BOARD_Y + boardHeight + PANEL_GAP,
    panelWidth: boardWidth,
    panelHeight,
    canvasWidth: BOARD_X + boardWidth + PAGE_MARGIN,
    canvasHeight:
      BOARD_Y + boardHeight + PANEL_GAP + panelHeight + PAGE_MARGIN,
  }
}

function rankedPlayers(view) {
  return view.players
    .map((player, index) => ({ player, index }))
    .sort((left, right) => {
      if (left.player.rank && right.player.rank) {
        return left.player.rank - right.player.rank
      }
      if (left.player.active !== right.player.active) {
        return Number(right.player.active) - Number(left.player.active)
      }
      return (
        right.player.netWorth - left.player.netWorth ||
        right.player.cash - left.player.cash ||
        right.player.propertyCount - left.player.propertyCount ||
        left.index - right.index
      )
    })
    .map(({ player }, index) => ({
      ...player,
      displayRank: player.rank || index + 1,
    }))
}

// 背包按地图里的道具顺序列出来，形如「地契置换×1  否决令×2」
function itemsText(map, player) {
  const summary = player.items || {}
  const parts = (map.items || [])
    .filter((item) => summary[item.id] > 0)
    .map((item) => `${item.name}×${summary[item.id]}`)
  return parts.length > 0 ? parts.join("  ") : "—"
}

function drawPlayersPanel(ctx, view, metrics, map) {
  const {
    panelX,
    panelY,
    panelWidth,
    panelHeight,
  } = metrics
  fillRounded(
    ctx,
    panelX,
    panelY,
    panelWidth,
    panelHeight,
    22,
    "#263238"
  )

  ctx.textAlign = "left"
  ctx.textBaseline = "top"
  ctx.fillStyle = "#FFFFFF"
  ctx.font = font(23, "bold")
  ctx.fillText("玩家一览", panelX + 20, panelY + 16)

  const players = rankedPlayers(view)
  if (players.length === 0) return
  const gap = PANEL_ROW_GAP
  const padding = 16
  const cardWidth = panelWidth - padding * 2
  const cardHeight = PANEL_ROW_HEIGHT
  const columns = {
    netWorth: cardWidth * 0.36,
    cash: cardWidth * 0.52,
    items: cardWidth * 0.63,
  }

  // 表头
  ctx.textBaseline = "top"
  ctx.fillStyle = "#78909C"
  ctx.font = font(12, "bold")
  ctx.textAlign = "center"
  ctx.fillText("净资产", panelX + padding + columns.netWorth, panelY + 52)
  ctx.fillText("现金", panelX + padding + columns.cash, panelY + 52)
  ctx.textAlign = "left"
  ctx.fillText("道具", panelX + padding + columns.items, panelY + 52)

  players.forEach((player, index) => {
    const x = panelX + padding
    const y = panelY + PANEL_HEAD + index * (cardHeight + gap)
    const current = player.userId === view.currentPlayerId

    fillRounded(
      ctx,
      x,
      y,
      cardWidth,
      cardHeight,
      12,
      current ? "#37474F" : "#303E44"
    )
    ctx.fillStyle = player.active ? player.color : "#78909C"
    roundedRect(ctx, x, y, cardWidth, cardHeight, 12)
    ctx.save()
    ctx.clip()
    ctx.fillRect(x, y, 7, cardHeight)
    ctx.restore()
    if (current) {
      strokeRounded(
        ctx,
        x,
        y,
        cardWidth,
        cardHeight,
        12,
        "#FFD54F",
        2
      )
    }

    const title = `${player.displayRank}. ${player.label}`
    const titleSize = fitText(ctx, title, cardWidth * 0.28, 18, 11)
    ctx.font = font(titleSize, "bold")
    ctx.fillStyle = "#FFFFFF"
    ctx.textAlign = "left"
    ctx.textBaseline = "middle"
    ctx.fillText(title, x + 20, y + cardHeight / 2)

    ctx.textAlign = "center"
    for (const item of [
      {
        value: player.netWorth,
        centerX: x + columns.netWorth,
        color: "#FFFFFF",
      },
      {
        value: player.cash,
        centerX: x + columns.cash,
        color: "#CFD8DC",
      },
    ]) {
      ctx.fillStyle = item.color
      ctx.font = font(18, "bold")
      ctx.fillText(
        item.value.toLocaleString("zh-CN"),
        item.centerX,
        y + cardHeight / 2
      )
    }

    const text = itemsText(map, player)
    const itemsX = x + columns.items
    const size = fitText(
      ctx,
      text,
      cardWidth - columns.items - 20,
      15,
      10
    )
    ctx.textAlign = "left"
    ctx.fillStyle = text === "—" ? "#546E7A" : "#C9B6F5"
    ctx.font = font(size, "bold")
    ctx.fillText(text, itemsX, y + cardHeight / 2)
  })
}

export async function renderBoard(state, map, { events = [] } = {}) {
  ensureFont()
  const diceImages = await loadDiceAssets()
  const view = buildPublicView(state, map)
  const frame = buildFrame(view, events)
  const metrics = panelMetrics(map, view.players.length)
  const canvas = createCanvas(metrics.canvasWidth, metrics.canvasHeight)
  const ctx = canvas.getContext("2d")

  const gradient = ctx.createLinearGradient(
    0,
    0,
    metrics.canvasWidth,
    metrics.canvasHeight
  )
  gradient.addColorStop(0, "#F7F2E8")
  gradient.addColorStop(1, "#E8DED0")
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, metrics.canvasWidth, metrics.canvasHeight)

  for (const tile of map.tiles) drawTile(ctx, map, view, tile)
  drawCenter(ctx, map, view, events, diceImages, frame)
  drawTurnFocus(ctx, map, view, frame)
  drawTokens(ctx, map, view)
  drawPlayersPanel(ctx, view, metrics, map)

  return canvas.toBuffer("image/png")
}
