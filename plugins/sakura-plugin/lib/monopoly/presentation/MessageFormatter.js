import {
  END_REASONS,
  PHASES,
  PLAYER_STATUS,
  playerPublicLabel,
} from "../constants.js"
import { hasItem, itemName } from "../rules/items.js"
import { itemAction } from "../rules/itemActions.js"
import { redemptionCost } from "../rules/assets.js"
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

function tileOf(map, tileId) {
  return map?.tiles.find((tile) => tile.id === Number(tileId)) || null
}

function tileNameOf(map, tileId) {
  return tileOf(map, tileId)?.name || `格子${tileId}`
}

const PAYMENT_REASONS = Object.freeze({
  rent: "租金",
  jail_bail: "保释金",
  tax_audit: "补税",
  auction: "拍卖成交款",
  auction_retain: "保留费",
})

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

// 对子加掷还欠着一次。中途插进来的抵押、建房这些帧不带任何回合事件，
// 报完账就没人提醒他还得再掷，一局很容易卡死在这儿
function owesExtraRoll(state) {
  const dice = state.lastDice
  const player = currentPlayer(state)
  return Boolean(
    state.phase === PHASES.AWAITING_ROLL &&
      dice?.extraRollAwarded &&
      player &&
      dice.playerId === player.userId &&
      dice.turnSeq === state.turnSeq
  )
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
      const reason = PAYMENT_REASONS[event.reason] || "费"
      fragments.push({
        key: "pay",
        text: `${target}付${reason} ${yuan(event.paid)}`,
      })
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
      event.playerId === roller.userId &&
      // 连续对子入狱由全场播报那条解释，这里再来一句「被送进看守所」
      // 只会让人更糊涂：明明掷出的是对子，怎么就进去了
      event.reason !== "consecutive_doubles"
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
    }
    // 放弃购买（含超时代掷连带的自动放弃）由全场播报那条负责，这里不重复
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

// 自己发指令换来的这笔账：花了多少、到手多少。原来只画进棋盘角落，
// 图一折叠就什么都看不到，钱去哪了得自己倒推，所以再单发一条给掏钱的人
function receiptEntry(event, state, map) {
  const tile = () => tileNameOf(map, event.tileId)
  const entry = (playerId, text) => ({ playerId, text })
  switch (event.type) {
    case "property_purchased":
      return entry(event.playerId, `买下${tile()} · 支付 ${yuan(event.amount)}`)
    case "property_upgraded":
      return entry(
        event.playerId,
        `${tile()}建成${event.building} · 花费 ${yuan(event.amount)}`
      )
    case "building_sold":
      return entry(
        event.playerId,
        `${tile()}拆到${event.building} · 收回 ${yuan(event.amount)}`
      )
    case "property_mortgaged": {
      // 抵押是笔有代价的贷款，赎回价和副作用要当场讲清楚，
      // 不然玩家只记得到手多少，回头凑不出赎回的钱
      const target = tileOf(map, event.tileId)
      const redeem = target ? redemptionCost(map, target) : 0
      return entry(
        event.playerId,
        [
          `抵押${tile()} · 到手 ${yuan(event.amount)}`,
          redeem
            ? `赎回要 ${yuan(redeem)}（含利息 ${yuan(redeem - event.amount)}），掷骰前发【赎回${target.name}】`
            : null,
          "抵押期间这块地不收租，整个色组也不能建房",
        ]
          .filter(Boolean)
          .join("\n")
      )
    }
    case "property_redeemed":
      return entry(
        event.playerId,
        `赎回${tile()} · 支付 ${yuan(event.amount)}（含利息 ${yuan(event.interest)}）\n已解除抵押，恢复收租`
      )
    case "property_bought_out":
      return entry(event.playerId, `买下${tile()} · 支付 ${yuan(event.amount)}`)
    case "auto_liquidated": {
      const parts = []
      if (event.mortgaged > 0) parts.push(`抵押 ${event.mortgaged} 处`)
      if (event.sold > 0) parts.push(`拆房 ${event.sold} 栋`)
      return entry(
        event.playerId,
        `自动变现 · ${parts.join(" · ")} · 共 ${yuan(event.amount)}`
      )
    }
    case "payment":
      return entry(
        event.payerId,
        `向${event.recipientId ? nameOf(state, event.recipientId) : "银行"}支付${
          PAYMENT_REASONS[event.reason] || "费用"
        } ${yuan(event.paid)}`
      )
    default:
      return null
  }
}

// 按掏钱的人分组：稽查令这种「我出手、他付钱」的帧，两边各收各的回执
export function buildActionReceipts(result, map = null) {
  const { state, events } = result
  // 掷骰帧的钱账由掷骰回执负责，这里再报一遍就是同一条消息里说两次
  const rolled = events.some((event) => event.type === "dice_rolled")
  const byPlayer = new Map()
  for (const event of events) {
    if (rolled && event.type === "payment") continue
    const entry = receiptEntry(event, state, map)
    if (!entry) continue
    const lines = byPlayer.get(entry.playerId) || []
    lines.push(entry.text)
    byPlayer.set(entry.playerId, lines)
  }
  const receipts = []
  for (const [playerId, lines] of byPlayer) {
    const actor = playerById(state, playerId)
    // 刚出局的人不用再收一张对账单，全场播报里已经说明他的结局
    if (!actor || actor.status !== PLAYER_STATUS.ACTIVE) continue
    receipts.push({
      mentionUserId: actor.userId,
      text: [...lines, rollStatusLine(state, map, actor)].join("\n"),
    })
  }
  return receipts
}

function endingLines(event, state) {
  if (event.reason === END_REASONS.FORCE) return ["本局大富翁已被强制结束。"]
  if (event.reason !== END_REASONS.LAST_PLAYER) return ["房间已解散。"]
  const champion = event.winnerIds?.length
    ? `🏆 ${event.winnerIds.map((id) => nameOf(state, id)).join("、")}获胜！`
    : "本局大富翁结束。"
  return [
    champion,
    ...(event.rankings || [])
      .slice(0, 3)
      .map(
        (entry) =>
          `${entry.rank}. ${nameOf(state, entry.userId)} · 净资产 ${yuan(entry.netWorth)}`
      ),
  ]
}

// 面向全场的关键播报：谁上了桌、谁拍到了地、谁出局了、最后谁赢了。
// 这些不属于任何一个人的回执，所以不艾特，但同样不能只留在图里
function noticeLines(event, state, map) {
  switch (event.type) {
    case "game_created":
      return [
        `大富翁房间已开，发送【加入大富翁】上桌。`,
        `满 ${event.minPlayers} 人后由房主发送【开始大富翁】，最多 ${event.maxPlayers} 人。`,
      ]
    case "player_joined":
      return [
        `${nameOf(state, event.playerId)}已加入 · 当前 ${event.playerCount}/${event.maxPlayers} 人`,
      ]
    case "player_left":
      return [`玩家${event.playerNumber}已退出 · 当前 ${event.playerCount} 人`]
    case "host_changed":
      return [`房主已移交给${nameOf(state, event.playerId)}`]
    case "game_started":
      return [`游戏开始 · 每人 ${yuan(event.startingCash)}`]
    case "item_granted":
      return [
        `${nameOf(state, event.playerId)}获得道具 · ${itemName(map, event.itemId)}`,
      ]
    case "item_used":
      // 主动使用有 item_targeted、打否决有 item_negated，这里只剩自动消耗的保释令
      return event.reason === "jail"
        ? [
            `${nameOf(state, event.playerId)}用掉${itemName(map, event.itemId)} · 免去看守所`,
          ]
        : null
    case "item_targeted":
      // 开了否决窗口的话由那条提示公布，别说两遍
      return state.phase === PHASES.AWAITING_COUNTER
        ? null
        : [
            `${nameOf(state, event.playerId)}对${nameOf(state, event.victimId)}使用${itemName(map, event.itemId)}` +
              (event.detail ? ` · ${event.detail}` : ""),
          ]
    // 强制收购不是卡牌，没有 item_targeted，被收购的人全靠这条知道自己挨了打
    case "force_buy_declared":
      return state.phase === PHASES.AWAITING_COUNTER
        ? null
        : [
            `${nameOf(state, event.playerId)}对${nameOf(state, event.victimId)}发起强制收购${tileNameOf(map, event.tileId)} · ${yuan(event.price)}`,
            `本局还剩 ${event.remaining} 次强制收购`,
          ]
    case "counter_chain_resolved":
      return [
        `否决链 ${event.depth} 层 · ${itemName(map, event.itemId)}最终生效`,
      ]
    case "item_fizzled":
      return [`${itemName(map, event.itemId)}目标已失效 · 本次落空`]
    case "property_swapped":
      return [
        `${nameOf(state, event.playerId)}用${tileNameOf(map, event.givenTileId)}换走${nameOf(state, event.recipientId)}的${tileNameOf(map, event.takenTileId)}`,
      ]
    case "building_demolished":
      return [
        `${nameOf(state, event.recipientId)}的${tileNameOf(map, event.tileId)}被强拆至${event.building} · 无补偿`,
      ]
    case "mortgaged_property_visited":
      return [`${tileNameOf(map, event.tileId)}抵押中 · 本次不收租`]
    case "repairs_assessed":
      return event.amount > 0
        ? [
            `${nameOf(state, event.playerId)}维修 ${event.houses} 房 ${event.hotels} 旅馆 · 共 ${yuan(event.amount)}`,
          ]
        : null
    case "debt_required":
      return [
        `${nameOf(state, event.payerId)}尚缺 ${yuan(event.shortfall)}，全场等他筹款`,
      ]
    case "roll_timed_out":
      return [
        `${nameOf(state, event.playerId)}掷骰超时 · ${event.count}/${event.limit}，已代掷`,
      ]
    case "jail_released":
      // 掷对子出狱、机会用尽强制赎身都在掷骰回执里，这里只补主动保释那一次。
      // 金额留给本人的付款回执，这条只向全场交代人已经出来了
      return event.reason === "bail"
        ? [`${nameOf(state, event.playerId)}已交保释金出狱`]
        : null
    case "auction_resolved":
      return [
        event.keptByOwner
          ? `${nameOf(state, event.playerId)}以 ${yuan(event.amount)} 保住${tileNameOf(map, event.tileId)}，款项归银行。`
          : `${nameOf(state, event.playerId)}以 ${yuan(event.amount)} 拍得${tileNameOf(map, event.tileId)}（${event.bidderCount} 人出价）。`,
      ]
    case "auction_passed":
      return [`${tileNameOf(map, event.tileId)}无人出价 · 流拍`]
    case "player_bankrupt":
      return [`${nameOf(state, event.playerId)}已破产出局`]
    case "properties_transferred":
      return [
        `${nameOf(state, event.playerId)}名下 ${event.count} 处地产转给${nameOf(state, event.recipientId)}` +
          (event.interest > 0 ? ` · 接手利息 ${yuan(event.interest)}` : ""),
      ]
    case "player_surrendered":
      return [`${nameOf(state, event.playerId)}已认输`]
    case "triple_doubles_jail":
      return [
        `${nameOf(state, event.playerId)}连续 ${event.doublesCount} 次对子 · 直接进看守所`,
        `这一掷不走位，加掷资格一并作废，本回合到此结束。`,
      ]
    case "decision_declined":
      return [
        `${nameOf(state, event.playerId)}${event.automatic ? "超时未选择 · " : ""}放弃购买${tileNameOf(map, event.tileId)}`,
      ]
    case "item_negated":
      return [
        `${nameOf(state, event.playerId)}打出否决令 · ${itemName(map, event.itemId)}失效`,
      ]
    case "game_ended":
      return endingLines(event, state)
    default:
      return null
  }
}

export function buildPublicNotice(result, map = null) {
  const { state, events } = result
  const lines = []
  for (const event of events) {
    lines.push(...(noticeLines(event, state, map) || []))
  }
  if (!lines.length) return null
  return { mentionUserId: null, text: lines.join("\n") }
}

export function buildRollSummary(result, map = null) {
  const { state, events } = result
  if (state.phase === PHASES.ENDED) return null
  const dice = events.findLast((event) => event.type === "dice_rolled")
  if (!dice) return null
  const roller = playerById(state, dice.playerId)
  if (!roller) return null

  // 三连对子的人根本没走这一步，写「停在看守所」会被读成路过探监
  const jailed = events.find(
    (event) =>
      event.type === "triple_doubles_jail" && event.playerId === roller.userId
  )
  const head = [`掷出 ${dice.values.join("+")}=${dice.total}`]
  if (dice.isDouble) {
    head.push(jailed ? `连续第 ${jailed.doublesCount} 次对子` : "对子")
  }
  if (dice.automatic) head.push("超时代掷")
  head.push(
    jailed ? "直接关进看守所" : `停在${tileNameOf(map, roller.position)}`
  )

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
  const { state, events } = result
  if (state.phase === PHASES.ENDED) return null
  // 反制窗口：只艾特现在能接话的人
  if (state.phase === PHASES.AWAITING_COUNTER && state.pendingAction) {
    return counterPrompt(state, map)
  }
  if (state.phase === PHASES.AWAITING_AUCTION && state.pendingAuction) {
    return auctionPrompt(state, map)
  }

  // 掷出对子时轮次不换人，没有 turn_started，只有「再掷一次」这一个事件。
  // 出不出图都要念出来并艾特本人，否则玩家只看到棋盘角落一行小字，不知道该自己接着掷
  const event = events.findLast(
    (item) =>
      item.type === "turn_started" || item.type === "extra_roll_awarded"
  )
  const lines = []
  if (event?.type === "extra_roll_awarded") {
    // 这一帧已经播报过这次掷骰的，别把「掷出对子」再说第二遍
    const announced = events.some(
      (item) => item.type === "dice_rolled" && item.playerId === event.playerId
    )
    lines.push(
      announced
        ? "对子加掷 · 再发送【r】掷一次。"
        : `${nameOf(state, event.playerId)}掷出对子，再发送【r】掷一次。`
    )
  } else if (event) {
    lines.push(
      event.jailTurns > 0
        ? jailTurnLine(state, map, event)
        : `轮到${nameOf(state, event.playerId)}，资产操作完成后发送【r】掷骰。`
    )
  } else if (owesExtraRoll(state)) {
    lines.push("对子加掷还没用掉，发送【r】再掷一次。")
  } else if (
    // 保释、用保释令出狱这一帧不换人也没有回合事件，
    // 不接一句就没人告诉他「出来了，可以掷了」
    state.phase === PHASES.AWAITING_ROLL &&
    events.some(
      (item) =>
        item.type === "jail_released" &&
        item.playerId === currentPlayer(state)?.userId
    )
  ) {
    lines.push("已出狱，发送【r】掷骰。")
  }
  if (lines.length === 0) return null
  return {
    mentionUserId: event?.playerId || currentPlayer(state)?.userId,
    text: lines.join("\n"),
  }
}

// 全场播报 → 花销回执 → 掷骰回执 → 下一步提示。
// 各自的收信人不同（全场 / 操作者 / 掷骰者 / 接棒者），相邻两条撞上同一个人才合并，
// 免得同一个人被连 @ 两次
export function buildTurnMessages(result, map = null) {
  const messages = []
  for (const message of [
    buildPublicNotice(result, map),
    ...buildActionReceipts(result, map),
    buildRollSummary(result, map),
    buildTurnPrompt(result, map),
  ]) {
    if (!message) continue
    const previous = messages.at(-1)
    if (previous && previous.mentionUserId === message.mentionUserId) {
      previous.text = `${previous.text}\n${message.text}`
      continue
    }
    messages.push(message)
  }
  return messages
}
