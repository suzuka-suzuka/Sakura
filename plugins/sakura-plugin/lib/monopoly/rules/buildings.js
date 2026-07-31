const DEFAULT_HOUSES_PER_HOTEL = 4
const DEFAULT_HOUSE_SUPPLY = 32
const DEFAULT_HOTEL_SUPPLY = 12

export function housesPerHotel(map) {
  return (
    map.gameDefaults.housesPerHotel ??
    DEFAULT_HOUSES_PER_HOTEL
  )
}

export function hotelLevel(map) {
  return housesPerHotel(map) + 1
}

export function buildingStock(map) {
  return {
    houses: map.gameDefaults.houseSupply ?? DEFAULT_HOUSE_SUPPLY,
    hotels: map.gameDefaults.hotelSupply ?? DEFAULT_HOTEL_SUPPLY,
  }
}

export function createBuildingSupply(map) {
  return { ...buildingStock(map) }
}

export function buildingCountsForLevel(map, level) {
  if (level === hotelLevel(map)) {
    return { houses: 0, hotels: 1 }
  }
  return {
    houses: Math.max(0, Math.min(housesPerHotel(map), level)),
    hotels: 0,
  }
}

export function buildingLabel(map, level) {
  if (level === hotelLevel(map)) return "旅馆"
  if (level > 0) return `${level} 间房`
  return "空地"
}

export function returnBuildingsToBank(state, map, level) {
  const returned = buildingCountsForLevel(map, level)
  state.buildingSupply.houses += returned.houses
  state.buildingSupply.hotels += returned.hotels
  return returned
}
