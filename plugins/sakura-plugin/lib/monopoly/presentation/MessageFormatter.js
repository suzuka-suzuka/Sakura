import {
  PHASES,
  playerPublicLabel,
} from "../constants.js"
import { itemName } from "../rules/items.js"
import { itemAction } from "../rules/itemActions.js"
import { currentPlayer } from "../rules/state.js"

function nameOf(state, userId) {
  const index = state.players.findIndex(
    (player) => player.userId === String(userId)
  )
  return index >= 0
    ? playerPublicLabel(state.players[index], index)
    : "未知玩家"
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

export function buildTurnPrompt(result, map = null) {
  const { state, events, renderBoard } = result
  if (state.phase === PHASES.ENDED) return null
  // 反制窗口：只艾特现在能接话的人
  if (state.phase === PHASES.AWAITING_COUNTER && state.pendingAction) {
    return counterPrompt(state, map)
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
        : `轮到${nameOf(state, event.playerId)}，资产操作完成后发送【r】掷骰。`
    )
  }
  if (lines.length === 0) return null
  return {
    mentionUserId: event?.playerId || currentPlayer(state)?.userId,
    text: lines.join("\n"),
  }
}
