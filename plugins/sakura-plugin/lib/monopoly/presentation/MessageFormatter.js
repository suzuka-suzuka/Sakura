import {
  DECISIONS,
  END_REASONS,
  PHASES,
  PLAYER_STATUS,
} from "../constants.js"
import { buildPublicView } from "./PublicView.js"

function formatNumber(value) {
  return Number(value || 0).toLocaleString("zh-CN")
}

function nameOf(state, userId) {
  return (
    state.players.find((player) => player.userId === String(userId))
      ?.displayName || String(userId || "未知玩家")
  )
}

function tileOf(map, tileId) {
  return map.tiles.find((tile) => tile.id === Number(tileId)) || null
}

function tileName(map, tileId) {
  return tileOf(map, tileId)?.name || `格子 ${tileId}`
}

function cardOf(map, cardId) {
  for (const deck of map.chanceDecks) {
    const card = deck.cards.find((item) => item.id === cardId)
    if (card) return card
  }
  return null
}

function paymentLine(event, state, map) {
  const payer = nameOf(state, event.payerId)
  const recipient = event.recipientId
    ? nameOf(state, event.recipientId)
    : "银行"
  const amountText =
    event.paid === event.due
      ? `${formatNumber(event.paid)}`
      : `${formatNumber(event.paid)}／应付 ${formatNumber(event.due)}`

  if (event.reason === "rent") {
    return `💸 ${payer} 向 ${recipient} 支付 ${amountText} 租金（${tileName(map, event.tileId)}）。`
  }
  if (event.reason === "tax") {
    return `🧾 ${payer} 缴纳 ${amountText}（${tileName(map, event.tileId)}）。`
  }
  if (event.reason === "chance_transfer") {
    return `🤝 ${payer} 向 ${recipient} 支付 ${amountText}。`
  }
  if (event.reason === "chance") {
    return `💳 ${payer} 因机会牌支付 ${amountText}。`
  }
  return `💸 ${payer} 向 ${recipient} 支付 ${amountText}。`
}

function rankingLines(event, state) {
  return event.rankings.map((entry) => {
    const status =
      entry.status === PLAYER_STATUS.BANKRUPT
        ? "，已破产"
        : entry.status === PLAYER_STATUS.SURRENDERED
          ? "，已认输"
          : ""
    return `${entry.rank}. ${nameOf(state, entry.userId)}：净资产 ${formatNumber(entry.netWorth)}，现金 ${formatNumber(entry.cash)}，地产 ${entry.propertyCount}${status}`
  })
}

function decisiveRollCount(event) {
  const maximum = Math.max(
    0,
    ...event.playerIds.map((id) => event.rolls[id]?.length || 0)
  )
  for (let count = 1; count <= maximum; count++) {
    const signatures = event.playerIds.map((id) =>
      (event.rolls[id] || []).slice(0, count).join(":")
    )
    if (new Set(signatures).size === event.playerIds.length) return count
  }
  return maximum
}

function tieBreakRollText(rolls, decisiveCount) {
  const used = (rolls || []).slice(0, decisiveCount)
  if (used.length <= 5) return `${used.join("/")} 点`
  return `前 ${used.length - 1} 轮仍平，决胜 ${used.at(-1)} 点`
}

function eventLines(event, state, map) {
  switch (event.type) {
    case "game_created":
      return [
        `🎲 大富翁房间创建成功，房主是 ${nameOf(state, event.playerId)}。`,
        `发送【#加入大富翁】加入；${event.minPlayers}～${event.maxPlayers} 人，房主准备好后发送【#开始大富翁】。`,
      ]
    case "player_joined":
      return [
        `✅ ${nameOf(state, event.playerId)} 已加入，当前 ${event.playerCount}/${event.maxPlayers} 人。`,
      ]
    case "player_left":
      return [
        `↩️ ${event.displayName || nameOf(state, event.playerId)} 已退出，当前 ${event.playerCount} 人。`,
      ]
    case "host_changed":
      return [`房主已移交给 ${nameOf(state, event.playerId)}。`]
    case "game_started":
      return [
        `🏁 游戏开始！初始现金 ${formatNumber(event.startingCash)}，本局最多 ${event.roundLimit} 轮。`,
        `行动顺序：${event.playerOrder.map((id, index) => `${index + 1}. ${nameOf(state, id)}`).join(" → ")}`,
      ]
    case "turn_started":
      return [
        `第 ${event.round}/${event.roundLimit} 轮，轮到 ${nameOf(state, event.playerId)}，请在限时内发送【#掷骰】。`,
      ]
    case "dice_rolled":
      return [
        `🎲 ${nameOf(state, event.playerId)}${event.automatic ? "超时自动" : ""}掷出 ${event.value} 点。`,
      ]
    case "moved":
      return [
        `➡️ ${nameOf(state, event.playerId)} 移动到【${tileName(map, event.toTileId)}】。`,
      ]
    case "start_reward":
      return [
        `💰 ${nameOf(state, event.playerId)} 经过起点，获得 ${formatNumber(event.amount)}。`,
      ]
    case "purchase_offered":
      return [
        `🏠 【${tileName(map, event.tileId)}】售价 ${formatNumber(event.price)}。发送【#购买】或【#放弃】。`,
      ]
    case "upgrade_offered":
      return [
        `🏗️ 【${tileName(map, event.tileId)}】当前 ${event.currentLevel} 级，升级需 ${formatNumber(event.price)}。发送【#升级】或【#放弃】。`,
      ]
    case "property_purchased":
      return [
        `🏠 ${nameOf(state, event.playerId)} 以 ${formatNumber(event.amount)} 购买了【${tileName(map, event.tileId)}】。`,
      ]
    case "property_upgraded":
      return [
        `🏗️ ${nameOf(state, event.playerId)} 花费 ${formatNumber(event.amount)}，将【${tileName(map, event.tileId)}】升到 ${event.level} 级。`,
      ]
    case "decision_declined": {
      const action =
        event.decisionType === DECISIONS.PURCHASE ? "购买" : "升级"
      return [
        `${event.automatic ? "⏭️ 超时自动放弃" : "⏭️ 已放弃"}${action}【${tileName(map, event.tileId)}】。`,
      ]
    }
    case "roll_timed_out":
      return [
        `⏰ ${nameOf(state, event.playerId)} 未按时掷骰（连续 ${event.count}/${event.limit} 次）。`,
      ]
    case "decision_timed_out":
      return []
    case "chance_reshuffled":
      return ["机会牌已重新洗牌。"]
    case "chance_drawn": {
      const card = cardOf(map, event.cardId)
      return [
        `🎴 抽到【${card?.name || event.cardId}】：${card?.description || ""}`,
      ]
    }
    case "cash_granted": {
      const source =
        event.reason === "bonus"
          ? tileName(map, event.tileId)
          : "机会牌"
      return [
        `💰 ${nameOf(state, event.playerId)} 从【${source}】获得 ${formatNumber(event.amount)}。`,
      ]
    }
    case "payment":
      return [paymentLine(event, state, map)]
    case "property_liquidated":
      return [
        `📉 ${nameOf(state, event.playerId)} 强制变卖【${tileName(map, event.tileId)}】，回收 ${formatNumber(event.amount)}。`,
      ]
    case "property_returned":
      return [
        `🏦 【${tileName(map, event.tileId)}】已归还银行。`,
      ]
    case "player_bankrupt":
      return [`💥 ${nameOf(state, event.playerId)} 资不抵债，宣告破产。`]
    case "player_surrendered":
      return [
        event.reason === "roll_timeout"
          ? `💤 ${nameOf(state, event.playerId)} 连续三次未操作，按认输处理。`
          : `🏳️ ${nameOf(state, event.playerId)} 已认输。`,
      ]
    case "sent_to_jail":
      return [
        `🚓 ${nameOf(state, event.playerId)} 被送往【${tileName(map, event.toTileId)}】，将跳过下一次玩家回合。`,
      ]
    case "jail_turn_skipped":
      return [
        `🔒 ${nameOf(state, event.playerId)} 本次玩家回合在看守所中度过。`,
      ]
    case "tile_no_effect":
      if (event.tileType === "rest") {
        return [
          `🌳 ${nameOf(state, event.playerId)} 在【${tileName(map, event.tileId)}】休息。`,
        ]
      }
      if (event.tileType === "jail") {
        return [
          `👀 ${nameOf(state, event.playerId)} 只是探访【${tileName(map, event.tileId)}】。`,
        ]
      }
      return []
    case "resolution_limit_reached":
      return ["⚠️ 地图事件连锁达到安全上限，本次连锁已停止。"]
    case "ranking_tie_break":
      {
        const decisiveCount = decisiveRollCount(event)
        return [
          `🎲 净资产并列，系统自动掷骰决定顺序：${event.playerIds
            .map(
              (id) =>
                `${nameOf(state, id)} ${tieBreakRollText(
                  event.rolls[id],
                  decisiveCount
                )}`
            )
            .join("，")}。`,
        ]
      }
    case "game_ended":
      if (event.reason === END_REASONS.FORCE) {
        return ["🛑 本局大富翁已被强制结束，不计算胜者。"]
      }
      if (event.reason === END_REASONS.LOBBY_EMPTY) {
        return ["房间中已没有玩家，本局自动解散。"]
      }
      return [
        event.reason === END_REASONS.LAST_PLAYER
          ? `🏆 ${nameOf(state, event.winnerIds[0])} 成为最后一名在场玩家！`
          : `🏁 已达到本局轮次上限，按净资产结算。`,
        ...rankingLines(event, state),
      ]
    case "lobby_expired":
      return ["⌛ 大富翁房间超过等待时限仍未开始，已自动解散。"]
    default:
      return []
  }
}

function mentionFor(events, state) {
  if (state.phase === PHASES.ENDED || state.phase === PHASES.LOBBY) return null
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (
      event.type === "turn_started" ||
      event.type === "purchase_offered" ||
      event.type === "upgrade_offered"
    ) {
      return event.playerId
    }
  }
  return null
}

export function formatStatusText(state, map) {
  const view = buildPublicView(state, map)
  if (state.phase === PHASES.LOBBY) {
    return [
      `🎲 ${view.mapName}｜等待加入`,
      `房主：${nameOf(state, state.hostUserId)}`,
      `玩家（${state.players.length}/${map.gameDefaults.maxPlayers}）：${state.players.map((player) => player.displayName).join("、")}`,
      "房主发送【#开始大富翁】开局。",
    ].join("\n")
  }

  const current = view.players.find(
    (player) => player.userId === view.currentPlayerId
  )
  const lines = [
    `🎲 ${view.mapName}｜${view.phaseLabel}`,
    `轮次：${view.round}/${view.roundLimit}`,
    current ? `当前：${current.displayName}（${current.tileName}）` : "",
    ...view.players.map((player) => {
      const status = player.active
        ? ""
        : player.status === PLAYER_STATUS.BANKRUPT
          ? "｜已破产"
          : "｜已认输"
      return `${player.displayName}：现金 ${formatNumber(player.cash)}｜地产 ${player.propertyCount}｜净资产 ${formatNumber(player.netWorth)}${status}`
    }),
  ].filter(Boolean)
  return lines.join("\n")
}

export function formatResult(result, map) {
  if (
    result.events.length === 1 &&
    result.events[0].type === "status_requested"
  ) {
    return {
      text: formatStatusText(result.state, map),
      mentionUserId: null,
    }
  }

  const lines = result.events.flatMap((event) =>
    eventLines(event, result.state, map)
  )
  return {
    text: lines.join("\n") || "大富翁状态已更新。",
    mentionUserId: mentionFor(result.events, result.state),
  }
}

export function buildHelpText(map) {
  const defaults = map.gameDefaults
  return [
    `【QQ群大富翁｜${map.name}】`,
    `${defaults.minPlayers}～${defaults.maxPlayers} 人，初始现金 ${formatNumber(defaults.startingCash)}，使用 1 枚 ${defaults.diceSides} 面骰。`,
    "",
    "开局：#创建大富翁、#加入大富翁、#退出大富翁、#开始大富翁",
    "行动：#掷骰、#购买、#升级、#放弃、#认输",
    "查看：#大富翁状态、#大富翁规则",
    "管理：#结束大富翁",
    "",
    `掷骰限时 ${defaults.rollTimeoutSeconds} 秒，购买/升级限时 ${defaults.decisionTimeoutSeconds} 秒。连续 ${defaults.maxConsecutiveRollTimeouts} 次未掷骰会按认输处理。`,
    "经过起点获得奖励；购买地产、升级并向其他玩家收租。仅剩一人或达到轮次上限时结算。",
    "游戏现金只在本局使用，不影响 Sakura 的樱花币。",
  ].join("\n")
}
