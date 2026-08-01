const ROOT_FIELDS = new Set([
  "schemaVersion",
  "id",
  "version",
  "name",
  "description",
  "ruleset",
  "gameDefaults",
  "board",
  "propertyGroups",
  "tiles",
  "chanceDecks",
  "items",
])

const GAME_DEFAULT_FIELDS = new Set([
  "minPlayers",
  "maxPlayers",
  "startingCash",
  "diceSides",
  "diceCount",
  "maxConsecutiveDoubles",
  "rollTimeoutSeconds",
  "decisionTimeoutSeconds",
  "debtTimeoutSeconds",
  "counterTimeoutSeconds",
  "maxConsecutiveRollTimeouts",
  "lobbyTimeoutSeconds",
  "passStartReward",
  "maxPropertyLevel",
  "housesPerHotel",
  "houseSupply",
  "hotelSupply",
  "completeSetRentMultiplier",
  "buildingSaleRate",
  "mortgageInterestRate",
  "jailSkipTurns",
  "maxTileResolutionDepth",
])

const BOARD_FIELDS = new Set([
  "size",
  "startTileId",
  "jailTileId",
  "path",
  "layout",
])

const LAYOUT_FIELDS = new Set([
  "type",
  "columns",
  "rows",
  "clockwise",
])

const GROUP_FIELDS = new Set(["id", "name", "color", "tileIds"])
const CARD_FIELDS = new Set(["id", "name", "description", "effect", "count"])
const DECK_FIELDS = new Set(["id", "name", "cards"])
const ITEM_FIELDS = new Set(["id", "name", "description", "maxHeld"])
const MAX_DECKS = 4
const BASE_TILE_FIELDS = [
  "id",
  "type",
  "name",
  "description",
  "position",
]

const TILE_FIELDS = Object.freeze({
  start: new Set(BASE_TILE_FIELDS),
  property: new Set([
    ...BASE_TILE_FIELDS,
    "propertyKind",
    "groupId",
    "price",
    "mortgageValue",
    "upgradeCost",
    "rentByLevel",
    "rentByOwnedCount",
    "rentDiceMultipliers",
  ]),
  chance: new Set([...BASE_TILE_FIELDS, "deckId"]),
  tax: new Set([...BASE_TILE_FIELDS, "amount"]),
  bonus: new Set([...BASE_TILE_FIELDS, "amount"]),
  jail: new Set(BASE_TILE_FIELDS),
  go_to_jail: new Set([
    ...BASE_TILE_FIELDS,
    "targetTileId",
  ]),
  rest: new Set(BASE_TILE_FIELDS),
})

const EFFECT_FIELDS = Object.freeze({
  cash: new Set(["type", "amount"]),
  move_by: new Set([
    "type",
    "steps",
    "collectStartReward",
    "resolveDestination",
  ]),
  move_to: new Set([
    "type",
    "targetTileId",
    "collectStartReward",
    "resolveDestination",
  ]),
  move_to_nearest: new Set([
    "type",
    "propertyKind",
    "rentMultiplier",
    "collectStartReward",
    "resolveDestination",
  ]),
  send_to_jail: new Set(["type", "targetTileId"]),
  transfer_each: new Set(["type", "direction", "amount"]),
  repairs: new Set(["type", "perHouse", "perHotel"]),
  grant_item: new Set(["type", "itemId"]),
})

export class MapValidationError extends Error {
  constructor(errors) {
    super(`大富翁地图校验失败：\n- ${errors.join("\n- ")}`)
    this.name = "MapValidationError"
    this.code = "MONOPOLY_MAP_INVALID"
    this.errors = errors
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function collectUnknownFields(value, allowed, label, errors) {
  if (!isPlainObject(value)) return
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label} 含未知字段 ${key}`)
  }
}

function requireObject(value, label, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${label} 必须是对象`)
    return false
  }
  return true
}

function requireArray(value, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} 必须是数组`)
    return false
  }
  return true
}

function requireString(value, label, errors, { pattern, maxLength = 80 } = {}) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    errors.push(`${label} 必须是 1～${maxLength} 个字符的字符串`)
    return false
  }
  if (pattern && !pattern.test(value)) {
    errors.push(`${label} 格式不正确`)
    return false
  }
  return true
}

function requireInteger(
  value,
  label,
  errors,
  { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}
) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    errors.push(`${label} 必须是 ${min}～${max} 的整数`)
    return false
  }
  return true
}

function requireNumber(
  value,
  label,
  errors,
  { min = -Infinity, max = Infinity } = {}
) {
  if (!Number.isFinite(value) || value < min || value > max) {
    errors.push(`${label} 必须是 ${min}～${max} 的数字`)
    return false
  }
  return true
}

function requireBoolean(value, label, errors) {
  if (typeof value !== "boolean") {
    errors.push(`${label} 必须是布尔值`)
    return false
  }
  return true
}

function duplicates(values) {
  const seen = new Set()
  const result = new Set()
  for (const value of values) {
    if (seen.has(value)) result.add(value)
    seen.add(value)
  }
  return [...result]
}

function sameMembers(left, right) {
  if (left.length !== right.length) return false
  const wanted = new Set(right)
  return left.every((value) => wanted.has(value))
}

function validateDefaults(defaults, errors) {
  if (!requireObject(defaults, "gameDefaults", errors)) return
  collectUnknownFields(defaults, GAME_DEFAULT_FIELDS, "gameDefaults", errors)

  requireInteger(defaults.minPlayers, "minPlayers", errors, { min: 2, max: 6 })
  requireInteger(defaults.maxPlayers, "maxPlayers", errors, { min: 2, max: 6 })
  if (
    Number.isInteger(defaults.minPlayers) &&
    Number.isInteger(defaults.maxPlayers) &&
    defaults.minPlayers > defaults.maxPlayers
  ) {
    errors.push("minPlayers 不能大于 maxPlayers")
  }

  requireInteger(defaults.startingCash, "startingCash", errors, {
    min: 100,
    max: 1_000_000,
  })
  requireInteger(defaults.diceSides, "diceSides", errors, { min: 2, max: 20 })
  requireInteger(defaults.diceCount, "diceCount", errors, { min: 2, max: 4 })
  requireInteger(
    defaults.maxConsecutiveDoubles,
    "maxConsecutiveDoubles",
    errors,
    { min: 2, max: 6 }
  )
  requireInteger(defaults.rollTimeoutSeconds, "rollTimeoutSeconds", errors, {
    min: 10,
    max: 600,
  })
  requireInteger(
    defaults.decisionTimeoutSeconds,
    "decisionTimeoutSeconds",
    errors,
    { min: 5, max: 300 }
  )
  requireInteger(
    defaults.debtTimeoutSeconds,
    "debtTimeoutSeconds",
    errors,
    { min: 10, max: 600 }
  )
  requireInteger(
    defaults.counterTimeoutSeconds,
    "counterTimeoutSeconds",
    errors,
    { min: 5, max: 120 }
  )
  requireInteger(
    defaults.maxConsecutiveRollTimeouts,
    "maxConsecutiveRollTimeouts",
    errors,
    { min: 1, max: 10 }
  )
  requireInteger(defaults.lobbyTimeoutSeconds, "lobbyTimeoutSeconds", errors, {
    min: 60,
    max: 86_400,
  })
  requireInteger(defaults.passStartReward, "passStartReward", errors, {
    min: 0,
    max: 1_000_000,
  })
  requireInteger(defaults.maxPropertyLevel, "maxPropertyLevel", errors, {
    min: 0,
    max: 10,
  })
  const buildingFields = [
    "housesPerHotel",
    "houseSupply",
    "hotelSupply",
  ]
  const configuredBuildingFields = buildingFields.filter((field) =>
    Object.hasOwn(defaults, field)
  )
  if (
    configuredBuildingFields.length > 0 &&
    configuredBuildingFields.length !== buildingFields.length
  ) {
    errors.push("房屋库存配置必须同时提供 housesPerHotel、houseSupply 和 hotelSupply")
  }
  if (Object.hasOwn(defaults, "housesPerHotel")) {
    requireInteger(defaults.housesPerHotel, "housesPerHotel", errors, {
      min: 1,
      max: 8,
    })
  }
  if (Object.hasOwn(defaults, "houseSupply")) {
    requireInteger(defaults.houseSupply, "houseSupply", errors, {
      min: 1,
      max: 500,
    })
  }
  if (Object.hasOwn(defaults, "hotelSupply")) {
    requireInteger(defaults.hotelSupply, "hotelSupply", errors, {
      min: 1,
      max: 100,
    })
  }
  if (
    Number.isInteger(defaults.housesPerHotel) &&
    Number.isInteger(defaults.maxPropertyLevel) &&
    defaults.maxPropertyLevel !== defaults.housesPerHotel + 1
  ) {
    errors.push("maxPropertyLevel 必须等于 housesPerHotel + 1")
  }
  requireNumber(
    defaults.completeSetRentMultiplier,
    "completeSetRentMultiplier",
    errors,
    { min: 1, max: 10 }
  )
  requireNumber(defaults.buildingSaleRate, "buildingSaleRate", errors, {
    min: 0.01,
    max: 1,
  })
  requireNumber(
    defaults.mortgageInterestRate,
    "mortgageInterestRate",
    errors,
    { min: 0, max: 1 }
  )
  requireInteger(defaults.jailSkipTurns, "jailSkipTurns", errors, {
    min: 1,
    max: 10,
  })
  requireInteger(
    defaults.maxTileResolutionDepth,
    "maxTileResolutionDepth",
    errors,
    { min: 1, max: 20 }
  )
}

function validateBoard(board, errors) {
  if (!requireObject(board, "board", errors)) return
  collectUnknownFields(board, BOARD_FIELDS, "board", errors)

  requireInteger(board.size, "board.size", errors, { min: 4, max: 200 })
  requireInteger(board.startTileId, "board.startTileId", errors)
  requireInteger(board.jailTileId, "board.jailTileId", errors)
  requireArray(board.path, "board.path", errors)

  if (!requireObject(board.layout, "board.layout", errors)) return
  collectUnknownFields(board.layout, LAYOUT_FIELDS, "board.layout", errors)
  if (board.layout.type !== "perimeter_grid") {
    errors.push("board.layout.type 目前只支持 perimeter_grid")
  }
  requireInteger(board.layout.columns, "board.layout.columns", errors, {
    min: 3,
    max: 30,
  })
  requireInteger(board.layout.rows, "board.layout.rows", errors, {
    min: 3,
    max: 30,
  })
  requireBoolean(board.layout.clockwise, "board.layout.clockwise", errors)
  if (
    Number.isInteger(board.size) &&
    Number.isInteger(board.layout.columns) &&
    Number.isInteger(board.layout.rows)
  ) {
    const perimeterSize =
      board.layout.columns * 2 + board.layout.rows * 2 - 4
    if (board.size !== perimeterSize) {
      errors.push("board.size 必须等于外圈布局的格子数量")
    }
  }
  if (board.layout.clockwise !== true) {
    errors.push("MVP 棋盘路径必须按顺时针布局")
  }
}

function validateTileShape(tile, index, defaults, errors) {
  const label = `tiles[${index}]`
  if (!requireObject(tile, label, errors)) return
  if (!TILE_FIELDS[tile.type]) {
    errors.push(`${label}.type 不受支持：${String(tile.type)}`)
    return
  }
  collectUnknownFields(tile, TILE_FIELDS[tile.type], label, errors)
  requireInteger(tile.id, `${label}.id`, errors, { min: 0, max: 10_000 })
  requireString(tile.name, `${label}.name`, errors, { maxLength: 30 })
  if (
    typeof tile.name === "string" &&
    Array.from(tile.name).length > 4
  ) {
    errors.push(`${label}.name 最多只能有 4 个字符`)
  }
  requireString(tile.description, `${label}.description`, errors, {
    maxLength: 120,
  })
  if (requireObject(tile.position, `${label}.position`, errors)) {
    collectUnknownFields(
      tile.position,
      new Set(["x", "y"]),
      `${label}.position`,
      errors
    )
    requireInteger(tile.position.x, `${label}.position.x`, errors, {
      min: 0,
      max: 100,
    })
    requireInteger(tile.position.y, `${label}.position.y`, errors, {
      min: 0,
      max: 100,
    })
  }

  if (tile.type === "property") {
    const propertyKind = tile.propertyKind || "street"
    if (!["street", "station", "utility"].includes(propertyKind)) {
      errors.push(
        `${label}.propertyKind 只能是 street、station 或 utility`
      )
    }
    requireString(tile.groupId, `${label}.groupId`, errors, {
      pattern: /^[a-z][a-z0-9_]*$/,
    })
    requireInteger(tile.price, `${label}.price`, errors, {
      min: 1,
      max: 1_000_000,
    })
    requireInteger(tile.mortgageValue, `${label}.mortgageValue`, errors, {
      min: 1,
      max: 1_000_000,
    })
    if (propertyKind === "street") {
      requireInteger(tile.upgradeCost, `${label}.upgradeCost`, errors, {
        min: 1,
        max: 1_000_000,
      })
      if (requireArray(tile.rentByLevel, `${label}.rentByLevel`, errors)) {
        if (tile.rentByLevel.length !== defaults.maxPropertyLevel + 1) {
          errors.push(
            `${label}.rentByLevel 长度必须等于 maxPropertyLevel + 1`
          )
        }
        for (const [rentIndex, rent] of tile.rentByLevel.entries()) {
          requireInteger(rent, `${label}.rentByLevel[${rentIndex}]`, errors, {
            min: 0,
            max: 10_000_000,
          })
        }
      }
    } else if (propertyKind === "station") {
      if (
        requireArray(
          tile.rentByOwnedCount,
          `${label}.rentByOwnedCount`,
          errors
        )
      ) {
        if (tile.rentByOwnedCount.length !== 4) {
          errors.push(`${label}.rentByOwnedCount 必须包含 4 档租金`)
        }
        for (const [rentIndex, rent] of tile.rentByOwnedCount.entries()) {
          requireInteger(
            rent,
            `${label}.rentByOwnedCount[${rentIndex}]`,
            errors,
            {
              min: 0,
              max: 10_000_000,
            }
          )
        }
      }
    } else if (propertyKind === "utility") {
      if (
        requireArray(
          tile.rentDiceMultipliers,
          `${label}.rentDiceMultipliers`,
          errors
        )
      ) {
        if (tile.rentDiceMultipliers.length !== 2) {
          errors.push(`${label}.rentDiceMultipliers 必须包含 2 档倍数`)
        }
        for (const [rentIndex, multiplier] of
          tile.rentDiceMultipliers.entries()) {
          requireInteger(
            multiplier,
            `${label}.rentDiceMultipliers[${rentIndex}]`,
            errors,
            {
              min: 1,
              max: 100_000,
            }
          )
        }
      }
    } else if (Array.isArray(tile.rentByLevel)) {
      for (const [rentIndex, rent] of tile.rentByLevel.entries()) {
        requireInteger(rent, `${label}.rentByLevel[${rentIndex}]`, errors, {
          min: 0,
          max: 10_000_000,
        })
      }
    }
  } else if (tile.type === "chance") {
    requireString(tile.deckId, `${label}.deckId`, errors, {
      pattern: /^[a-z][a-z0-9_]*$/,
    })
  } else if (tile.type === "tax" || tile.type === "bonus") {
    requireInteger(tile.amount, `${label}.amount`, errors, {
      min: 1,
      max: 1_000_000,
    })
  } else if (tile.type === "go_to_jail") {
    requireInteger(tile.targetTileId, `${label}.targetTileId`, errors)
  }
}

function validateEffect(effect, label, tileIds, errors, itemIds = new Set()) {
  if (!requireObject(effect, label, errors)) return
  const allowed = EFFECT_FIELDS[effect.type]
  if (!allowed) {
    errors.push(`${label}.type 不受支持：${String(effect.type)}`)
    return
  }
  collectUnknownFields(effect, allowed, label, errors)

  if (effect.type === "cash") {
    requireInteger(effect.amount, `${label}.amount`, errors, {
      min: -1_000_000,
      max: 1_000_000,
    })
    if (effect.amount === 0) errors.push(`${label}.amount 不能为 0`)
  } else if (effect.type === "move_by") {
    requireInteger(effect.steps, `${label}.steps`, errors, {
      min: -200,
      max: 200,
    })
    if (effect.steps === 0) errors.push(`${label}.steps 不能为 0`)
    requireBoolean(
      effect.collectStartReward,
      `${label}.collectStartReward`,
      errors
    )
    requireBoolean(
      effect.resolveDestination,
      `${label}.resolveDestination`,
      errors
    )
  } else if (effect.type === "move_to") {
    requireInteger(effect.targetTileId, `${label}.targetTileId`, errors)
    if (!tileIds.has(effect.targetTileId)) {
      errors.push(`${label}.targetTileId 指向不存在的格子`)
    }
    requireBoolean(
      effect.collectStartReward,
      `${label}.collectStartReward`,
      errors
    )
    requireBoolean(
      effect.resolveDestination,
      `${label}.resolveDestination`,
      errors
    )
  } else if (effect.type === "send_to_jail") {
    requireInteger(effect.targetTileId, `${label}.targetTileId`, errors)
    if (!tileIds.has(effect.targetTileId)) {
      errors.push(`${label}.targetTileId 指向不存在的格子`)
    }
  } else if (effect.type === "transfer_each") {
    if (!["from_others", "to_others"].includes(effect.direction)) {
      errors.push(`${label}.direction 只能是 from_others 或 to_others`)
    }
    requireInteger(effect.amount, `${label}.amount`, errors, {
      min: 1,
      max: 1_000_000,
    })
  } else if (effect.type === "move_to_nearest") {
    if (!["station", "utility"].includes(effect.propertyKind)) {
      errors.push(`${label}.propertyKind 只能是 station 或 utility`)
    }
    requireInteger(effect.rentMultiplier, `${label}.rentMultiplier`, errors, {
      min: 1,
      max: 10,
    })
    requireBoolean(
      effect.collectStartReward,
      `${label}.collectStartReward`,
      errors
    )
    requireBoolean(
      effect.resolveDestination,
      `${label}.resolveDestination`,
      errors
    )
  } else if (effect.type === "repairs") {
    requireInteger(effect.perHouse, `${label}.perHouse`, errors, {
      min: 0,
      max: 100_000,
    })
    requireInteger(effect.perHotel, `${label}.perHotel`, errors, {
      min: 0,
      max: 100_000,
    })
    if (effect.perHouse === 0 && effect.perHotel === 0) {
      errors.push(`${label} 的房屋与旅馆费用不能同时为 0`)
    }
  } else if (effect.type === "grant_item") {
    if (
      requireString(effect.itemId, `${label}.itemId`, errors, {
        pattern: /^[a-z][a-z0-9_]*$/,
      }) &&
      !itemIds.has(effect.itemId)
    ) {
      errors.push(`${label}.itemId 指向不存在的道具 ${effect.itemId}`)
    }
  }
}

function validateItems(map, errors) {
  const itemIds = new Set()
  if (map.items === undefined) return itemIds
  if (!requireArray(map.items, "items", errors)) return itemIds

  const seen = []
  for (const [index, item] of map.items.entries()) {
    const label = `items[${index}]`
    if (!requireObject(item, label, errors)) continue
    collectUnknownFields(item, ITEM_FIELDS, label, errors)
    if (
      requireString(item.id, `${label}.id`, errors, {
        pattern: /^[a-z][a-z0-9_]*$/,
      })
    ) {
      seen.push(item.id)
      itemIds.add(item.id)
    }
    requireString(item.name, `${label}.name`, errors, { maxLength: 20 })
    requireString(item.description, `${label}.description`, errors, {
      maxLength: 120,
    })
    requireInteger(item.maxHeld, `${label}.maxHeld`, errors, {
      min: 1,
      max: 9,
    })
  }
  for (const duplicate of duplicates(seen)) {
    errors.push(`道具 ID 重复：${duplicate}`)
  }
  return itemIds
}

function validateGroups(map, tileById, errors) {
  if (!requireArray(map.propertyGroups, "propertyGroups", errors)) return
  const groupIds = []
  const groupedTileIds = []

  for (const [index, group] of map.propertyGroups.entries()) {
    const label = `propertyGroups[${index}]`
    if (!requireObject(group, label, errors)) continue
    collectUnknownFields(group, GROUP_FIELDS, label, errors)
    if (
      requireString(group.id, `${label}.id`, errors, {
        pattern: /^[a-z][a-z0-9_]*$/,
      })
    ) {
      groupIds.push(group.id)
    }
    requireString(group.name, `${label}.name`, errors, { maxLength: 30 })
    requireString(group.color, `${label}.color`, errors, {
      pattern: /^#[0-9A-Fa-f]{6}$/,
      maxLength: 7,
    })
    if (!requireArray(group.tileIds, `${label}.tileIds`, errors)) continue
    if (group.tileIds.length < 2 || group.tileIds.length > 4) {
      errors.push(`${label}.tileIds 必须包含 2～4 块地产`)
    }
    for (const tileId of group.tileIds) {
      requireInteger(tileId, `${label}.tileIds`, errors)
      groupedTileIds.push(tileId)
      if (tileById.get(tileId)?.type !== "property") {
        errors.push(`${label} 引用了不存在或不是地产的格子 ${tileId}`)
      }
    }
    const propertyKinds = new Set(
      group.tileIds
        .map((tileId) => tileById.get(tileId))
        .filter((tile) => tile?.type === "property")
        .map((tile) => tile.propertyKind || "street")
    )
    if (propertyKinds.size > 1) {
      errors.push(`${label} 不能混合不同类型的地产`)
    }
    const [propertyKind] = propertyKinds
    if (propertyKind === "street" && ![2, 3].includes(group.tileIds.length)) {
      errors.push(`${label} 的街区必须包含 2 或 3 块地产`)
    }
    if (propertyKind === "station" && group.tileIds.length !== 4) {
      errors.push(`${label} 的车站组必须包含 4 块地产`)
    }
    if (propertyKind === "utility" && group.tileIds.length !== 2) {
      errors.push(`${label} 的公共设施组必须包含 2 块地产`)
    }
  }

  for (const duplicate of duplicates(groupIds)) {
    errors.push(`色组 ID 重复：${duplicate}`)
  }
  for (const duplicate of duplicates(groupedTileIds)) {
    errors.push(`地产 ${duplicate} 被多个色组引用`)
  }

  const propertyIds = map.tiles
    .filter((tile) => tile?.type === "property")
    .map((tile) => tile.id)
  if (!sameMembers(groupedTileIds, propertyIds)) {
    errors.push("色组必须完整且仅覆盖全部地产")
  }

  const groupById = new Map(
    map.propertyGroups
      .filter((group) => isPlainObject(group) && typeof group.id === "string")
      .map((group) => [group.id, group])
  )
  for (const tile of map.tiles.filter((item) => item?.type === "property")) {
    const group = groupById.get(tile.groupId)
    if (
      !group ||
      !Array.isArray(group.tileIds) ||
      !group.tileIds.includes(tile.id)
    ) {
      errors.push(`地产 ${tile.id} 的 groupId 与色组反向引用不一致`)
    }
  }
}

function validateDecks(map, tileById, itemIds, errors) {
  if (!requireArray(map.chanceDecks, "chanceDecks", errors)) return
  if (map.chanceDecks.length < 1 || map.chanceDecks.length > MAX_DECKS) {
    errors.push(`地图需要 1～${MAX_DECKS} 个牌堆`)
  }
  const deckIds = []

  for (const [deckIndex, deck] of map.chanceDecks.entries()) {
    const label = `chanceDecks[${deckIndex}]`
    if (!requireObject(deck, label, errors)) continue
    collectUnknownFields(deck, DECK_FIELDS, label, errors)
    if (
      requireString(deck.id, `${label}.id`, errors, {
        pattern: /^[a-z][a-z0-9_]*$/,
      })
    ) {
      deckIds.push(deck.id)
    }
    requireString(deck.name, `${label}.name`, errors, { maxLength: 30 })
    if (!requireArray(deck.cards, `${label}.cards`, errors)) continue
    if (deck.cards.length < 2) errors.push(`${label} 至少需要 2 张牌`)

    const cardIds = []
    for (const [cardIndex, card] of deck.cards.entries()) {
      const cardLabel = `${label}.cards[${cardIndex}]`
      if (!requireObject(card, cardLabel, errors)) continue
      collectUnknownFields(card, CARD_FIELDS, cardLabel, errors)
      if (
        requireString(card.id, `${cardLabel}.id`, errors, {
          pattern: /^[a-z][a-z0-9_]*$/,
        })
      ) {
        cardIds.push(card.id)
      }
      requireString(card.name, `${cardLabel}.name`, errors, { maxLength: 30 })
      requireString(card.description, `${cardLabel}.description`, errors, {
        maxLength: 120,
      })
      // 同一张牌可以在牌堆里放多份，缺省 1 份
      if (card.count !== undefined) {
        requireInteger(card.count, `${cardLabel}.count`, errors, {
          min: 1,
          max: 8,
        })
      }
      validateEffect(
        card.effect,
        `${cardLabel}.effect`,
        new Set(tileById.keys()),
        errors,
        itemIds
      )
    }
    for (const duplicate of duplicates(cardIds)) {
      errors.push(`${label} 的卡牌 ID 重复：${duplicate}`)
    }
  }

  for (const duplicate of duplicates(deckIds)) {
    errors.push(`机会牌堆 ID 重复：${duplicate}`)
  }

  const deckIdSet = new Set(deckIds)
  for (const tile of map.tiles.filter((item) => item?.type === "chance")) {
    if (!deckIdSet.has(tile.deckId)) {
      errors.push(`机会格 ${tile.id} 引用了不存在的牌堆 ${tile.deckId}`)
    }
  }
}

function validateTopology(map, tileById, errors) {
  const { board } = map
  if (!isPlainObject(board) || !Array.isArray(board.path)) return
  if (board.path.length !== board.size) {
    errors.push("board.path 长度必须等于 board.size")
  }
  for (const duplicate of duplicates(board.path)) {
    errors.push(`board.path 重复引用格子 ${duplicate}`)
  }
  for (const tileId of board.path) {
    if (!tileById.has(tileId)) errors.push(`board.path 引用了不存在的格子 ${tileId}`)
  }
  if (!sameMembers(board.path, [...tileById.keys()])) {
    errors.push("board.path 必须完整且仅覆盖全部格子")
  }

  const start = tileById.get(board.startTileId)
  if (start?.type !== "start") errors.push("board.startTileId 必须指向 start 格")
  const jail = tileById.get(board.jailTileId)
  if (jail?.type !== "jail") errors.push("board.jailTileId 必须指向 jail 格")

  const { columns, rows } = board.layout || {}
  const coordinateKeys = []
  for (const tile of map.tiles) {
    if (
      !isPlainObject(tile) ||
      !tile.position ||
      !Number.isInteger(columns) ||
      !Number.isInteger(rows)
    ) {
      continue
    }
    const { x, y } = tile.position
    if (x >= columns || y >= rows) {
      errors.push(`格子 ${tile.id} 的坐标超出 ${columns}×${rows} 布局`)
    }
    if (x !== 0 && x !== columns - 1 && y !== 0 && y !== rows - 1) {
      errors.push(`格子 ${tile.id} 不在棋盘外圈`)
    }
    coordinateKeys.push(`${x}:${y}`)
  }
  for (const duplicate of duplicates(coordinateKeys)) {
    errors.push(`棋盘坐标重复：${duplicate}`)
  }

  if (board.path.every((tileId) => tileById.has(tileId))) {
    for (let index = 0; index < board.path.length; index++) {
      const current = tileById.get(board.path[index])
      const next = tileById.get(board.path[(index + 1) % board.path.length])
      if (!current?.position || !next?.position) continue
      const distance =
        Math.abs(current.position.x - next.position.x) +
        Math.abs(current.position.y - next.position.y)
      if (distance !== 1) {
        errors.push(`路径 ${current.id} → ${next.id} 在布局上不相邻`)
      }
    }
  }

  for (const tile of map.tiles.filter(
    (item) => item?.type === "go_to_jail"
  )) {
    if (tileById.get(tile.targetTileId)?.type !== "jail") {
      errors.push(`前往看守所格 ${tile.id} 的目标不是 jail 格`)
    }
  }
}

export function validateMap(map) {
  const errors = []
  if (!requireObject(map, "地图根节点", errors)) {
    throw new MapValidationError(errors)
  }
  collectUnknownFields(map, ROOT_FIELDS, "地图根节点", errors)

  if (map.schemaVersion !== 1) errors.push("schemaVersion 目前只支持 1")
  requireString(map.id, "id", errors, {
    pattern: /^[a-z][a-z0-9-]*$/,
    maxLength: 60,
  })
  requireInteger(map.version, "version", errors, { min: 1, max: 10_000 })
  requireString(map.name, "name", errors, { maxLength: 40 })
  requireString(map.description, "description", errors, { maxLength: 200 })
  if (map.ruleset !== "qq-monopoly-turn-v4") {
    errors.push("ruleset 目前只支持 qq-monopoly-turn-v4")
  }

  validateDefaults(map.gameDefaults, errors)
  validateBoard(map.board, errors)

  if (!requireArray(map.tiles, "tiles", errors)) {
    throw new MapValidationError(errors)
  }
  const defaults = isPlainObject(map.gameDefaults) ? map.gameDefaults : {}
  map.tiles.forEach((tile, index) =>
    validateTileShape(tile, index, defaults, errors)
  )

  const tileIds = map.tiles
    .filter((tile) => Number.isSafeInteger(tile?.id))
    .map((tile) => tile.id)
  for (const duplicate of duplicates(tileIds)) {
    errors.push(`格子 ID 重复：${duplicate}`)
  }
  const tileById = new Map(
    map.tiles
      .filter((tile) => Number.isSafeInteger(tile?.id))
      .map((tile) => [tile.id, tile])
  )
  if (Number.isInteger(map.board?.size) && map.tiles.length !== map.board.size) {
    errors.push("tiles 数量必须等于 board.size")
  }

  validateTopology(map, tileById, errors)
  validateGroups(map, tileById, errors)
  validateDecks(map, tileById, validateItems(map, errors), errors)

  if (errors.length > 0) throw new MapValidationError(errors)
  return map
}
