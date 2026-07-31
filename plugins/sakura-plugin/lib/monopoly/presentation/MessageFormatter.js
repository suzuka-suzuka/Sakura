import {
  PHASES,
  playerPublicLabel,
} from "../constants.js"

function nameOf(state, userId) {
  const index = state.players.findIndex(
    (player) => player.userId === String(userId)
  )
  return index >= 0
    ? playerPublicLabel(state.players[index], index)
    : "未知玩家"
}

export function buildTurnPrompt(result) {
  const event = result.events.findLast(
    (item) => item.type === "turn_started"
  )
  if (!event || result.state.phase === PHASES.ENDED) return null
  return {
    mentionUserId: event.playerId,
    text: `轮到${nameOf(result.state, event.playerId)}，请在资产操作完成后发送【掷骰】。`,
  }
}
