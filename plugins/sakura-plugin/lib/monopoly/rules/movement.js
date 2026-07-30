import { ruleError } from "../constants.js"
import { playerById, tileById } from "./state.js"

function pathIndex(map, tileId) {
  const index = map.board.path.indexOf(tileId)
  if (index < 0) ruleError("INVALID_POSITION", `格子 ${tileId} 不在地图路径中。`)
  return index
}

function grantStartReward(state, map, player, count, events, reason) {
  if (count <= 0 || map.gameDefaults.passStartReward <= 0) return 0
  const amount = count * map.gameDefaults.passStartReward
  player.cash += amount
  events.push({
    type: "start_reward",
    playerId: player.userId,
    amount,
    count,
    reason,
  })
  return amount
}

export function moveBy(
  state,
  map,
  playerId,
  steps,
  {
    collectStartReward = true,
    events = [],
    reason = "move",
  } = {}
) {
  const player = playerById(state, playerId)
  if (!player) ruleError("NOT_PLAYER", "移动目标玩家不存在。")
  if (!Number.isSafeInteger(steps) || steps === 0) {
    ruleError("INVALID_MOVE", "移动格数必须是非零整数。")
  }

  const path = map.board.path
  const from = player.position
  const fromIndex = pathIndex(map, from)
  const rawIndex = fromIndex + steps
  const wrappedIndex = ((rawIndex % path.length) + path.length) % path.length
  const to = path[wrappedIndex]

  let crossings = 0
  if (collectStartReward && steps > 0) {
    crossings = Math.floor(rawIndex / path.length)
    grantStartReward(state, map, player, crossings, events, reason)
  }

  player.position = to
  events.push({
    type: "moved",
    playerId: player.userId,
    fromTileId: from,
    toTileId: to,
    steps,
    startCrossings: crossings,
    reason,
  })
  return tileById(map, to)
}

export function moveTo(
  state,
  map,
  playerId,
  targetTileId,
  {
    collectStartReward = false,
    events = [],
    reason = "move_to",
  } = {}
) {
  const player = playerById(state, playerId)
  if (!player) ruleError("NOT_PLAYER", "移动目标玩家不存在。")
  const target = tileById(map, targetTileId)
  if (!target) ruleError("INVALID_MOVE", `目标格 ${targetTileId} 不存在。`)

  const from = player.position
  if (collectStartReward) {
    grantStartReward(state, map, player, 1, events, reason)
  }
  player.position = target.id
  events.push({
    type: "moved",
    playerId: player.userId,
    fromTileId: from,
    toTileId: target.id,
    steps: null,
    startCrossings: collectStartReward ? 1 : 0,
    reason,
  })
  return target
}

export function sendToJail(
  state,
  map,
  playerId,
  targetTileId,
  jailTurns,
  events,
  reason = "jail"
) {
  const player = playerById(state, playerId)
  if (!player) ruleError("NOT_PLAYER", "送往看守所的玩家不存在。")
  const target = tileById(map, targetTileId)
  if (!target || target.type !== "jail") {
    ruleError("INVALID_JAIL", "看守所目标格无效。")
  }
  const from = player.position
  player.position = target.id
  player.jailTurns = jailTurns
  events.push({
    type: "sent_to_jail",
    playerId: player.userId,
    fromTileId: from,
    toTileId: target.id,
    jailTurns,
    reason,
  })
}
