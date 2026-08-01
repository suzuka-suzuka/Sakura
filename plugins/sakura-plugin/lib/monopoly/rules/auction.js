import {
  PHASES,
  PLAYER_STATUS,
  ruleError,
} from "../constants.js"
import { redemptionCost } from "./assets.js"
import { settlePayment } from "./settlement.js"
import { playerById, tileById } from "./state.js"

// 暗拍底价取抵押价：便宜到总有人愿意接，流拍才是例外
export function minimumBid(map, tile) {
  return tile.mortgageValue
}

function requireAuctionTile(state, map, tileId) {
  const tile = tileById(map, tileId)
  const propertyState = state.propertyStates[String(tileId)]
  if (!tile || tile.type !== "property" || !propertyState) {
    ruleError("INVALID_PROPERTY", "目标不是一块地产。")
  }
  if (propertyState.level > 0) {
    ruleError("PROPERTY_HAS_BUILDINGS", `${tile.name}上有建筑，不能拍卖。`)
  }
  return { tile, propertyState }
}

export function openAuction(
  state,
  map,
  { tileId, initiatorId, now, events }
) {
  const { tile, propertyState } = requireAuctionTile(state, map, tileId)
  state.phase = PHASES.AWAITING_AUCTION
  state.pendingAuction = {
    tileId: tile.id,
    initiatorId: String(initiatorId),
    ownerId: propertyState.ownerId,
    mortgaged: propertyState.mortgaged,
    minimumBid: minimumBid(map, tile),
    // 出价只存不播，开标前谁都看不到别人报了多少
    bids: [],
    seq: 0,
    createdAt: now,
  }
  state.deadlineAt =
    now + map.gameDefaults.auctionTimeoutSeconds * 1000
  events.push({
    type: "auction_opened",
    playerId: String(initiatorId),
    tileId: tile.id,
    ownerId: propertyState.ownerId,
    mortgaged: propertyState.mortgaged,
    minimumBid: state.pendingAuction.minimumBid,
    deadlineAt: state.deadlineAt,
  })
}

export function placeBid(state, map, { userId, amount, events }) {
  const pending = state.pendingAuction
  if (!pending || state.phase !== PHASES.AWAITING_AUCTION) {
    ruleError("NO_AUCTION", "现在没有正在进行的拍卖。")
  }
  const player = playerById(state, userId)
  if (!player) ruleError("NOT_PLAYER", "你不在这局大富翁中。")
  if (player.status !== PLAYER_STATUS.ACTIVE) {
    ruleError("PLAYER_INACTIVE", "你已经退出本局，不能出价。")
  }
  if (!Number.isSafeInteger(amount) || amount < pending.minimumBid) {
    ruleError("BID_TOO_LOW", `出价必须是不低于 ${pending.minimumBid} 的整数。`)
  }
  // 拍卖期间没人能动钱，所以现金上限在开标时依然成立
  if (amount > player.cash) {
    ruleError("INSUFFICIENT_CASH", `你只有 ${player.cash}，出不起这个价。`)
  }

  pending.seq += 1
  const existing = pending.bids.find(
    (bid) => bid.userId === player.userId
  )
  if (existing) {
    existing.amount = amount
    existing.seq = pending.seq
  } else {
    pending.bids.push({
      userId: player.userId,
      amount,
      seq: pending.seq,
    })
  }
  events.push({
    type: "bid_placed",
    playerId: player.userId,
    tileId: pending.tileId,
    // 金额只回给出价人自己，不写进任何群内播报
    amount,
    replaced: Boolean(existing),
    bidderCount: pending.bids.length,
  })
  return { amount, replaced: Boolean(existing) }
}

// 平价时先报价的赢：暗拍里这是唯一不泄露信息又可复现的裁决方式
function highestBid(pending) {
  return (
    [...pending.bids].sort(
      (left, right) => right.amount - left.amount || left.seq - right.seq
    )[0] || null
  )
}

export function resolveAuction(
  state,
  map,
  events,
  { automatic = false } = {}
) {
  const pending = state.pendingAuction
  if (!pending || state.phase !== PHASES.AWAITING_AUCTION) {
    ruleError("NO_AUCTION", "当前没有等待开标的拍卖。")
  }
  state.pendingAuction = null
  state.deadlineAt = 0

  const tile = tileById(map, pending.tileId)
  const propertyState = state.propertyStates[String(pending.tileId)]
  const winner = highestBid(pending)
  const buyer = winner ? playerById(state, winner.userId) : null

  if (!winner || !buyer || buyer.status !== PLAYER_STATUS.ACTIVE) {
    events.push({
      type: "auction_passed",
      tileId: pending.tileId,
      ownerId: propertyState?.ownerId ?? null,
      bidderCount: pending.bids.length,
      automatic,
    })
    return { sold: false }
  }

  const ownerId = propertyState.ownerId
  const keptByOwner = ownerId != null && ownerId === buyer.userId
  // 原主保留要把钱交给银行，白留就等于人人报天价，机制会被架空
  settlePayment(state, map, {
    payerId: buyer.userId,
    recipientId: keptByOwner ? null : ownerId,
    amount: winner.amount,
    reason: keptByOwner ? "auction_retain" : "auction",
    tileId: tile.id,
    events,
    force: true,
  })

  let interest = 0
  if (!keptByOwner) {
    if (propertyState.mortgaged) {
      // 接手抵押地和破产过户一样，要向银行补一成利息
      interest = Math.min(
        buyer.cash,
        redemptionCost(map, tile) - tile.mortgageValue
      )
      buyer.cash -= interest
    }
    propertyState.ownerId = buyer.userId
  }

  events.push({
    type: "auction_resolved",
    playerId: buyer.userId,
    tileId: tile.id,
    amount: winner.amount,
    ownerId,
    keptByOwner,
    mortgaged: propertyState.mortgaged,
    interest,
    bidderCount: pending.bids.length,
    automatic,
  })
  return { sold: !keptByOwner }
}
