import {
  PHASES,
  PLAYER_STATUS,
  playerPublicLabel,
} from "../constants.js"
import { hasItem, itemName } from "../rules/items.js"
import { itemAction } from "../rules/itemActions.js"
import { currentPlayer, playerById } from "../rules/state.js"
import { netWorthOf } from "../rules/victory.js"
import { drawnCardLine } from "./BoardRenderer.js"

function nameOf(state, userId) {
  const index = state.players.findIndex(
    (player) => player.userId === String(userId)
  )
  return index >= 0
    ? playerPublicLabel(state.players[index], index)
    : "未知玩家"
}

function yuan(value) {
  return Number(value || 0).toLocaleString("zh-CN")
}

function tileNameOf(map, tileId) {
  return (
    map?.tiles.find((tile) => tile.id === Number(tileId))?.name ||
    `格子${tileId}`
  )
}

// 不出图的那几帧，通知栏里的信息要在文字里补回来，否则玩家什么都看不到
function skippedBoardLines(result, map) {
  const lines = []
  for (const event of result.events) {
    if (event.type === "decision_declined") {
      const name =
        map?.tiles.find((tile) => tile.id === event.tileId)?.name || "这块地"
      lines.push(
        event.automatic ? `超时未选择 · 已放弃购买${name}` : `已放弃购买${name}`
      )
    } else if (event.type === "item_negated") {
      lines.push(
        `${nameOf(result.state, event.playerId)}打出否决令 · ${itemName(map, event.itemId)}失效`
      )
    }
  }
  return lines
}

function counterPrompt(state, map) {
  const pending = state.pendingAction
  const handler = itemAction(pending.itemId)
  const detail = handler?.describe(map, pending.args)
  const seconds = map?.gameDefaults?.counterTimeoutSeconds ?? 15
  const head =
    pending.chain.length === 0
      ? `${nameOf(state, pending.actorId)}对${nameOf(state, pending.victimId)}使用${itemName(map, pending.itemId)}`
      : `${nameOf(state, pending.chain.at(-1).userId)}打出了否决令`
  return {
    mentionUserId: pending.respondentId,
    text: [
      detail ? `${head} · ${detail}` : head,
      `发送【否决】可以让它作废，${seconds} 秒内不回应就直接生效。`,
    ].join("\n"),
  }
}

// 在狱中的回合要把两条出路一起说清楚，否则玩家只会干等
function jailTurnLine(state, map, event) {
  const bail = map?.gameDefaults?.jailBailAmount ?? 50
  const held = hasItem(
    state.players.find((player) => player.userId === event.playerId),
    "jail_free"
  )
  const exit = held ? "用掉保释令" : `付 ${bail}`
  return [
    `轮到${nameOf(state, event.playerId)}，你在看守所（还剩 ${event.jailTurns} 次机会）。`,
    `发送【r】掷对子免费出狱；发送【保释】（${exit}）立刻出狱，机会用尽会强制赎身。`,
  ].join("\n")
}

// 暗拍公告面向全场，没有可艾特的对象，只发文字
function auctionPrompt(state, map) {
  const pending = state.pendingAuction
  const tile = map?.tiles.find((item) => item.id === pending.tileId)
  const seconds = map?.gameDefaults?.auctionTimeoutSeconds ?? 45
  const owner = pending.ownerId
    ? `${nameOf(state, pending.ownerId)}的地`
    : "无主地"
  return {
    mentionUserId: null,
    text: [
      `${nameOf(state, pending.initiatorId)}把${tile?.name || "一块地"}挂上暗拍（${owner}${pending.mortgaged ? " · 抵押中" : ""}）。`,
      `底价 ${pending.minimumBid}，${seconds} 秒内私聊我发送【出价 金额】，出价互相保密，价高者得。`,
      pending.ownerId
        ? "原主也可以出价保住自己的地，但中标要把钱交给银行。"
        : "成交款归银行。",
    ].join("\n"),
  }
}

// 掷完骰给掷骰的人单发一条：发生了什么 + 现在轮到他做什么
function rollOutcomeFragments(result, map, roller) {
  const fragments = []
  const card = drawnCardLine(result.events, map)
  const seen = new Set()

  for (const event of result.events) {
    if (event.type === "start_reward" && event.playerId === roller.userId) {
      fragments.push({ key: "start", text: `经过起点 +${yuan(event.amount)}` })
    } else if (event.type === "chance_drawn" && card && !seen.has("card")) {
      seen.add("card")
      fragments.push({ key: "card", text: card })
    } else if (event.type === "payment" && event.payerId === roller.userId) {
      const target = event.recipientId
        ? `向${nameOf(result.state, event.recipientId)}`
        : "向银行"
      const reason =
        event.reason === "rent"
          ? "付租金"
          : event.reason === "jail_bail"
            ? "付保释金"
            : "付费"
      fragments.push({ key: "pay", text: `${target}${reason} ${yuan(event.paid)}` })
    } else if (
      event.type === "payment" &&
      event.recipientId === roller.userId
    ) {
      fragments.push({
        key: "gain",
        text: `收到${nameOf(result.state, event.payerId)} ${yuan(event.paid)}`,
      })
    } else if (
      event.type === "cash_granted" &&
      event.playerId === roller.userId
    ) {
      fragments.push({ key: "gain", text: `获得 ${yuan(event.amount)}` })
    } else if (
      event.type === "sent_to_jail" &&
      event.playerId === roller.userId
    ) {
      fragments.push({ key: "jail", text: "被送进看守所" })
    } else if (
      event.type === "jail_roll_failed" &&
      event.playerId === roller.userId
    ) {
      fragments.push({
        key: "jail",
        text: `没掷出对子 · 还剩 ${event.remainingTurns} 次机会`,
      })
    } else if (
      event.type === "jail_released" &&
      event.playerId === roller.userId
    ) {
      fragments.push({
        key: "jail",
        text: event.paid > 0 ? `赎身 ${yuan(event.paid)} 出狱` : "出狱",
      })
    } else if (
      event.type === "player_bankrupt" &&
      event.playerId === roller.userId
    ) {
      fragments.push({ key: "bankrupt", text: "已破产出局" })
    } else if (
      event.type === "decision_declined" &&
      event.playerId === roller.userId
    ) {
      // 超时代掷会连购买一起自动放弃，这条要让本人看到
      fragments.push({
        key: "decline",
        text: `${event.automatic ? "超时未选择 · " : ""}放弃购买${tileNameOf(map, event.tileId)}`,
      })
    }
  }

  // 只留两条，过起点是最不值钱的那条，挤的时候先丢它
  if (fragments.length > 2) {
    const trimmed = fragments.filter((item) => item.key !== "start")
    return (trimmed.length ? trimmed : fragments).slice(-2).map((i) => i.text)
  }
  return fragments.map((item) => item.text)
}

function rollStatusLine(state, map, player) {
  const cash = `现金 ${yuan(player.cash)}`
  if (
    state.phase === PHASES.AWAITING_PURCHASE &&
    state.pendingDecision?.playerId === player.userId
  ) {
    const tile = map?.tiles.find(
      (item) => item.id === state.pendingDecision.tileId
    )
    return `${cash} · ${tile?.name || "这块地"}售价 ${yuan(tile?.price)}，发送【购买】或【放弃】`
  }
  if (
    state.phase === PHASES.AWAITING_DEBT &&
    state.pendingDebt?.payerId === player.userId
  ) {
    const shortfall = Math.max(0, state.pendingDebt.amount - player.cash)
    return `${cash} · 尚缺 ${yuan(shortfall)}，可【卖房】【抵押】或【强制结算】`
  }
  if (player.status !== PLAYER_STATUS.ACTIVE || !map) return cash
  return `${cash} · 净资产 ${yuan(netWorthOf(state, map, player.userId))}`
}

export function buildRollSummary(result, map = null) {
  const { state, events } = result
  if (state.phase === PHASES.ENDED) return null
  const dice = events.findLast((event) => event.type === "dice_rolled")
  if (!dice) return null
  const roller = playerById(state, dice.playerId)
  if (!roller) return null

  const head = [`掷出 ${dice.values.join("+")}=${dice.total}`]
  if (dice.isDouble) head.push("对子")
  if (dice.automatic) head.push("超时代掷")
  head.push(`停在${tileNameOf(map, roller.position)}`)

  return {
    mentionUserId: roller.userId,
    text: [
      head.join(" · "),
      ...rollOutcomeFragments(result, map, roller),
      rollStatusLine(state, map, roller),
    ].join("\n"),
  }
}

export function buildTurnPrompt(result, map = null) {
  const { state, events, renderBoard } = result
  if (state.phase === PHASES.ENDED) return null
  // 反制窗口：只艾特现在能接话的人
  if (state.phase === PHASES.AWAITING_COUNTER && state.pendingAction) {
    return counterPrompt(state, map)
  }
  if (state.phase === PHASES.AWAITING_AUCTION && state.pendingAuction) {
    return auctionPrompt(state, map)
  }

  // 放弃后若掷出过对子，轮次不换人，只有「再掷一次」这一个事件，
  // 不出图时必须靠它兜底，否则整帧一个字都发不出去
  const event = events.findLast(
    (item) =>
      item.type === "turn_started" ||
      (!renderBoard && item.type === "extra_roll_awarded")
  )
  const lines = renderBoard ? [] : skippedBoardLines(result, map)
  if (event) {
    lines.push(
      event.type === "extra_roll_awarded"
        ? `${nameOf(state, event.playerId)}掷出对子，再发送【r】掷一次。`
        : event.jailTurns > 0
          ? jailTurnLine(state, map, event)
          : `轮到${nameOf(state, event.playerId)}，资产操作完成后发送【r】掷骰。`
    )
  }
  if (lines.length === 0) return null
  return {
    mentionUserId: event?.playerId || currentPlayer(state)?.userId,
    text: lines.join("\n"),
  }
}

// 掷骰回执发给掷骰的人，回合提示发给接棒的人；正好是同一个人时合成一条，别连 @ 两次
export function buildTurnMessages(result, map = null) {
  const summary = buildRollSummary(result, map)
  const prompt = buildTurnPrompt(result, map)
  if (!summary) return prompt ? [prompt] : []
  if (!prompt) return [summary]
  if (summary.mentionUserId === prompt.mentionUserId) {
    return [
      {
        mentionUserId: prompt.mentionUserId,
        text: `${summary.text}\n${prompt.text}`,
      },
    ]
  }
  return [summary, prompt]
}
