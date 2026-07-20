export const RARITY_CONFIG = Object.freeze({
  "垃圾": Object.freeze({ color: "⚫", level: 0, exp: 1 }),
  "普通": Object.freeze({ color: "⚪", level: 1, exp: 2 }),
  "精品": Object.freeze({ color: "🟢", level: 2, exp: 5 }),
  "稀有": Object.freeze({ color: "🔵", level: 3, exp: 10 }),
  "史诗": Object.freeze({ color: "🟣", level: 4, exp: 20 }),
  "传说": Object.freeze({ color: "🟠", level: 5, exp: 35 }),
  // 宝箱本体已经是钱，经验压到传说之下；噩梦经验略高补偿惩罚
  "宝藏": Object.freeze({ color: "👑", level: 6, exp: 28 }),
  "噩梦": Object.freeze({ color: "💀", level: 7, exp: 32 }),
});

export const WEATHER_CONFIG = Object.freeze({
  "晴": Object.freeze({ emoji: "☀️", weight: 30 }),
  "多云": Object.freeze({ emoji: "⛅", weight: 25 }),
  "雨": Object.freeze({ emoji: "🌧️", weight: 20 }),
  "雾": Object.freeze({ emoji: "🌫️", weight: 12 }),
  "雷暴": Object.freeze({ emoji: "⛈️", weight: 8 }),
  "雪": Object.freeze({ emoji: "❄️", weight: 5 }),
});

// 钓点只筛物种池（fish.json 的 locations 字段），不影响稀有度权重；
// 未填 locations 的鱼视为全钓点通用。unlockLevel 为钓鱼等级解锁门槛
export const FISHING_LOCATIONS = Object.freeze({
  pond: Object.freeze({ name: "樱花池塘", emoji: "🌸", unlockLevel: 1, description: "飘着花瓣的新手鱼塘，波光里透着家的味道。" }),
  river: Object.freeze({ name: "青柳河湾", emoji: "🍃", unlockLevel: 3, description: "垂柳掩映的湍急河湾，洄游鱼的必经之路。" }),
  lake: Object.freeze({ name: "雾隐湖", emoji: "🌫️", unlockLevel: 5, description: "常年被浓雾笼罩的幽静湖泊，湖底似乎藏着古老的东西。" }),
  coast: Object.freeze({ name: "落日海岸", emoji: "🌅", unlockLevel: 8, description: "夕阳染红的浅海海岸，浪花里翻涌着热带的气息。" }),
  abyss: Object.freeze({ name: "深渊海沟", emoji: "🌀", unlockLevel: 12, description: "阳光到不了的深海裂谷，巨物与怪鱼的领域。" }),
  mystic: Object.freeze({ name: "星辉秘境", emoji: "✨", unlockLevel: 16, description: "现实之外的幻想水域，星光落进水里就活了过来。" }),
});

export const DEFAULT_FISHING_LOCATION = "pond";
export const BOSS_BAIT_ID = "bait_boss";
export const BOSS_ATTACK_INTERVAL_MS = 5000;
export const BOSS_PLAYER_ATTACK_COOLDOWN_MS = 5000;
export const BOSS_FIGHT_TIMEOUT_MS = 150 * 1000;
export const BOSS_MIN_DIFFICULTY = 200;
export const BOSS_MIN_HP = 90;
export const BOSS_MIN_ATTACK = 8;
export const BOSS_MECHANIC_TYPES = Object.freeze([
  "stamina_drain",
  "steal_coins",
  "tension_surge",
  "line_rend",
  "rod_crush",
  "regenerate",
]);
export const LOCAL_NIGHTMARE_CHANCE = 0.5;
export const NIGHTMARE_EFFECT_TYPES = Object.freeze([
  "rod_damage",
  "steal_coins_flat",
  "steal_coins_percent",
  "curse",
  "bride_thread",
  "steal_bait",
  "lost_soul",
  "ghost_debt",
  "deep_pressure",
  "devour_buff",
]);
export const LOCAL_NIGHTMARE_EFFECT_BY_LOCATION = Object.freeze({
  pond: "bride_thread",
  river: "steal_bait",
  lake: "lost_soul",
  coast: "ghost_debt",
  abyss: "deep_pressure",
  mystic: "devour_buff",
});

export function getFishingLocationConfig(locationId) {
  return FISHING_LOCATIONS[locationId] || null;
}

export function isBossFish(fish) {
  return fish?.is_boss === true;
}

// 首领战限时可按 Boss 单独配置（fight_timeout_seconds），未配置时用全局默认。
// 深渊系 Boss 用短窗口制造“输出竞速”压力。
export function getBossFightTimeoutMs(fish) {
  const seconds = Number(fish?.fight_timeout_seconds);
  return Number.isFinite(seconds) && seconds >= 30
    ? Math.floor(seconds * 1000)
    : BOSS_FIGHT_TIMEOUT_MS;
}

export function selectBossFromData(
  fishData,
  { location = DEFAULT_FISHING_LOCATION, random = Math.random } = {},
) {
  const candidates = Array.isArray(fishData)
    ? fishData.filter((fish) => (
      isBossFish(fish) &&
      Array.isArray(fish.locations) &&
      fish.locations.includes(location)
    ))
    : [];
  if (candidates.length === 0) {
    throw new Error(`当前钓点没有可挑战的首领`);
  }

  const selected = candidates[0];
  const [minWeight, maxWeight] = selected.weight;
  const weightRoll = Math.max(0, Math.min(1, Number(random()) || 0));
  const actualWeight = Math.round(
    (minWeight + (maxWeight - minWeight) * weightRoll) * 100,
  ) / 100;
  return { ...selected, actualWeight, isBoss: true };
}

export function calculateBossLineDurability(lineCapacity) {
  const capacity = Math.max(0, Number(lineCapacity) || 0);
  return Math.max(20, Math.round(20 + capacity * 0.5));
}

export function rollBossPlayerDamage(effectiveControl, random = Math.random) {
  const control = Math.max(0, Number(effectiveControl) || 0);
  const roll = Math.max(0, Math.min(0.999999999999, Number(random()) || 0));
  return Math.max(6, Math.floor(control / 10) + 5 + Math.floor(roll * 5));
}

export function getBossAttackCooldownRemaining(
  lastAttackAt,
  now = Date.now(),
  cooldownMs = BOSS_PLAYER_ATTACK_COOLDOWN_MS,
) {
  const last = Math.max(0, Number(lastAttackAt) || 0);
  const current = Math.max(0, Number(now) || 0);
  const cooldown = Math.max(0, Number(cooldownMs) || 0);
  if (last <= 0) return 0;
  return Math.max(0, Math.ceil(cooldown - (current - last)));
}

export function resolveBossAttack(boss, random = Math.random) {
  const attack = Math.max(1, Math.floor(Number(boss?.attack) || 1));
  const mechanic = boss?.boss_mechanic || {};
  const baseGearDamage = Math.max(1, Math.ceil(attack / 2));
  const result = {
    lineDamage: baseGearDamage,
    rodDamage: baseGearDamage,
    distanceGain: Math.max(1, Math.floor(attack / 4)),
    staminaDrain: 0,
    coinSteal: 0,
    tensionGain: 0,
    heal: 0,
  };

  switch (mechanic.type) {
    case "stamina_drain":
      result.staminaDrain = Math.max(1, Math.floor(Number(mechanic.amount) || 1));
      break;
    case "steal_coins": {
      const min = Math.max(1, Math.floor(Number(mechanic.min) || 1));
      const max = Math.max(min, Math.floor(Number(mechanic.max) || min));
      const roll = Math.max(0, Math.min(0.999999999999, Number(random()) || 0));
      result.coinSteal = min + Math.floor(roll * (max - min + 1));
      break;
    }
    case "tension_surge":
      result.tensionGain = Math.max(1, Math.floor(Number(mechanic.amount) || 1));
      break;
    case "line_rend":
      result.lineDamage = Math.max(
        1,
        Math.round(baseGearDamage * Math.max(1, Number(mechanic.multiplier) || 1)),
      );
      break;
    case "rod_crush":
      result.rodDamage = Math.max(
        1,
        Math.round(baseGearDamage * Math.max(1, Number(mechanic.multiplier) || 1)),
      );
      break;
    case "regenerate":
      result.heal = Math.max(1, Math.floor(Number(mechanic.amount) || 1));
      break;
    default:
      break;
  }
  return result;
}

export function normalizeFishingLocation(locationId) {
  return FISHING_LOCATIONS[locationId] ? locationId : DEFAULT_FISHING_LOCATION;
}

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
// 宝藏/噩梦权重随饵料品质递增：低档饵开箱率低（杜绝低价饵蹲高级钓点刷宝），
// 高档饵稳步提升，寻宝鱼饵(q6)是高开箱高噩梦的赌狗专精
const QUALITY_WEIGHTS = Object.freeze({
  1: [["垃圾", "普通", "精品", "宝藏", "噩梦"], [34, 58, 5, 1, 2]],
  2: [["垃圾", "普通", "精品", "稀有", "宝藏", "噩梦"], [17, 24, 50, 4, 2, 3]],
  3: [["垃圾", "普通", "精品", "稀有", "史诗", "宝藏", "噩梦"], [7, 12, 21, 50, 3, 3, 4]],
  4: [ALL_RARITIES, [3, 6, 11, 20, 50, 1, 4, 5]],
  5: [ALL_RARITIES, [2, 3, 5, 10, 21, 49, 5, 5]],
  6: [ALL_RARITIES, [1, 2, 4, 7, 12, 22, 40, 12]],
});

const FISHING_LEVEL_EXP_BASE = 20;
const PERFECT_CATCH_WINDOW_MS = 5000;
export const NIGHTMARE_CURSE_HIDDEN_LAYERS = 2;
export const FISHING_COOLDOWN_SECONDS = 6 * 60;
export const FISHING_BENEFIT_DURATION_SECONDS = 30 * 60;
export const FISHING_BITE_WAIT_MAX_SECONDS = 120;
export const FISHING_BITE_WAIT_REDUCTION_PER_LEVEL_SECONDS = 2;
export const FISHING_STAMINA_BASE = 10;
export const FISHING_STAMINA_PER_LEVEL = 1;
// 保留旧导出名作为 1 级/新玩家的初始体力上限。
export const FISHING_STAMINA_MAX = FISHING_STAMINA_BASE;
export const FISHING_STAMINA_COST = 1;
export const FISHING_STAMINA_RECOVERY_MS = 30 * 60 * 1000;

export function getFishingBiteWaitMaxMs(level) {
  const safeLevel = Math.max(1, Math.floor(Number(level) || 1));
  return Math.max(
    0,
    FISHING_BITE_WAIT_MAX_SECONDS - (
      (safeLevel - 1) * FISHING_BITE_WAIT_REDUCTION_PER_LEVEL_SECONDS
    ),
  ) * 1000;
}

export function rollFishingBiteWaitMs(level, random = Math.random) {
  const maxWaitMs = getFishingBiteWaitMaxMs(level);
  if (maxWaitMs === 0) return 0;
  const roll = Math.max(0, Math.min(1, Number(random()) || 0));
  return Math.min(maxWaitMs, Math.floor(roll * (maxWaitMs + 1)));
}

export function getFishingStaminaMax(level) {
  const safeLevel = Math.max(1, Math.floor(Number(level) || 1));
  return FISHING_STAMINA_BASE + (safeLevel - 1) * FISHING_STAMINA_PER_LEVEL;
}

export function getFishingStaminaCost(deepPressureLayers = 0) {
  return FISHING_STAMINA_COST + (Math.max(0, Math.floor(Number(deepPressureLayers) || 0)) > 0 ? 1 : 0);
}

export function getLostSoulRewardMultiplier(penaltyReduction = 0) {
  const reduction = Math.max(0, Math.min(1, Number(penaltyReduction) || 0));
  return 1 - 0.5 * (1 - reduction);
}

export function resolveNightmareRarityAfflictions(curseLayers = 0, brideThreadLayers = 0) {
  const curseActive = Math.max(0, Math.floor(Number(curseLayers) || 0)) > 0;
  const brideThreadAvailable = Math.max(0, Math.floor(Number(brideThreadLayers) || 0)) > 0;
  return {
    consumeCurse: curseActive,
    consumeBrideThread: !curseActive && brideThreadAvailable,
    brideThreadPaused: curseActive && brideThreadAvailable,
  };
}

export function calculateGhostDebtPayment(earnings, debt) {
  const safeEarnings = Math.max(0, Math.floor(Number(earnings) || 0));
  const safeDebt = Math.max(0, Math.floor(Number(debt) || 0));
  const debtPaid = Math.min(safeEarnings, safeDebt);
  return {
    grossEarnings: safeEarnings,
    earnings: safeEarnings - debtPaid,
    debtPaid,
    remainingDebt: safeDebt - debtPaid,
  };
}

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

export function calculateFishingStamina(
  currentStamina,
  updatedAt,
  now = Date.now(),
  maxStamina = FISHING_STAMINA_MAX,
) {
  const numericNow = Number(now);
  const safeNow = Number.isFinite(numericNow) && numericNow >= 0
    ? Math.floor(numericNow)
    : Date.now();
  const numericMax = Number(maxStamina);
  const safeMax = Number.isFinite(numericMax) && numericMax >= 0
    ? Math.floor(numericMax)
    : FISHING_STAMINA_MAX;
  const numericStamina = Number(currentStamina);
  const safeCurrent = Number.isFinite(numericStamina)
    ? Math.max(0, Math.min(safeMax, Math.floor(numericStamina)))
    : safeMax;
  const numericUpdatedAt = Number(updatedAt);

  if (!Number.isFinite(numericUpdatedAt) || numericUpdatedAt <= 0 || numericUpdatedAt > safeNow) {
    return {
      stamina: safeCurrent,
      updatedAt: safeNow,
      recovered: 0,
      nextRecoveryMs: safeCurrent < safeMax ? FISHING_STAMINA_RECOVERY_MS : 0,
    };
  }

  if (safeCurrent >= safeMax) {
    return {
      stamina: safeMax,
      updatedAt: safeNow,
      recovered: 0,
      nextRecoveryMs: 0,
    };
  }

  const elapsed = Math.max(0, safeNow - Math.floor(numericUpdatedAt));
  const recoverable = Math.floor(elapsed / FISHING_STAMINA_RECOVERY_MS);
  const stamina = Math.min(safeMax, safeCurrent + recoverable);
  const recovered = stamina - safeCurrent;

  if (stamina >= safeMax) {
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

function getRarityPoolByBaitQuality(
  quality,
  hasDebuff = false,
  treasureBonus = 0,
  nightmareBonus = 0,
  brideThreadActive = false,
) {
  const [configuredPool, configuredWeights] = QUALITY_WEIGHTS[quality] || QUALITY_WEIGHTS[1];
  const pool = [...configuredPool];
  const weights = [...configuredWeights];
  const treasureIndex = pool.indexOf("宝藏");
  const nightmareIndex = pool.indexOf("噩梦");

  if (treasureIndex >= 0 && Number(treasureBonus) > 0) {
    weights[treasureIndex] += Number(treasureBonus);
  }
  if (nightmareIndex >= 0 && Number(nightmareBonus) > 0) {
    weights[nightmareIndex] += Number(nightmareBonus);
  }
  if (brideThreadActive && treasureIndex >= 0 && nightmareIndex >= 0) {
    const transferredWeight = weights[treasureIndex] / 2;
    weights[treasureIndex] -= transferredWeight;
    weights[nightmareIndex] += transferredWeight;
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

function isFishAtLocation(fish, locationId) {
  if (!locationId || !Array.isArray(fish?.locations) || fish.locations.length === 0) return true;
  return fish.locations.includes(locationId);
}

function selectFishCandidate(candidates, rarity, location, random) {
  let candidatePool = candidates;

  if (rarity === "噩梦") {
    const localNightmares = candidates.filter((fish) => (
      Array.isArray(fish?.locations) && fish.locations.includes(location)
    ));
    const otherNightmares = candidates.filter((fish) => (
      !Array.isArray(fish?.locations) || fish.locations.length === 0
    ));

    // 当前钓点怪谈与通用噩梦各占整个噩梦池的一半；任一侧为空时退回现有候选池。
    if (localNightmares.length > 0 && otherNightmares.length > 0) {
      const roll = Math.max(0, Math.min(0.999999999999, Number(random()) || 0));
      candidatePool = roll < LOCAL_NIGHTMARE_CHANCE ? localNightmares : otherNightmares;
    }
  }

  const index = Math.min(
    candidatePool.length - 1,
    Math.floor(Math.max(0, Number(random()) || 0) * candidatePool.length),
  );
  return candidatePool[index];
}

export function selectFishFromData(
  fishData,
  {
    baitQuality = 1,
    hasDebuff = false,
    treasureBonus = 0,
    nightmareBonus = 0,
    brideThreadActive = false,
    forceRarity = null,
    hour = new Date().getHours(),
    weather = getWeatherByTime().name,
    location = DEFAULT_FISHING_LOCATION,
    random = Math.random,
  } = {},
) {
  const { pool, weights } = getRarityPoolByBaitQuality(
    baitQuality,
    hasDebuff,
    treasureBonus,
    nightmareBonus,
    brideThreadActive,
  );
  // 星愿瓶等道具可强制指定本次稀有度，跳过权重摇取
  const rarity = forceRarity && RARITY_CONFIG[forceRarity]
    ? forceRarity
    : selectRarityByWeight(pool, weights, random);
  let candidates = fishData.filter((fish) => (
    !isBossFish(fish) &&
    fish.rarity === rarity &&
    isFishAtLocation(fish, location) &&
    isFishActiveAtHour(fish, hour) &&
    isFishActiveInWeather(fish, weather)
  ));
  if (candidates.length === 0) {
    // 天气把该稀有度过滤空时退回无天气池，保证钓鱼永远有产出；
    // 钓点约束不参与兜底，避免限定鱼漏到其他钓点
    candidates = fishData.filter((fish) => (
      !isBossFish(fish) &&
      fish.rarity === rarity &&
      isFishAtLocation(fish, location) &&
      isFishActiveAtHour(fish, hour)
    ));
  }
  if (candidates.length === 0) {
    throw new Error(`当前时段没有可用的“${rarity}”渔获`);
  }
  const selected = selectFishCandidate(candidates, rarity, location, random);
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
    if (isBossFish(fish)) {
      const mechanic = fish.boss_mechanic;
      if ((RARITY_CONFIG[fish.rarity]?.level ?? -1) < RARITY_CONFIG["传说"].level) {
        errors.push(`${label}: 首领稀有度至少须为传说`);
      }
      if (Number.isFinite(fish.difficulty) && fish.difficulty < BOSS_MIN_DIFFICULTY) {
        errors.push(`${label}: 首领难度低于传说级下限`);
      }
      if (!Number.isFinite(fish.hp) || fish.hp <= 0) {
        errors.push(`${label}: 首领生命值无效`);
      } else if (fish.hp < BOSS_MIN_HP) {
        errors.push(`${label}: 首领生命值低于传说级下限`);
      }
      if (!Number.isFinite(fish.attack) || fish.attack <= 0) {
        errors.push(`${label}: 首领攻击力无效`);
      } else if (fish.attack < BOSS_MIN_ATTACK) {
        errors.push(`${label}: 首领攻击力低于传说级下限`);
      }
      if (
        fish.fight_timeout_seconds != null &&
        (!Number.isFinite(fish.fight_timeout_seconds) || fish.fight_timeout_seconds < 30)
      ) {
        errors.push(`${label}: 首领战限时无效（须为不小于 30 的秒数）`);
      }
      if (
        !mechanic ||
        typeof mechanic !== "object" ||
        Array.isArray(mechanic) ||
        !BOSS_MECHANIC_TYPES.includes(mechanic.type) ||
        typeof mechanic.name !== "string" ||
        !mechanic.name.trim() ||
        typeof mechanic.description !== "string" ||
        !mechanic.description.trim()
      ) {
        errors.push(`${label}: 首领机制缺失或类型无效`);
      } else if (
        ["stamina_drain", "tension_surge", "regenerate"].includes(mechanic.type) &&
        (!Number.isFinite(mechanic.amount) || mechanic.amount <= 0)
      ) {
        errors.push(`${label}: 首领机制数值无效`);
      } else if (
        mechanic.type === "steal_coins" && (
          !Number.isFinite(mechanic.min) ||
          !Number.isFinite(mechanic.max) ||
          mechanic.min <= 0 ||
          mechanic.max < mechanic.min
        )
      ) {
        errors.push(`${label}: 首领偷钱区间无效`);
      } else if (
        ["line_rend", "rod_crush"].includes(mechanic.type) &&
        (!Number.isFinite(mechanic.multiplier) || mechanic.multiplier < 1)
      ) {
        errors.push(`${label}: 首领伤害倍率无效`);
      }
    } else if (
      fish?.hp != null ||
      fish?.attack != null ||
      fish?.boss_mechanic != null ||
      fish?.fight_timeout_seconds != null
    ) {
      errors.push(`${label}: 非首领渔获不能配置首领战斗数值`);
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
    if (fish?.locations != null) {
      if (
        !Array.isArray(fish.locations) ||
        fish.locations.length < 1 ||
        fish.locations.length > 2 ||
        fish.locations.some((locationId) => !FISHING_LOCATIONS[locationId]) ||
        new Set(fish.locations).size !== fish.locations.length
      ) {
        errors.push(`${label}: 钓点限定无效（须为 1~2 个不重复的有效钓点）`);
      }
    }
    if (fish?.rarity === "噩梦") {
      const effect = fish?.nightmare_effect;
      if (
        !effect ||
        typeof effect !== "object" ||
        Array.isArray(effect) ||
        !NIGHTMARE_EFFECT_TYPES.includes(effect.type)
      ) {
        errors.push(`${label}: 噩梦机制缺失或类型无效`);
      }
    } else if (fish?.nightmare_effect != null) {
      errors.push(`${label}: 非噩梦渔获不能配置噩梦机制`);
    }
  }

  // 结构错误会让后续全量覆盖校验产生大量衍生报错，先返回最直接的配置问题。
  if (errors.length > 0) return errors;

  for (const [locationId, locationConfig] of Object.entries(FISHING_LOCATIONS)) {
    const localNightmares = fishData.filter((fish) => (
      fish?.rarity === "噩梦" &&
      Array.isArray(fish.locations) &&
      fish.locations.includes(locationId)
    ));
    if (localNightmares.length !== 1 || localNightmares[0].locations.length !== 1) {
      errors.push(`${locationConfig.name}: 须配置且只配置一个单钓点专属噩梦`);
    } else if (localNightmares[0].nightmare_effect.type !== LOCAL_NIGHTMARE_EFFECT_BY_LOCATION[locationId]) {
      errors.push(`${locationConfig.name}: 专属噩梦机制配置错误`);
    }

    const localBosses = fishData.filter((fish) => (
      isBossFish(fish) &&
      Array.isArray(fish.locations) &&
      fish.locations.includes(locationId)
    ));
    if (localBosses.length !== 1 || localBosses[0].locations.length !== 1) {
      errors.push(`${locationConfig.name}: 须配置且只配置一个单钓点首领`);
    }
  }

  const configuredBosses = fishData.filter(isBossFish);
  if (
    configuredBosses.length === Object.keys(FISHING_LOCATIONS).length &&
    new Set(configuredBosses.map((fish) => fish.boss_mechanic.type)).size !== configuredBosses.length
  ) {
    errors.push("各钓点首领须配置互不重复的特殊机制");
  }

  // 时段筛空没有兜底，必须保证任意钓点 × 稀有度 × 小时都有候选鱼
  for (const locationId of Object.keys(FISHING_LOCATIONS)) {
    for (const rarity of Object.keys(RARITY_CONFIG)) {
      for (let hour = 0; hour < 24; hour += 1) {
        const available = fishData.some((fish) => (
          !isBossFish(fish) &&
          fish?.rarity === rarity &&
          isFishAtLocation(fish, locationId) &&
          isFishActiveAtHour(fish, hour)
        ));
        if (!available) {
          errors.push(`钓点覆盖缺口: ${FISHING_LOCATIONS[locationId].name} × ${rarity} × ${hour}时 无可用鱼`);
        }
      }
    }
  }
  return errors;
}
