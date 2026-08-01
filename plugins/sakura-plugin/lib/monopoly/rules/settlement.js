import {
  PHASES,
  PLAYER_STATUS,
  ruleError,
} from "../constants.js"
import { returnBuildingsToBank } from "./buildings.js"
import { dropAllItems } from "./items.js"
import { autoLiquidate } from "./liquidation.js"
import {
  ownedPropertyEntries,
  playerById,
} from "./state.js"

export function liquidationValue(map, tile, propertyState) {
  if (propertyState.mortgaged) return tile.mortgageValue
  return tile.price + (tile.upgradeCost || 0) * propertyState.level
}

// 破产清算：欠玩家的把地连同抵押状态转给债主，欠银行的照旧退回银行。
// 建筑一律先折回银行库存，转手的永远是空地——和原版「先卖光房子再交地契」一致。
export function handOverEstate(
  state,
  map,
  playerId,
  creditorId,
  events,
  reason
) {
  const creditor = creditorId == null ? null : playerById(state, creditorId)
  const toCreditor =
    creditor != null &&
    creditor.status === PLAYER_STATUS.ACTIVE &&
    creditor.userId !== String(playerId)
  let transferred = 0
  let mortgagedCount = 0
  let interestDue = 0

  for (const { tile, propertyState } of ownedPropertyEntries(
    state,
    map,
    playerId
  )) {
    const previousLevel = propertyState.level
    const returnedBuildings = returnBuildingsToBank(
      state,
      map,
      previousLevel
    )
    propertyState.level = 0

    if (toCreditor) {
      propertyState.ownerId = creditor.userId
      transferred += 1
      if (propertyState.mortgaged) {
        mortgagedCount += 1
        // 接手抵押地要立刻向银行付一次利息，地契仍然是抵押状态
        interestDue += Math.ceil(
          tile.mortgageValue * map.gameDefaults.mortgageInterestRate
        )
      }
      events.push({
        type: "property_transferred",
        playerId: String(playerId),
        recipientId: creditor.userId,
        tileId: tile.id,
        previousLevel,
        returnedBuildings,
        mortgaged: propertyState.mortgaged,
        reason,
      })
      continue
    }

    propertyState.ownerId = null
    propertyState.mortgaged = false
    events.push({
      type: "property_returned",
      playerId: String(playerId),
      tileId: tile.id,
      previousLevel,
      returnedBuildings,
      reason,
    })
  }

  if (transferred > 0) {
    // 债主掏不出全额利息时只扣到见底，不再把债主也拖进欠款流程
    const interest = Math.min(creditor.cash, interestDue)
    creditor.cash -= interest
    events.push({
      type: "properties_transferred",
      playerId: String(playerId),
      recipientId: creditor.userId,
      count: transferred,
      mortgagedCount,
      interest,
      interestDue,
      reason,
    })
  }
}

export function returnAllPropertiesToBank(
  state,
  map,
  playerId,
  events,
  reason
) {
  handOverEstate(state, map, playerId, null, events, reason)
}

export function surrenderPlayer(
  state,
  map,
  playerId,
  events,
  reason = "surrender"
) {
  const player = playerById(state, playerId)
  if (!player) ruleError("NOT_PLAYER", "认输玩家不存在。")
  if (player.status !== PLAYER_STATUS.ACTIVE) return false

  player.cash = 0
  player.status = PLAYER_STATUS.SURRENDERED
  dropAllItems(state, player.userId, events, reason)
  returnAllPropertiesToBank(state, map, player.userId, events, reason)
  events.push({
    type: "player_surrendered",
    playerId: player.userId,
    reason,
  })
  return true
}

function markBankrupt(state, map, player, events, reason, creditorId = null) {
  player.cash = 0
  player.status = PLAYER_STATUS.BANKRUPT
  // 道具不随地产转给债主，一律作废
  dropAllItems(state, player.userId, events, "bankruptcy")
  handOverEstate(
    state,
    map,
    player.userId,
    creditorId,
    events,
    "bankruptcy"
  )
  events.push({
    type: "player_bankrupt",
    playerId: player.userId,
    reason,
  })
}

export function settlePayment(
  state,
  map,
  {
    payerId,
    recipientId = null,
    amount,
    reason,
    tileId = null,
    cardId = null,
    events,
    force = false,
  }
) {
  const payer = playerById(state, payerId)
  if (!payer) ruleError("NOT_PLAYER", "付款玩家不存在。")
  if (payer.status !== PLAYER_STATUS.ACTIVE) {
    return { due: amount, paid: 0, bankrupt: true }
  }
  if (!Number.isSafeInteger(amount) || amount < 0) {
    ruleError("INVALID_PAYMENT", "付款金额必须是非负整数。")
  }

  const recipient =
    recipientId === null ? null : playerById(state, recipientId)
  if (recipientId !== null && !recipient) {
    ruleError("NOT_PLAYER", "收款玩家不存在。")
  }

  if (payer.cash < amount && !force) {
    return {
      due: amount,
      paid: 0,
      bankrupt: false,
      needsDebtResolution: true,
    }
  }

  const paid = Math.min(payer.cash, amount)
  payer.cash -= paid
  if (recipient?.status === PLAYER_STATUS.ACTIVE) recipient.cash += paid

  events.push({
    type: "payment",
    payerId: payer.userId,
    recipientId: recipient?.userId || null,
    due: amount,
    paid,
    reason,
    tileId,
    cardId,
  })

  const bankrupt = paid < amount
  if (bankrupt) {
    markBankrupt(state, map, payer, events, reason, recipient?.userId ?? null)
  }
  return { due: amount, paid, bankrupt }
}

function storedPayment(payment) {
  return {
    payerId: String(payment.payerId),
    recipientId:
      payment.recipientId == null ? null : String(payment.recipientId),
    amount: payment.amount,
    reason: payment.reason,
    tileId: payment.tileId ?? null,
    cardId: payment.cardId ?? null,
  }
}

export function processPaymentQueue(
  state,
  map,
  payments,
  events,
  { now, allowDebt = true } = {}
) {
  const queue = payments.map(storedPayment)
  for (let index = 0; index < queue.length; index++) {
    const payment = queue[index]
    const payer = playerById(state, payment.payerId)
    if (!payer || payer.status !== PLAYER_STATUS.ACTIVE) continue
    const result = settlePayment(state, map, {
      ...payment,
      events,
      force: !allowDebt,
    })
    if (!result.needsDebtResolution) continue
    if (!Number.isSafeInteger(now) || now < 0) {
      ruleError("INVALID_TIME", "欠款处理需要有效的当前时间。")
    }
    state.phase = PHASES.AWAITING_DEBT
    state.pendingDebt = {
      ...payment,
      remainingPayments: queue.slice(index + 1),
      createdAt: now,
    }
    state.deadlineAt =
      now + map.gameDefaults.debtTimeoutSeconds * 1000
    events.push({
      type: "debt_required",
      ...payment,
      cash: payer.cash,
      shortfall: payment.amount - payer.cash,
      deadlineAt: state.deadlineAt,
    })
    return { pending: true, payment: state.pendingDebt }
  }
  return { pending: false }
}

export function resolvePendingDebt(
  state,
  map,
  events,
  { now, automatic = false } = {}
) {
  const pending = state.pendingDebt
  if (!pending || state.phase !== PHASES.AWAITING_DEBT) {
    ruleError("NO_PENDING_DEBT", "当前没有等待处理的欠款。")
  }
  const currentPayment = storedPayment(pending)
  const remainingPayments = Array.isArray(pending.remainingPayments)
    ? pending.remainingPayments.map(storedPayment)
    : []
  state.pendingDebt = null
  state.phase = PHASES.RESOLVING
  state.deadlineAt = 0

  // 掏光现金之前先自动变现，卖到还不起为止才算真破产
  const payer = playerById(state, currentPayment.payerId)
  if (payer?.status === PLAYER_STATUS.ACTIVE && payer.cash < currentPayment.amount) {
    autoLiquidate(
      state,
      map,
      payer.userId,
      currentPayment.amount,
      events
    )
  }

  const result = settlePayment(state, map, {
    ...currentPayment,
    events,
    force: true,
  })
  events.push({
    type: "debt_resolved",
    playerId: currentPayment.payerId,
    automatic,
    paid: result.paid,
    due: result.due,
    bankrupt: result.bankrupt,
  })
  const queued = processPaymentQueue(
    state,
    map,
    remainingPayments,
    events,
    { now, allowDebt: true }
  )
  return { ...result, pending: queued.pending }
}

export function grantCash(
  state,
  playerId,
  amount,
  events,
  reason,
  { tileId = null, cardId = null } = {}
) {
  const player = playerById(state, playerId)
  if (!player) ruleError("NOT_PLAYER", "收款玩家不存在。")
  if (!Number.isSafeInteger(amount) || amount < 0) {
    ruleError("INVALID_PAYMENT", "增加现金必须是非负整数。")
  }
  if (player.status !== PLAYER_STATUS.ACTIVE || amount === 0) return 0
  player.cash += amount
  events.push({
    type: "cash_granted",
    playerId: player.userId,
    amount,
    reason,
    tileId,
    cardId,
  })
  return amount
}
