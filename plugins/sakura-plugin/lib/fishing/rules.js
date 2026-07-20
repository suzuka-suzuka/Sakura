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

export const WEATHER_CONFIG = Object.freeze({
  "晴": Object.freeze({ emoji: "☀️", weight: 30 }),
  "多云": Object.freeze({ emoji: "⛅", weight: 25 }),
  "雨": Object.freeze({ emoji: "🌧️", weight: 20 }),
  "雾": Object.freeze({ emoji: "🌫️", weight: 12 }),
  "雷暴": Object.freeze({ emoji: "⛈️", weight: 8 }),
  "雪": Object.freeze({ emoji: "❄️", weight: 5 }),
});

const WEATHER_ROTATION_MS = 60 * 60 * 1000;

// 32 位整数混淆散列，把小时序号映射为 [0, 1) 的确定值
function hashHourIndex(hourIndex) {
  let h = (Math.imul(hourIndex, 0x9E3779B1) + 0x85EBCA6B) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21F0AAAD) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735A2D97) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

// 鱼塘天气按整点轮换，同一小时内全局一致；传入未来时间即可做预报
export function getWeatherByTime(timestamp = Date.now()) {
  const hourIndex = Math.floor((Number(timestamp) || 0) / WEATHER_ROTATION_MS);
  const pool = Object.keys(WEATHER_CONFIG);
  const weights = pool.map((name) => WEATHER_CONFIG[name].weight);
  const name = selectRarityByWeight(pool, weights, () => hashHourIndex(hourIndex));
  return { name, emoji: WEATHER_CONFIG[name].emoji };
}

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
const PERFECT_CATCH_WINDOW_MS = 5000;
export const NIGHTMARE_CURSE_HIDDEN_LAYERS = 2;
export const FISHING_STAMINA_MAX = 20;
export const FISHING_STAMINA_COST = 1;
export const FISHING_STAMINA_RECOVERY_MS = 30 * 60 * 1000;

export const FISH_FIGHT_STATE = Object.freeze({
  calm: "calm",
  struggling: "struggling",
  tired: "tired",
});

export const FISH_FIGHT_STATE_CONFIG = Object.freeze({
  [FISH_FIGHT_STATE.calm]: Object.freeze({
    name: "平静",
    pullDistanceMultiplier: 1,
    pullTensionMultiplier: 1,
    loosenDistanceMultiplier: 1,
    loosenTensionMultiplier: 1,
  }),
  [FISH_FIGHT_STATE.struggling]: Object.freeze({
    name: "挣扎",
    pullDistanceMultiplier: 0.7,
    pullTensionMultiplier: 1.5,
    loosenDistanceMultiplier: 1.25,
    loosenTensionMultiplier: 1.4,
  }),
  [FISH_FIGHT_STATE.tired]: Object.freeze({
    name: "疲惫",
    pullDistanceMultiplier: 1.4,
    pullTensionMultiplier: 0.65,
    loosenDistanceMultiplier: 0.75,
    loosenTensionMultiplier: 0.7,
  }),
});

export const FISH_FIGHT_STATE_CHANGE_MIN_MS = 8000;
export const FISH_FIGHT_STATE_CHANGE_MAX_MS = 12000;

export function calculateFishingStamina(currentStamina, updatedAt, now = Date.now()) {
  const numericNow = Number(now);
  const safeNow = Number.isFinite(numericNow) && numericNow >= 0
    ? Math.floor(numericNow)
    : Date.now();
  const numericStamina = Number(currentStamina);
  const safeCurrent = Number.isFinite(numericStamina)
    ? Math.max(0, Math.min(FISHING_STAMINA_MAX, Math.floor(numericStamina)))
    : FISHING_STAMINA_MAX;
  const numericUpdatedAt = Number(updatedAt);

  if (!Number.isFinite(numericUpdatedAt) || numericUpdatedAt <= 0 || numericUpdatedAt > safeNow) {
    return {
      stamina: safeCurrent,
      updatedAt: safeNow,
      recovered: 0,
      nextRecoveryMs: safeCurrent < FISHING_STAMINA_MAX ? FISHING_STAMINA_RECOVERY_MS : 0,
    };
  }

  if (safeCurrent >= FISHING_STAMINA_MAX) {
    return {
      stamina: FISHING_STAMINA_MAX,
      updatedAt: safeNow,
      recovered: 0,
      nextRecoveryMs: 0,
    };
  }

  const elapsed = Math.max(0, safeNow - Math.floor(numericUpdatedAt));
  const recoverable = Math.floor(elapsed / FISHING_STAMINA_RECOVERY_MS);
  const stamina = Math.min(FISHING_STAMINA_MAX, safeCurrent + recoverable);
  const recovered = stamina - safeCurrent;

  if (stamina >= FISHING_STAMINA_MAX) {
    return {
      stamina,
      updatedAt: safeNow,
      recovered,
      nextRecoveryMs: 0,
    };
  }

  const nextUpdatedAt = Math.floor(numericUpdatedAt) + recoverable * FISHING_STAMINA_RECOVERY_MS;
  return {
    stamina,
    updatedAt: nextUpdatedAt,
    recovered,
    nextRecoveryMs: Math.max(0, nextUpdatedAt + FISHING_STAMINA_RECOVERY_MS - safeNow),
  };
}

export function getFishFightStateConfig(stateId) {
  return FISH_FIGHT_STATE_CONFIG[stateId] || FISH_FIGHT_STATE_CONFIG[FISH_FIGHT_STATE.calm];
}

// 状态轮换时排除当前状态，确保玩家确实能观察到变化。
export function selectNextFishFightState(currentState, random = Math.random) {
  const safeCurrentState = FISH_FIGHT_STATE_CONFIG[currentState]
    ? currentState
    : FISH_FIGHT_STATE.calm;
  const candidates = Object.values(FISH_FIGHT_STATE).filter((state) => state !== safeCurrentState);
  const roll = Math.max(0, Math.min(0.999999999999, Number(random()) || 0));
  return candidates[Math.floor(roll * candidates.length)];
}

export function getFishFightStateChangeDelay(random = Math.random) {
  const roll = Math.max(0, Math.min(1, Number(random()) || 0));
  return Math.round(
    FISH_FIGHT_STATE_CHANGE_MIN_MS +
    (FISH_FIGHT_STATE_CHANGE_MAX_MS - FISH_FIGHT_STATE_CHANGE_MIN_MS) * roll,
  );
}

function scaleFightEffect(value, multiplier) {
  const safeValue = Number(value);
  if (!Number.isFinite(safeValue) || safeValue === 0) return 0;
  const scaled = Math.round(safeValue * multiplier);
  if (scaled === 0) return safeValue > 0 ? 1 : -1;
  return scaled;
}

// distanceEffect 和 tensionEffect 均传入正向幅度：拉时分别代表收线、增张力，
// 溜时分别代表鱼逃远、卸张力。
export function applyFishFightStateModifiers({
  stateId = FISH_FIGHT_STATE.calm,
  action,
  distanceEffect,
  tensionEffect,
} = {}) {
  const config = getFishFightStateConfig(stateId);
  if (action === "pull") {
    return {
      distanceEffect: scaleFightEffect(distanceEffect, config.pullDistanceMultiplier),
      tensionEffect: scaleFightEffect(tensionEffect, config.pullTensionMultiplier),
    };
  }
  if (action === "loosen") {
    return {
      distanceEffect: scaleFightEffect(distanceEffect, config.loosenDistanceMultiplier),
      tensionEffect: scaleFightEffect(tensionEffect, config.loosenTensionMultiplier),
    };
  }
  throw new TypeError(`未知的溜鱼操作：${action}`);
}

// 按稀有度取单次渔获基础经验，未知稀有度按最低档处理
export function getFishExpByRarity(rarity) {
  return RARITY_CONFIG[rarity]?.exp || 1;
}

// 单次渔获经验：以稀有度基础经验为中心，在 0.5~1.5 倍间波动，至少为 1
export function rollFishExp(rarity, random = Math.random) {
  const base = getFishExpByRarity(rarity);
  const roll = Math.max(0, Math.min(1, Number(random()) || 0));
  return Math.max(1, Math.round(base * (0.5 + roll)));
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

// 玩家看到的诅咒层数会少报两层，但真实诅咒未清零时至少显示 1 层。
export function getNightmareCurseDisplay(actualLayers, prankRevealed = false) {
  const safeActualLayers = Math.max(0, Math.floor(Number(actualLayers) || 0));
  if (safeActualLayers === 0) {
    return {
      actualLayers: 0,
      displayedLayers: 0,
      isPranked: false,
    };
  }

  const displayedLayers = Math.max(1, safeActualLayers - NIGHTMARE_CURSE_HIDDEN_LAYERS);
  return {
    actualLayers: safeActualLayers,
    displayedLayers,
    isPranked: Boolean(prankRevealed),
  };
}

export function createProgressBar(current, max, length = 10, fillChar = "█", emptyChar = "░") {
  const safeMax = Number(max);
  const percentage = safeMax > 0
    ? Math.max(0, Math.min(100, (Number(current) / safeMax) * 100))
    : 0;
  const filled = Math.round((percentage / 100) * length);
  return fillChar.repeat(filled) + emptyChar.repeat(length - filled);
}

// 完美收竿同时要求及时操作，以及装备足以通过本次重量、难度判定；
// 好运护符等保底道具可以替代装备条件，但不能替代 5 秒操作窗口。
export function isPerfectCatch({
  reelDelayMs,
  fishWeight,
  fishDifficulty,
  lineCapacity,
  effectiveControl,
  hasAssist = false,
} = {}) {
  const delay = Number(reelDelayMs);
  if (!Number.isFinite(delay) || delay < 0 || delay > PERFECT_CATCH_WINDOW_MS) {
    return false;
  }

  const equipmentOverpowersFish = (
    Number(fishWeight) <= Number(lineCapacity) &&
    Number(fishDifficulty) <= Number(effectiveControl)
  );
  return equipmentOverpowersFish || Boolean(hasAssist);
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

function isFishActiveInWeather(fish, weatherName) {
  if (!weatherName || !Array.isArray(fish?.weather) || fish.weather.length === 0) return true;
  return fish.weather.includes(weatherName);
}

export function selectFishFromData(
  fishData,
  {
    baitQuality = 1,
    hasDebuff = false,
    treasureBonus = 0,
    hour = new Date().getHours(),
    weather = getWeatherByTime().name,
    random = Math.random,
  } = {},
) {
  const { pool, weights } = getRarityPoolByBaitQuality(baitQuality, hasDebuff, treasureBonus);
  const rarity = selectRarityByWeight(pool, weights, random);
  let candidates = fishData.filter((fish) => (
    fish.rarity === rarity && isFishActiveAtHour(fish, hour) && isFishActiveInWeather(fish, weather)
  ));
  if (candidates.length === 0) {
    // 天气把该稀有度过滤空时退回无天气池，保证钓鱼永远有产出
    candidates = fishData.filter((fish) => fish.rarity === rarity && isFishActiveAtHour(fish, hour));
  }
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
    if (
      fish?.weather != null && (
        !Array.isArray(fish.weather) ||
        fish.weather.length === 0 ||
        fish.weather.some((name) => !WEATHER_CONFIG[name])
      )
    ) {
      errors.push(`${label}: 天气限定无效`);
    }
  }
  return errors;
}
