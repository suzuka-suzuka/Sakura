export function rollDice(sides, randomInt) {
  if (!Number.isSafeInteger(sides) || sides < 2) {
    throw new TypeError("骰子面数无效")
  }
  if (typeof randomInt !== "function") {
    throw new TypeError("rollDice 需要随机整数函数")
  }
  const value = randomInt(1, sides + 1)
  if (!Number.isSafeInteger(value) || value < 1 || value > sides) {
    throw new RangeError(`随机函数返回了无效骰子点数 ${value}`)
  }
  return value
}

export function validateDice(value, sides) {
  if (!Number.isSafeInteger(value) || value < 1 || value > sides) {
    throw new RangeError(`骰子点数必须在 1～${sides} 之间`)
  }
  return value
}

export function rollDiceSet(count, sides, randomInt) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 10) {
    throw new TypeError("骰子数量无效")
  }
  return Array.from({ length: count }, () => rollDice(sides, randomInt))
}

export function validateDiceSet(values, count, sides) {
  if (!Array.isArray(values) || values.length !== count) {
    throw new RangeError(`必须提供 ${count} 颗骰子的点数`)
  }
  return values.map((value) => validateDice(value, sides))
}
