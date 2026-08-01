import { PLAYER_STATUS, ruleError } from "../constants.js"
import { redemptionCost, sellBuilding } from "./assets.js"
import { hotelLevel, housesPerHotel } from "./buildings.js"
import { propertyKind } from "./property.js"
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

// 攻击类道具只能往上打：目标净资产必须高于自己，避免变成欺负落后玩家的工具
function requireRicherTarget(state, map, actorId, targetId) {
  const actorWorth = netWorthOf(state, map, actorId)
  const targetWorth = netWorthOf(state, map, targetId)
  if (targetWorth <= actorWorth) {
    ruleError(
      "TARGET_NOT_RICHER",
      "只能对净资产比你高的玩家使用这张卡。"
    )
  }
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
      requireRicherTarget(state, map, actor.userId, victim.userId)

      const interest = transferInterest(map, targetTile, targetState)
      if (actor.cash < interest) {
        ruleError(
          "INSUFFICIENT_CASH",
          `接手抵押地需要先付 ${interest} 过户利息。`
        )
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
    // 强制征收：按全额售价强买一块没有建筑的地
    prepare(state, map, actor, [targetTileId]) {
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
      requireRicherTarget(state, map, actor.userId, victim.userId)

      const interest = transferInterest(map, targetTile, targetState)
      if (actor.cash < targetTile.price + interest) {
        ruleError(
          "INSUFFICIENT_CASH",
          `征收${targetTile.name}需要 ${targetTile.price + interest}。`
        )
      }
      return {
        victimId: victim.userId,
        args: { targetTileId: targetTile.id, price: targetTile.price },
      }
    },
    apply(state, map, actor, args, runtime, events) {
      const victim = playerById(state, args.victimId)
      const tile = tileById(map, args.targetTileId)
      const propertyState = state.propertyStates[String(args.targetTileId)]
      actor.cash -= args.price
      victim.cash += args.price
      const interest = moveOwnership(
        state,
        map,
        tile,
        propertyState,
        actor,
        events,
        "seize"
      )
      events.push({
        type: "property_seized",
        playerId: actor.userId,
        recipientId: victim.userId,
        tileId: tile.id,
        amount: args.price,
        interest,
      })
    },
    describe(map, args) {
      return `${tileById(map, args.targetTileId)?.name} · ${args.price}`
    },
  },

  demolish: {
    argSpec: ["player"],
    counterable: true,
    // 拆迁令：只指定玩家，目标房产在使用时就随机选定，让被打的人看得见自己要挨哪一刀
    prepare(state, map, actor, [targetUserId], runtime) {
      const victim = requireActiveOpponent(state, actor.userId, targetUserId)
      requireRicherTarget(state, map, actor.userId, victim.userId)

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
        args: {
          tileId: chosen.tile.id,
          refund: Math.floor(
            chosen.tile.upgradeCost * map.gameDefaults.buildingSaleRate
          ),
        },
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
      const detail = []
      sellBuilding(state, map, args.victimId, args.tileId, detail)
      const sold = detail.find((event) => event.type === "building_sold")
      events.push({
        type: "building_demolished",
        playerId: actor.userId,
        recipientId: args.victimId,
        tileId: args.tileId,
        amount: sold?.amount ?? args.refund,
        building: sold?.building,
      })
    },
    describe(map, args) {
      return `${tileById(map, args.tileId)?.name}`
    },
  },
})

export function itemAction(itemId) {
  return ITEM_ACTIONS[String(itemId)] || null
}
