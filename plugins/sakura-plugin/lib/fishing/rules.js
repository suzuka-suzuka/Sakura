export const RARITY_CONFIG = Object.freeze({
  "垃圾": Object.freeze({ color: "⚫", level: 0, exp: 1 }),
  "普通": Object.freeze({ color: "⚪", level: 1, exp: 2 }),
  "精品": Object.freeze({ color: "🟢", level: 2, exp: 5 }),
  "稀有": Object.freeze({ color: "🔵", level: 3, exp: 10 }),
  "史诗": Object.freeze({ color: "🟣", level: 4, exp: 20 }),
  "传说": Object.freeze({ color: "🟠", level: 5, exp: 35 }),
  "宝藏": Object.freeze({ color: "👑", level: 6, exp: 50 }),
  "噩梦": Object.freeze({ color: "💀", level: 7, exp: 40 }),
});

const ALL_RARITIES = Object.freeze(["垃圾", "普通", "精品", "稀有", "史诗", "传说", "宝藏", "噩梦"]);
const QUALITY_WEIGHTS = Object.freeze({
  1: [["垃圾", "普通", "精品", "宝藏", "噩梦"], [39, 50, 1, 5, 5]],
  2: [["垃圾", "普通", "精品", "稀有", "宝藏", "噩梦"], [19, 20, 50, 1, 5, 5]],
  3: [["垃圾", "普通", "精品", "稀有", "史诗", "宝藏", "噩梦"], [9, 10, 20, 50, 1, 5, 5]],
  4: [ALL_RARITIES, [4, 5, 10, 20, 50, 1, 5, 5]],
  5: [ALL_RARITIES, [2, 3, 5, 10, 20, 50, 5, 5]],
  6: [ALL_RARITIES, [1, 1, 3, 5, 10, 20, 50, 10]],
});

const FISHING_LEVEL_EXP_BASE = 20;

// 按稀有度取单次渔获经验，未知稀有度按最低档处理
export function getFishExpByRarity(rarity) {
  return RARITY_CONFIG[rarity]?.exp || 1;
}

// 升到 level 级所需的累计经验（1 级为 0）
export function getFishingLevelExp(level) {
  const safeLevel = Math.max(1, Math.floor(Number(level) || 1));
  return FISHING_LEVEL_EXP_BASE * (safeLevel - 1) ** 2;
}

// 由累计经验推导当前钓鱼等级
export function getFishingLevelByExp(exp) {
  const safeExp = Math.max(0, Number(exp) || 0);
  return Math.floor(Math.sqrt(safeExp / FISHING_LEVEL_EXP_BASE)) + 1;
}

export function createProgressBar(current, max, length = 10, fillChar = "█", emptyChar = "░") {
  const safeMax = Number(max);
  const percentage = safeMax > 0
    ? Math.max(0, Math.min(100, (Number(current) / safeMax) * 100))
    : 0;
  const filled = Math.round((percentage / 100) * length);
  return fillChar.repeat(filled) + emptyChar.repeat(length - filled);
}

function getRarityPoolByBaitQuality(quality, hasDebuff = false, treasureBonus = 0) {
  const [configuredPool, configuredWeights] = QUALITY_WEIGHTS[quality] || QUALITY_WEIGHTS[1];
  const pool = [...configuredPool];
  const weights = [...configuredWeights];
  const treasureIndex = pool.indexOf("宝藏");
  const nightmareIndex = pool.indexOf("噩梦");

  if (treasureIndex >= 0 && Number(treasureBonus) > 0) {
    weights[treasureIndex] += Number(treasureBonus);
  }
  if (hasDebuff && treasureIndex >= 0 && nightmareIndex >= 0) {
    weights[nightmareIndex] += weights[treasureIndex];
    weights[treasureIndex] = 0;
  }
  return { pool, weights };
}

function selectRarityByWeight(pool, weights, random = Math.random) {
  if (!Array.isArray(pool) || !Array.isArray(weights) || pool.length !== weights.length || pool.length === 0) {
    throw new TypeError("稀有度池配置无效");
  }
  const totalWeight = weights.reduce((total, weight) => total + Math.max(0, Number(weight) || 0), 0);
  if (totalWeight <= 0) throw new TypeError("稀有度权重总和必须大于 0");
  let roll = Math.max(0, Math.min(0.999999999999, Number(random()) || 0)) * totalWeight;
  for (let index = 0; index < pool.length; index += 1) {
    roll -= Math.max(0, Number(weights[index]) || 0);
    if (roll <= 0) return pool[index];
  }
  return pool.at(-1);
}

function isFishActiveAtHour(fish, hour) {
  if (!Array.isArray(fish?.active_hours) || fish.active_hours.length === 0) return true;
  return fish.active_hours.some(([start, end]) => (
    start <= end ? hour >= start && hour < end : hour >= start || hour < end
  ));
}

export function selectFishFromData(
  fishData,
  { baitQuality = 1, hasDebuff = false, treasureBonus = 0, hour = new Date().getHours(), random = Math.random } = {},
) {
  const { pool, weights } = getRarityPoolByBaitQuality(baitQuality, hasDebuff, treasureBonus);
  const rarity = selectRarityByWeight(pool, weights, random);
  const candidates = fishData.filter((fish) => fish.rarity === rarity && isFishActiveAtHour(fish, hour));
  if (candidates.length === 0) {
    throw new Error(`当前时段没有可用的“${rarity}”渔获`);
  }
  const index = Math.min(candidates.length - 1, Math.floor(Math.max(0, Number(random()) || 0) * candidates.length));
  const selected = candidates[index];
  const [minWeight, maxWeight] = selected.weight;
  const weightRoll = Math.max(0, Math.min(1, Number(random()) || 0));
  const actualWeight = Math.round((minWeight + (maxWeight - minWeight) * weightRoll) * 100) / 100;
  return {
    ...selected,
    actualWeight,
    isTreasure: selected.rarity === "宝藏",
  };
}

export function calculateLegacyFishPrice(fish, globalMultiplier = 1) {
  const basePrice = Number(fish?.base_price) || 0;
  const weight = Number(fish?.actualWeight) || 0;
  const [minWeight, maxWeight] = fish?.weight || [weight, weight];
  const progress = maxWeight === minWeight ? 0.5 : Math.max(0, Math.min(1, (weight - minWeight) / (maxWeight - minWeight)));
  return Math.round(basePrice * (0.5 + progress) * Math.max(0, Number(globalMultiplier) || 0));
}

export function validateLegacyFishData(fishData) {
  if (!Array.isArray(fishData) || fishData.length === 0) return ["鱼类数据为空"];
  const errors = [];
  const ids = new Set();
  for (const [index, fish] of fishData.entries()) {
    const label = fish?.id || `#${index}`;
    if (typeof fish?.id !== "string" || !fish.id.trim() || ids.has(fish.id)) {
      errors.push(`${label}: id 缺失或重复`);
    }
    ids.add(fish?.id);
    if (typeof fish?.name !== "string" || !fish.name.trim()) errors.push(`${label}: 名称缺失`);
    if (!RARITY_CONFIG[fish?.rarity]) errors.push(`${label}: 稀有度无效`);
    if (
      !Array.isArray(fish?.weight) ||
      fish.weight.length !== 2 ||
      fish.weight.some((value) => !Number.isFinite(value)) ||
      fish.weight[0] > fish.weight[1]
    ) {
      errors.push(`${label}: 重量区间无效`);
    }
    if (!Number.isFinite(fish?.base_price) || fish.base_price < 0) {
      errors.push(`${label}: 基础价格无效`);
    }
    if (!Number.isFinite(fish?.difficulty) || fish.difficulty < 0) {
      errors.push(`${label}: 难度无效`);
    }
    if (
      fish?.active_hours != null && (
        !Array.isArray(fish.active_hours) ||
        fish.active_hours.some((range) => (
          !Array.isArray(range) ||
          range.length !== 2 ||
          range.some((hour) => !Number.isFinite(hour) || hour < 0 || hour > 24)
        ))
      )
    ) {
      errors.push(`${label}: 活跃时段无效`);
    }
  }
  return errors;
}
