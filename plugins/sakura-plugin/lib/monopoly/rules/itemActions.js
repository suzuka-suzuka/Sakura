import {
  PLAYER_STATUS,
  insufficientCash,
  ruleError,
} from "../constants.js"
import {
  buyOutProperty,
  demolishBuilding,
  redemptionCost,
} from "./assets.js"
import { minimumBid, openAuction } from "./auction.js"
import { hotelLevel, housesPerHotel } from "./buildings.js"
import { propertyKind } from "./property.js"
import { processPaymentQueue } from "./settlement.js"
import {
  ownedPropertyEntries,
  playerById,
  tileById,
} from "./state.js"
import { netWorthOf } from "./victory.js"

export const NEGATE_ITEM = "negate"

function requireActiveOpponent(state, actorId, targetId) {
  const target = playerById(state, targetId)
  if (!target || target.userId === String(actorId)) {
    ruleError("INVALID_ITEM_TARGET", "目标玩家无效。")
  }
  if (target.status !== PLAYER_STATUS.ACTIVE) {
    ruleError("INVALID_ITEM_TARGET", "目标玩家已经退出本局。")
  }
  return target
}

function requireOwnedTile(state, map, tileId, ownerId, label) {
  const tile = tileById(map, tileId)
  const propertyState = state.propertyStates[String(tileId)]
  if (!tile || tile.type !== "property" || !propertyState) {
    ruleError("INVALID_PROPERTY", `${label}不是一块地产。`)
  }
  if (propertyState.ownerId !== String(ownerId)) {
    ruleError("INVALID_ITEM_TARGET", `${tile.name}不属于${label}。`)
  }
  if (propertyState.level > 0) {
    ruleError("PROPERTY_HAS_BUILDINGS", `${tile.name}上有建筑，不能作为目标。`)
  }
  return { tile, propertyState }
}

function transferInterest(map, tile, propertyState) {
  if (!propertyState.mortgaged) return 0
  return redemptionCost(map, tile) - tile.mortgageValue
}

// 强制征收和强制收购共用的目标校验：别人的、没建筑的地产
function requirePurchasableTarget(state, map, actor, targetTileId) {
  const tile = tileById(map, targetTileId)
  const propertyState = state.propertyStates[String(targetTileId)]
  if (!tile || tile.type !== "property" || !propertyState) {
    ruleError("INVALID_PROPERTY", "目标不是一块地产。")
  }
  if (propertyState.ownerId === null) {
    ruleError("INVALID_ITEM_TARGET", `${tile.name}还没有主人。`)
  }
  const victim = requireActiveOpponent(
    state,
    actor.userId,
    propertyState.ownerId
  )
  requireOwnedTile(state, map, targetTileId, victim.userId, victim.userId)
  return { tile, propertyState, victim }
}

// 买下这块地之后是不是就凑齐了整个色组
function completesGroupFor(state, map, playerId, tile) {
  const group = map.propertyGroups.find((item) => item.id === tile.groupId)
  if (!group) return false
  const wanted = String(playerId)
  return group.tileIds.every(
    (tileId) =>
      tileId === tile.id ||
      state.propertyStates[String(tileId)]?.ownerId === wanted
  )
}

function applyBuyOut(state, map, actor, args, events, reason) {
  const propertyState = state.propertyStates[String(args.targetTileId)]
  // 等待否决期间盘面可能已经变了，兜一层
  if (
    !propertyState ||
    propertyState.ownerId !== args.victimId ||
    propertyState.level > 0 ||
    actor.cash < args.price
  ) {
    events.push({
      type: "item_fizzled",
      playerId: actor.userId,
      itemId: reason === "seize" ? "seize_property" : "force_buy",
      tileId: args.targetTileId,
    })
    return
  }
  buyOutProperty(state, map, {
    buyerId: actor.userId,
    tileId: args.targetTileId,
    amount: args.price,
    events,
    reason,
  })
}

function moveOwnership(state, map, tile, propertyState, toPlayer, events, reason) {
  const interest = transferInterest(map, tile, propertyState)
  propertyState.ownerId = toPlayer.userId
  if (interest > 0) toPlayer.cash -= interest
  events.push({
    type: "property_handed_over",
    tileId: tile.id,
    recipientId: toPlayer.userId,
    mortgaged: propertyState.mortgaged,
    interest,
    reason,
  })
  return interest
}

export const ITEM_ACTIONS = Object.freeze({
  swap_property: {
    argSpec: ["tile", "tile"],
    counterable: true,
    // 换地：自己那块不能是抵押的，对方那块可以；两块都不能有建筑
    prepare(state, map, actor, [ownTileId, targetTileId]) {
      const own = requireOwnedTile(state, map, ownTileId, actor.userId, "你")
      if (own.propertyState.mortgaged) {
        ruleError(
          "OWN_TILE_MORTGAGED",
          `${own.tile.name}正在抵押中，不能拿它去交换。`
        )
      }
      const targetState = state.propertyStates[String(targetTileId)]
      const targetTile = tileById(map, targetTileId)
      if (!targetTile || targetTile.type !== "property" || !targetState) {
        ruleError("INVALID_PROPERTY", "目标不是一块地产。")
      }
      if (targetState.ownerId === null) {
        ruleError("INVALID_ITEM_TARGET", `${targetTile.name}还没有主人。`)
      }
      const victim = requireActiveOpponent(state, actor.userId, targetState.ownerId)
      requireOwnedTile(state, map, targetTileId, victim.userId, victim.userId)

      const interest = transferInterest(map, targetTile, targetState)
      if (actor.cash < interest) {
        insufficientCash("接手抵押地的过户利息", interest, actor.cash)
      }
      return {
        victimId: victim.userId,
        args: { ownTileId: own.tile.id, targetTileId: targetTile.id },
      }
    },
    apply(state, map, actor, args, runtime, events) {
      const victim = playerById(state, args.victimId)
      const ownTile = tileById(map, args.ownTileId)
      const targetTile = tileById(map, args.targetTileId)
      const ownState = state.propertyStates[String(args.ownTileId)]
      const targetState = state.propertyStates[String(args.targetTileId)]
      moveOwnership(state, map, ownTile, ownState, victim, events, "swap")
      moveOwnership(state, map, targetTile, targetState, actor, events, "swap")
      events.push({
        type: "property_swapped",
        playerId: actor.userId,
        recipientId: victim.userId,
        givenTileId: ownTile.id,
        takenTileId: targetTile.id,
      })
    },
    describe(map, args) {
      return `${tileById(map, args.ownTileId)?.name} ⇄ ${tileById(map, args.targetTileId)?.name}`
    },
  },

  seize_property: {
    argSpec: ["tile"],
    counterable: true,
    // 强制征收：按全额售价强买一块没有建筑的地，是常驻强制收购的原价特权版
    prepare(state, map, actor, [targetTileId]) {
      const { tile, victim } = requirePurchasableTarget(
        state,
        map,
        actor,
        targetTileId
      )
      if (actor.cash < tile.price) {
        insufficientCash(`征收${tile.name}`, tile.price, actor.cash)
      }
      return {
        victimId: victim.userId,
        args: { targetTileId: tile.id, price: tile.price },
      }
    },
    apply(state, map, actor, args, runtime, events) {
      applyBuyOut(state, map, actor, args, events, "seize")
    },
    describe(map, args) {
      return `${tileById(map, args.targetTileId)?.name} · ${args.price}`
    },
  },

  force_buy: {
    argSpec: ["tile"],
    counterable: true,
    // 强制收购：双倍标价买下能让自己凑成完整色组的一块无建筑地，整局次数有限
    prepare(state, map, actor, [targetTileId]) {
      // 次数先查：用完了就别再纠结目标对不对
      const limit = map.gameDefaults.forceBuyLimit
      if ((actor.forceBuysUsed ?? 0) >= limit) {
        ruleError(
          "FORCE_BUY_EXHAUSTED",
          `强制收购每局只能用 ${limit} 次，你已经用完了。`
        )
      }
      const { tile, victim } = requirePurchasableTarget(
        state,
        map,
        actor,
        targetTileId
      )
      if (!completesGroupFor(state, map, actor.userId, tile)) {
        ruleError(
          "NOT_GROUP_KEY",
          `买下${tile.name}并不能让你凑成完整色组，强制收购只认关键地。`
        )
      }
      const price = tile.price * map.gameDefaults.forceBuyPriceRate
      if (actor.cash < price) {
        insufficientCash(`收购${tile.name}`, price, actor.cash)
      }
      return {
        victimId: victim.userId,
        args: { targetTileId: tile.id, price },
      }
    },
    apply(state, map, actor, args, runtime, events) {
      applyBuyOut(state, map, actor, args, events, "force_buy")
    },
    describe(map, args) {
      return `${tileById(map, args.targetTileId)?.name} · ${args.price}`
    },
  },

  demolish: {
    argSpec: ["player"],
    counterable: true,
    // 拆迁令：只指定玩家，目标房产在使用时就随机选定，让被打的人看得见自己要挨哪一刀。
    // 建筑直接推平，地主拿不到任何补偿
    prepare(state, map, actor, [targetUserId], runtime) {
      const victim = requireActiveOpponent(state, actor.userId, targetUserId)

      const owned = ownedPropertyEntries(state, map, victim.userId).filter(
        ({ tile, propertyState }) =>
          propertyKind(tile) === "street" && propertyState.level > 0
      )
      if (owned.length === 0) {
        ruleError("NO_BUILDING", "对方名下没有任何建筑。")
      }
      const topLevel = Math.max(
        ...owned.map(({ propertyState }) => propertyState.level)
      )
      const candidates = owned
        .filter(({ propertyState }) => propertyState.level === topLevel)
        // 拆旅馆要银行拿得出 4 间房，拿不出的先排除
        .filter(
          () =>
            topLevel !== hotelLevel(map) ||
            state.buildingSupply.houses >= housesPerHotel(map)
        )
        .sort((left, right) => left.tile.id - right.tile.id)
      if (candidates.length === 0) {
        ruleError(
          "HOUSE_SUPPLY_EXHAUSTED",
          "银行房屋不足，暂时拆不动对方的旅馆。"
        )
      }
      const pick = Number.isSafeInteger(runtime?.itemPick)
        ? runtime.itemPick % candidates.length
        : 0
      const chosen = candidates[pick]
      return {
        victimId: victim.userId,
        args: { tileId: chosen.tile.id },
      }
    },
    apply(state, map, actor, args, runtime, events) {
      const propertyState = state.propertyStates[String(args.tileId)]
      // 目标可能在等待否决期间已经变化，兜一层
      if (!propertyState || propertyState.ownerId !== args.victimId) {
        events.push({
          type: "item_fizzled",
          playerId: actor.userId,
          itemId: "demolish",
          tileId: args.tileId,
        })
        return
      }
      const removed = demolishBuilding(
        state,
        map,
        args.victimId,
        args.tileId
      )
      events.push({
        type: "building_demolished",
        playerId: actor.userId,
        recipientId: args.victimId,
        tileId: args.tileId,
        previousBuilding: removed.previousBuilding,
        building: removed.building,
        buildingSupply: { ...state.buildingSupply },
      })
    },
    describe(map, args) {
      return `${tileById(map, args.tileId)?.name}`
    },
  },

  auction: {
    argSpec: ["tile"],
    counterable: true,
    // 拍卖令：把任意一块没有建筑的地挂上暗拍，谁的地都行，包括自己的和无主的
    prepare(state, map, actor, [targetTileId]) {
      const tile = tileById(map, targetTileId)
      const propertyState = state.propertyStates[String(targetTileId)]
      if (!tile || tile.type !== "property" || !propertyState) {
        ruleError("INVALID_PROPERTY", "目标不是一块地产。")
      }
      if (propertyState.level > 0) {
        ruleError("PROPERTY_HAS_BUILDINGS", `${tile.name}上有建筑，不能拍卖。`)
      }
      // 地是别人的才有人可以否决；无主地和自己的地直接开拍
      const ownerId = propertyState.ownerId
      const victim =
        ownerId && ownerId !== actor.userId
          ? requireActiveOpponent(state, actor.userId, ownerId)
          : null
      return {
        victimId: victim?.userId ?? null,
        args: { tileId: tile.id, minimumBid: minimumBid(map, tile) },
      }
    },
    apply(state, map, actor, args, runtime, events) {
      const propertyState = state.propertyStates[String(args.tileId)]
      // 等待否决期间地上可能已经盖了房，兜一层
      if (!propertyState || propertyState.level > 0) {
        events.push({
          type: "item_fizzled",
          playerId: actor.userId,
          itemId: "auction",
          tileId: args.tileId,
        })
        return
      }
      openAuction(state, map, {
        tileId: args.tileId,
        initiatorId: actor.userId,
        now: runtime.now,
        events,
      })
    },
    describe(map, args) {
      return `${tileById(map, args.tileId)?.name} · 底价 ${args.minimumBid}`
    },
  },

  tax_audit: {
    argSpec: ["player"],
    counterable: true,
    // 税务稽查：目标按净资产的一成向银行补税，钱不进使用者口袋
    prepare(state, map, actor, [targetUserId]) {
      const victim = requireActiveOpponent(state, actor.userId, targetUserId)
      const amount = Math.floor(
        netWorthOf(state, map, victim.userId) *
          map.gameDefaults.taxAuditRate
      )
      if (amount <= 0) {
        ruleError("NOTHING_TO_AUDIT", "对方没有可以补税的资产。")
      }
      return { victimId: victim.userId, args: { amount } }
    },
    apply(state, map, actor, args, runtime, events) {
      const victim = playerById(state, args.victimId)
      if (!victim || victim.status !== PLAYER_STATUS.ACTIVE) {
        events.push({
          type: "item_fizzled",
          playerId: actor.userId,
          itemId: "tax_audit",
        })
        return
      }
      // 税额在打出时就已锁定，等待否决期间对方的资产变化不再重算
      processPaymentQueue(
        state,
        map,
        [
          {
            payerId: victim.userId,
            amount: args.amount,
            reason: "tax_audit",
          },
        ],
        events,
        { now: runtime.now }
      )
    },
    describe(map, args) {
      return `补税 ${args.amount}`
    },
  },
})

export function itemAction(itemId) {
  return ITEM_ACTIONS[String(itemId)] || null
}
