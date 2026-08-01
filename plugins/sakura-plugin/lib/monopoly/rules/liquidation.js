import {
  hotelLevel,
  housesPerHotel,
} from "./buildings.js"
import {
  mortgageProperty,
  sellBuilding,
} from "./assets.js"
import {
  propertyKind,
  rentFor,
} from "./property.js"
import {
  ownedPropertyEntries,
  playerById,
} from "./state.js"

// 强制结算时的自动变现顺序：
// 抵押拿走售价一半、地产估值也正好掉一半，净资产不变；拆房只退一半造价，净资产实打实少一半。
// 所以先抵押所有没有建筑的地，实在不够才动建筑；同类里按「每换一块钱要损失多少租金」从小到大挑。

function groupOf(map, tile) {
  return map.propertyGroups.find((group) => group.id === tile.groupId) || null
}

function groupLevels(state, map, tile) {
  const group = groupOf(map, tile)
  if (!group) return []
  return group.tileIds.map(
    (tileId) => state.propertyStates[String(tileId)].level
  )
}

function mortgageCandidates(state, map, playerId) {
  return ownedPropertyEntries(state, map, playerId)
    .filter(({ tile, propertyState }) => {
      if (propertyState.mortgaged) return false
      // 街区抵押要求整个色组都没有建筑，车站和公共设施随时可押
      if (propertyKind(tile) !== "street") return true
      return groupLevels(state, map, tile).every((level) => level === 0)
    })
    .map(({ tile }) => ({
      tileId: tile.id,
      cash: tile.mortgageValue,
      rentLoss: rentFor(state, map, tile),
    }))
}

function buildingCandidates(state, map, playerId) {
  const candidates = []
  for (const { tile, propertyState } of ownedPropertyEntries(
    state,
    map,
    playerId
  )) {
    if (propertyKind(tile) !== "street" || propertyState.level <= 0) continue
    // 只能从组内等级最高的那块拆
    if (propertyState.level !== Math.max(...groupLevels(state, map, tile))) {
      continue
    }
    // 旅馆降级要银行拿得出 4 间房，拿不出就跳过这块
    if (
      propertyState.level === hotelLevel(map) &&
      state.buildingSupply.houses < housesPerHotel(map)
    ) {
      continue
    }
    candidates.push({
      tileId: tile.id,
      cash: Math.floor(
        tile.upgradeCost * map.gameDefaults.buildingSaleRate
      ),
      rentLoss:
        tile.rentByLevel[propertyState.level] -
        tile.rentByLevel[propertyState.level - 1],
    })
  }
  return candidates
}

function cheapest(candidates) {
  return (
    candidates
      .filter((item) => item.cash > 0)
      .sort(
        (left, right) =>
          left.rentLoss / left.cash - right.rentLoss / right.cash ||
          left.cash - right.cash ||
          left.tileId - right.tileId
      )[0] || null
  )
}

export function autoLiquidate(state, map, playerId, targetAmount, events) {
  const player = playerById(state, playerId)
  const summary = { mortgaged: 0, sold: 0, amount: 0, covered: false }
  if (!player) return summary

  // 逐笔事件不进通知栏，最后只汇总成一条，免得把其它提示挤掉
  const details = []
  const limit = map.tiles.length * 6
  for (let step = 0; step < limit && player.cash < targetAmount; step++) {
    const mortgage = cheapest(mortgageCandidates(state, map, playerId))
    if (mortgage) {
      mortgageProperty(state, map, playerId, mortgage.tileId, details)
      summary.mortgaged += 1
      summary.amount += mortgage.cash
      continue
    }
    const building = cheapest(buildingCandidates(state, map, playerId))
    if (!building) break
    sellBuilding(state, map, playerId, building.tileId, details)
    summary.sold += 1
    summary.amount += building.cash
  }

  summary.covered = player.cash >= targetAmount
  if (summary.mortgaged > 0 || summary.sold > 0) {
    events.push({
      type: "auto_liquidated",
      playerId: player.userId,
      mortgaged: summary.mortgaged,
      sold: summary.sold,
      amount: summary.amount,
      covered: summary.covered,
    })
  }
  return summary
}
