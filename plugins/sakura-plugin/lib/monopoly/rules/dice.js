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
