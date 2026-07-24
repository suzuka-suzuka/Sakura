export const RARITY_CONFIG = Object.freeze({
  "垃圾": Object.freeze({ color: "⚫", level: 0, exp: 1 }),
  "普通": Object.freeze({ color: "⚪", level: 1, exp: 2 }),
  "精品": Object.freeze({ color: "🟢", level: 2, exp: 4 }),
  "稀有": Object.freeze({ color: "🔵", level: 3, exp: 8 }),
  "史诗": Object.freeze({ color: "🟣", level: 4, exp: 14 }),
  "传说": Object.freeze({ color: "🟠", level: 5, exp: 22 }),
  // 宝箱本体已经含有额外奖励；噩梦经验只补偿风险，不再成为最优刷级路线。
  "宝藏": Object.freeze({ color: "👑", level: 6, exp: 16 }),
  "噩梦": Object.freeze({ color: "💀", level: 7, exp: 18 }),
});

export const WEATHER_CONFIG = Object.freeze({
  "晴": Object.freeze({
    emoji: "☀️", weight: 28, difficultyMultiplier: 0.8, priceMultiplier: 0.8,
    expMultiplier: 0.8, weightMultiplier: 0.8,
  }),
  "多云": Object.freeze({
    emoji: "⛅", weight: 26, difficultyMultiplier: 1, priceMultiplier: 1,
    expMultiplier: 1, weightMultiplier: 1,
  }),
  "雨": Object.freeze({
    emoji: "🌧️", weight: 20, difficultyMultiplier: 1.05, priceMultiplier: 1.05,
    expMultiplier: 1.05, weightMultiplier: 1.05,
  }),
  "雾": Object.freeze({
    emoji: "🌫️", weight: 13, difficultyMultiplier: 1.1, priceMultiplier: 1.1,
    expMultiplier: 1.1, weightMultiplier: 1.1,
  }),
  "雷暴": Object.freeze({
    emoji: "⛈️", weight: 8, difficultyMultiplier: 1.2, priceMultiplier: 1.2,
    expMultiplier: 1.2, weightMultiplier: 1.2,
  }),
  "雪": Object.freeze({
    emoji: "❄️", weight: 5, difficultyMultiplier: 1.15, priceMultiplier: 1.15,
    expMultiplier: 1.15, weightMultiplier: 1.15,
  }),
});

// 钓点只筛选物种池并控制解锁顺序，不承担强度分层；未填 locations 的鱼视为全钓点通用。
// 渔获强度由鱼自身稀有度与数值决定，同稀有度不会因钓点而获得额外倍率。
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
export const BOSS_FIGHT_TIMEOUT_MS = 60 * 1000;
export const BOSS_MIN_DIFFICULTY = 220;
export const BOSS_MIN_HP = 150;
export const BOSS_MIN_ATTACK = 8;
export const BOSS_MECHANIC_TYPES = Object.freeze([
  "stamina_drain",
  "steal_coins",
  "tension_surge",
  "line_rend",
  "rod_crush",
  "regenerate",
]);
export const LOCAL_NIGHTMARE_CHANCE = 0.4;
export const NIGHTMARE_EFFECT_TYPES = Object.freeze([
  "rod_damage",
  "rod_control_loss",
  "steal_coins_flat",
  "steal_coins_percent",
  "curse",
  "nightmare_weight_multiplier",
  "steal_bait",
  "stamina_crush",
  "ghost_debt",
  "deep_pressure",
  "devour_inventory",
]);
export const LOCAL_NIGHTMARE_EFFECT_BY_LOCATION = Object.freeze({
  pond: "nightmare_weight_multiplier",
  river: "steal_bait",
  lake: "stamina_crush",
  coast: "ghost_debt",
  abyss: "deep_pressure",
  mystic: "devour_inventory",
});

// 异色个体：捕获时低概率触发的外观变体，金币与经验按倍率放大。
// 宝藏本体是宝箱（=钱）、噩梦是惩罚事件，二者不参与异色；鱼雷同理。
export const SHINY_CHANCE = 0.01;
export const SHINY_PRICE_MULTIPLIER = 4;
export const SHINY_EXP_MULTIPLIER = 4;
// 异色个体搏斗难度提升，会触及更多“拉不动/溜鱼”判定，也更难完美收竿
export const SHINY_DIFFICULTY_MULTIPLIER = 1.25;
const SHINY_EXCLUDED_RARITIES = new Set(["宝藏", "噩梦"]);
const KOI_WISH_RARITIES = new Set(["垃圾", "普通", "精品", "稀有", "史诗", "传说"]);

export function isShinyEligible(fish) {
  if (!fish || fish.isTorpedo) return false;
  if (!RARITY_CONFIG[fish.rarity]) return false;
  return !SHINY_EXCLUDED_RARITIES.has(fish.rarity);
}

export function rollShiny(fish, random = Math.random) {
  if (!isShinyEligible(fish)) return false;
  return Math.max(0, Math.min(0.999999999999, Number(random()) || 0)) < SHINY_CHANCE;
}

// 锦鲤许愿签会被下一次咬钩无条件消耗，但只对垃圾至传说的非首领鱼生效。
// 宝藏、噩梦、鱼雷和首领仍按原本规则判定，不会被许愿签强制为异色。
export function resolveKoiWishShiny(fish, hasKoiWish = false, random = Math.random) {
  const koiWishConsumed = Boolean(hasKoiWish);
  const koiWishApplied = koiWishConsumed &&
    !isBossFish(fish) &&
    !fish?.isTorpedo &&
    KOI_WISH_RARITIES.has(fish?.rarity);
  return {
    isShiny: koiWishApplied || rollShiny(fish, random),
    koiWishConsumed,
    koiWishApplied,
  };
}

export function getFishingLocationConfig(locationId) {
  return FISHING_LOCATIONS[locationId] || null;
}

function readEnvironmentNumber(config, key, fallback) {
  const value = Number(config?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

// 天气是全钓点共用的可观察变量；locationId 仅随结果返回，用于鱼种池与界面展示。
// 所有返回值都在这里归一，避免个人天气或自定义配置产生非法数值。
export function getFishingEnvironmentModifiers(
  locationId = DEFAULT_FISHING_LOCATION,
  weatherName = "多云",
) {
  const weather = WEATHER_CONFIG[weatherName] || WEATHER_CONFIG["多云"];
  return {
    locationId: FISHING_LOCATIONS[locationId] ? locationId : DEFAULT_FISHING_LOCATION,
    weatherName: WEATHER_CONFIG[weatherName] ? weatherName : "多云",
    difficultyMultiplier: Math.max(0.1, readEnvironmentNumber(weather, "difficultyMultiplier", 1)),
    priceMultiplier: Math.max(0.1, readEnvironmentNumber(weather, "priceMultiplier", 1)),
    expMultiplier: Math.max(0.1, readEnvironmentNumber(weather, "expMultiplier", 1)),
    weightMultiplier: Math.max(0.1, readEnvironmentNumber(weather, "weightMultiplier", 1)),
  };
}

export function calculateEffectiveFishWeight(actualWeight, multiplier = 1) {
  const weight = Math.max(0, Number(actualWeight) || 0);
  const numericMultiplier = Number(multiplier);
  const safeMultiplier = Number.isFinite(numericMultiplier)
    ? Math.max(0, numericMultiplier)
    : 1;
  return Math.round(weight * safeMultiplier * 100) / 100;
}

export function isBossFish(fish) {
  return fish?.is_boss === true;
}

// 首领战限时可按 Boss 单独配置（fight_timeout_seconds），未配置时用全局默认。
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
  return {
    ...selected,
    actualWeight,
    effectiveWeight: actualWeight,
    isBoss: true,
  };
}

export function calculateBossLineDurability(lineCapacity) {
  const capacity = Math.max(0, Number(lineCapacity) || 0);
  return Math.max(20, Math.round(20 + capacity));
}

// Boss 鱼线耐久只存在于当前战斗，会话结束后不写入玩家数据。
export function resolveBossLineDamage({
  currentDurability,
  maxDurability,
  damage,
  protectFromBreak = false,
} = {}) {
  const safeMax = Math.max(1, Math.floor(Number(maxDurability) || 1));
  const safeCurrent = Math.max(
    0,
    Math.min(safeMax, Math.floor(Number(currentDurability) || 0)),
  );
  const safeDamage = Math.max(0, Math.floor(Number(damage) || 0));

  if (safeDamage <= 0) {
    return {
      applied: false,
      isBroken: safeCurrent <= 0,
      breakPrevented: false,
      currentDurability: safeCurrent,
      maxDurability: safeMax,
    };
  }

  const nextDurability = Math.max(0, safeCurrent - safeDamage);
  if (nextDurability > 0) {
    return {
      applied: true,
      isBroken: false,
      breakPrevented: false,
      currentDurability: nextDurability,
      maxDurability: safeMax,
    };
  }

  if (protectFromBreak) {
    return {
      applied: true,
      isBroken: false,
      breakPrevented: true,
      currentDurability: 1,
      maxDurability: safeMax,
    };
  }

  return {
    applied: true,
    isBroken: true,
    breakPrevented: false,
    currentDurability: 0,
    maxDurability: safeMax,
  };
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
const WEATHER_BY_HOUR = new Map();

// 每个小时首次读取时随机生成并缓存；同一进程、同一小时内全局一致，但未来天气无法提前计算。
export function getWeatherByTime(timestamp = Date.now()) {
  const hourIndex = Math.floor((Number(timestamp) || 0) / WEATHER_ROTATION_MS);
  if (!WEATHER_BY_HOUR.has(hourIndex)) {
    const pool = Object.keys(WEATHER_CONFIG);
    const weights = pool.map((name) => WEATHER_CONFIG[name].weight);
    WEATHER_BY_HOUR.set(hourIndex, selectRarityByWeight(pool, weights));
    if (WEATHER_BY_HOUR.size > 4) {
      const oldestHour = Math.min(...WEATHER_BY_HOUR.keys());
      WEATHER_BY_HOUR.delete(oldestHour);
    }
  }
  const name = WEATHER_BY_HOUR.get(hourIndex);
  return { name, emoji: WEATHER_CONFIG[name].emoji };
}

const REGULAR_RARITIES = Object.freeze(["垃圾", "普通", "精品", "稀有", "史诗", "传说"]);
const ALL_RARITIES = Object.freeze([...REGULAR_RARITIES, "宝藏", "噩梦"]);
const CURRENT_RARITY_WEIGHT = 50;
const UPGRADE_RARITY_WEIGHT = 12.5;
const SPECIAL_RARITY_WEIGHT = 5;

// tierCount 个稀有度按从低到高的 1:2:4... 分配：越接近当前档，权重越高。
// 从当前档向下看即为 2:1:0.5...，用公式生成以避免手填小数破坏比例。
function distributeDescendingTierWeights(totalWeight, tierCount) {
  if (tierCount <= 0) return [];
  const ratioTotal = 2 ** tierCount - 1;
  return Array.from(
    { length: tierCount },
    (_, index) => totalWeight * (2 ** index) / ratioTotal,
  );
}

function createStandardBaitWeights(currentTierIndex) {
  const hasUpgradeTier = currentTierIndex < REGULAR_RARITIES.length - 1;
  const reservedWeight = (
    CURRENT_RARITY_WEIGHT +
    (hasUpgradeTier ? UPGRADE_RARITY_WEIGHT : 0) +
    SPECIAL_RARITY_WEIGHT * 2
  );
  const lowerTierWeights = distributeDescendingTierWeights(
    100 - reservedWeight,
    currentTierIndex,
  );
  const regularPoolEnd = currentTierIndex + (hasUpgradeTier ? 2 : 1);

  return [
    [...REGULAR_RARITIES.slice(0, regularPoolEnd), "宝藏", "噩梦"],
    [
      ...lowerTierWeights,
      CURRENT_RARITY_WEIGHT,
      ...(hasUpgradeTier ? [UPGRADE_RARITY_WEIGHT] : []),
      SPECIAL_RARITY_WEIGHT,
      SPECIAL_RARITY_WEIGHT,
    ],
  ];
}

// 普通鱼饵：当前档 50、越一级 12.5、宝藏/噩梦各 5；余量向低档逐级减半。
// 神之诱饵的当前档已是传说，没有常规越级档，因此余下 40 全部分配给史诗及以下。
// 寻宝鱼饵：宝藏 50、噩梦 5，其余 45 从传说向下按 2:1:0.5... 分配。
const QUALITY_WEIGHTS = Object.freeze({
  1: createStandardBaitWeights(1),
  2: createStandardBaitWeights(2),
  3: createStandardBaitWeights(3),
  4: createStandardBaitWeights(4),
  5: createStandardBaitWeights(5),
  6: [
    ALL_RARITIES,
    [
      ...distributeDescendingTierWeights(45, REGULAR_RARITIES.length),
      50,
      5,
    ],
  ],
});

const FISHING_LEVEL_EXP_BASE = 24;
export const PERFECT_CATCH_WINDOW_MS = 5000;
export const PERFECT_EXP_MULTIPLIER = 2;
export const NIGHTMARE_CURSE_HIDDEN_LAYERS = 2;
// 亡者船票：放款额＝初始债务，每竿未清部分按利率滚一次，滚到上限即勾销并留下抽成印记。
export const GHOST_DEBT_PRINCIPAL = 400;
export const GHOST_DEBT_INTEREST_RATE = 1.25;
export const GHOST_DEBT_WRITE_OFF_THRESHOLD = 800;
export const GHOST_DEBT_MARK_PENALTY_RATE = 0.25;
export const FISHING_COOLDOWN_SECONDS = 5 * 60;
export const FISHING_TIME_SAND_COOLDOWN_SECONDS = FISHING_COOLDOWN_SECONDS / 2;
export const FISHING_BENEFIT_DURATION_SECONDS = 35 * 60;
export const FISHING_BITE_WAIT_MAX_SECONDS = 120;
export const FISHING_BITE_WAIT_REDUCTION_PER_LEVEL_SECONDS = 3;
export const FISHING_STAMINA_BASE = 10;
export const FISHING_STAMINA_PER_LEVEL = 1;
// 保留旧导出名作为 1 级/新玩家的初始体力上限。
export const FISHING_STAMINA_MAX = FISHING_STAMINA_BASE;
export const FISHING_STAMINA_COST = 1;
export const FISHING_STAMINA_RECOVERY_MS = 30 * 60 * 1000;
export const FORCE_PULL_DIFFICULTY_RANGE = 50;
export const NORMAL_TUG_SUCCESS_MULTIPLIER = 2;
// 每场普通溜鱼额外抽取半个强拉判定区间的爆发压力。
// 精准操作可处理“差值 + 压力 < 50”的场次，因此理论成功率恰好是强拉的 2 倍并封顶 100%。
export const NORMAL_TUG_PRESSURE_RANGE = (
  FORCE_PULL_DIFFICULTY_RANGE / NORMAL_TUG_SUCCESS_MULTIPLIER
);
export const TORPEDO_HOOK_WEIGHT_PER_ITEM = 3;
export const TORPEDO_ROD_DAMAGE = 20;
export const TORPEDO_PRICE_BOOST_MULTIPLIER = 1.5;

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

export function getFishingStaminaCost() {
  return FISHING_STAMINA_COST;
}

export function resolveNightmareRarityAfflictions(curseLayers = 0) {
  const curseActive = Math.max(0, Math.floor(Number(curseLayers) || 0)) > 0;
  return {
    consumeCurse: curseActive,
  };
}

// 亡者船票＝高利贷：当场放款 400 并欠下等额本金，之后每抛一竿，未还清的部分
// 就利滚利一次；滚到上限即一笔勾销，改为留下永久抽成印记，避免债务发散到还不完。
export function calculateGhostDebtPayment(earnings, debt, {
  hasGhostMark = false,
  accrueInterest = false,
} = {}) {
  const grossEarnings = Math.max(0, Math.floor(Number(earnings) || 0));
  const safeDebt = Math.max(0, Math.floor(Number(debt) || 0));
  // 印记先抽成，债务再从抽成后的收益里全额扣除。
  const earningsAfterMark = hasGhostMark
    ? Math.floor(grossEarnings * (1 - GHOST_DEBT_MARK_PENALTY_RATE))
    : grossEarnings;
  const debtPaid = Math.min(earningsAfterMark, safeDebt);
  const debtAfterPayment = safeDebt - debtPaid;
  // 勾销只能由「真的滚了一次利息、且滚动值触及上限」触发：放贷当竿不计息、
  // 或已还清，都不撕借条——否则二次借贷把债务叠到上限会被误判为当场勾销。
  let remainingDebt = debtAfterPayment;
  let interestAdded = 0;
  let writtenOff = false;
  if (accrueInterest && debtAfterPayment > 0) {
    const rolled = Math.ceil(debtAfterPayment * GHOST_DEBT_INTEREST_RATE);
    if (rolled >= GHOST_DEBT_WRITE_OFF_THRESHOLD) {
      writtenOff = true;
      remainingDebt = 0;
    } else {
      remainingDebt = rolled;
      interestAdded = rolled - debtAfterPayment;
    }
  }
  return {
    grossEarnings,
    markDeducted: grossEarnings - earningsAfterMark,
    earningsAfterMark,
    earnings: earningsAfterMark - debtPaid,
    debtPaid,
    debtAfterPayment,
    interestAdded,
    remainingDebt,
    writtenOff,
  };
}

export function calculateCorpseFisherRodDamage(stamina, maximum = 20) {
  const safeStamina = Math.max(0, Math.floor(Number(stamina) || 0));
  const safeMaximum = Math.max(0, Math.floor(Number(maximum) || 0));
  return Math.min(safeStamina, safeMaximum);
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

export function calculateForcePullSuccessRate(fishDifficulty, effectiveControl) {
  const difficulty = Math.max(0, Number(fishDifficulty) || 0);
  const control = Math.max(0, Number(effectiveControl) || 0);
  if (difficulty <= control) return 1;
  return Math.max(
    0,
    1 - (difficulty - control) / FORCE_PULL_DIFFICULTY_RANGE,
  );
}

export function calculateNormalTugSuccessRate(fishDifficulty, effectiveControl) {
  return Math.min(
    1,
    calculateForcePullSuccessRate(fishDifficulty, effectiveControl) *
      NORMAL_TUG_SUCCESS_MULTIPLIER,
  );
}

export function rollNormalTugPressure(random = Math.random) {
  const roll = Math.max(
    0,
    Math.min(0.999999999999, Number(random()) || 0),
  );
  return roll * NORMAL_TUG_PRESSURE_RANGE;
}

// 普通渔获与首领共用本公式，只看“鱼困难度 - 当前控制力”。
// 拉距在有效差值达到 50 时归零，形成不可跨越的硬门槛。
export function calculateNormalTugActionEffects({
  fishDifficulty,
  effectiveControl,
  pressure = 0,
  stateId = FISH_FIGHT_STATE.calm,
  action,
} = {}) {
  const difficulty = Math.max(0, Number(fishDifficulty) || 0);
  const control = Math.max(0, Number(effectiveControl) || 0);
  const safePressure = Math.max(
    0,
    Math.min(NORMAL_TUG_PRESSURE_RANGE, Number(pressure) || 0),
  );
  const effectiveGap = Math.max(0, difficulty - control) + safePressure;
  const boundedGap = Math.min(FORCE_PULL_DIFFICULTY_RANGE, effectiveGap);

  if (action === "pull") {
    const remainingMargin = FORCE_PULL_DIFFICULTY_RANGE - effectiveGap;
    const distanceEffect = remainingMargin > 0
      ? 7 + Math.floor(remainingMargin / 8)
      : 0;
    const tensionEffect = 12 + Math.floor(boundedGap / 6);
    return applyFishFightStateModifiers({
      stateId,
      action,
      distanceEffect,
      tensionEffect,
    });
  }

  if (action === "loosen") {
    const distanceEffect = 3 + Math.floor(boundedGap / 25);
    const tensionEffect = 30 - Math.floor(boundedGap / 10);
    return applyFishFightStateModifiers({
      stateId,
      action,
      distanceEffect,
      tensionEffect,
    });
  }

  throw new TypeError(`未知的普通溜鱼操作：${action}`);
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

// 玩家看到的诅咒层数会少报两层，但真实诅咒未清零时至少显示 1 层：
// 表面会卡在 1 层连续三竿，让玩家以为下一竿就解脱。
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

// 花嫁状态沿用旧版累计倍率存储；对玩家展示时换算回每次遭遇增加的一层印记。
export function getBrideMarkLayers(multiplier) {
  const numericMultiplier = Number(multiplier);
  const safeMultiplier = Number.isFinite(numericMultiplier)
    ? Math.max(1, numericMultiplier)
    : 1;
  return safeMultiplier > 1 ? Math.max(1, Math.round(Math.log2(safeMultiplier))) : 0;
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

export function getRarityPoolByBaitQuality(
  quality,
  hasDebuff = false,
  treasureWeightMultiplier = 1,
  nightmareBonus = 0,
  nightmareWeightMultiplier = 1,
  zeroWeightRarities = [],
) {
  const [configuredPool, configuredWeights] = QUALITY_WEIGHTS[quality] || QUALITY_WEIGHTS[1];
  const pool = [...configuredPool];
  const weights = [...configuredWeights];
  const treasureIndex = pool.indexOf("宝藏");
  const nightmareIndex = pool.indexOf("噩梦");

  if (treasureIndex >= 0) {
    const numericMultiplier = Number(treasureWeightMultiplier);
    const multiplier = Number.isFinite(numericMultiplier)
      ? Math.max(1, numericMultiplier)
      : 1;
    weights[treasureIndex] *= multiplier;
  }
  // 最终顺序：宝藏猎人倍率 → 花嫁连乘 → 骷髅诅咒转移全部宝藏 → 怪物诱饵加权 → 雾灯归零。
  if (nightmareIndex >= 0) {
    const multiplier = Math.max(1, Number(nightmareWeightMultiplier) || 1);
    weights[nightmareIndex] *= multiplier;
  }
  if (hasDebuff && treasureIndex >= 0 && nightmareIndex >= 0) {
    weights[nightmareIndex] += weights[treasureIndex];
    weights[treasureIndex] = 0;
  }
  if (nightmareIndex >= 0 && Number.isFinite(Number(nightmareBonus))) {
    weights[nightmareIndex] = Math.max(
      0.5,
      weights[nightmareIndex] + Number(nightmareBonus),
    );
  }
  // 雾灯等最终覆盖效果最后结算：环境、怪物诱饵、诅咒和花嫁都算完后，
  // 指定品质的权重仍会被强制清零。
  for (const rarity of Array.isArray(zeroWeightRarities) ? zeroWeightRarities : []) {
    const index = pool.indexOf(rarity);
    if (index >= 0) weights[index] = 0;
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
      !Array.isArray(fish?.locations) || !fish.locations.includes(location)
    ));

    // 当地怪谈固定占 40%；其余 60% 在所有其他噩梦（含其他地点怪谈）之间均分。
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
    treasureWeightMultiplier = 1,
    nightmareBonus = 0,
    nightmareWeightMultiplier = 1,
    zeroWeightRarities = [],
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
    treasureWeightMultiplier,
    nightmareBonus,
    nightmareWeightMultiplier,
    zeroWeightRarities,
  );
  // 星愿瓶等道具可强制指定本次稀有度，跳过权重摇取
  const rarity = forceRarity && RARITY_CONFIG[forceRarity]
    ? forceRarity
    : selectRarityByWeight(pool, weights, random);
  let candidates = fishData.filter((fish) => (
    !isBossFish(fish) &&
    fish.rarity === rarity &&
    (rarity === "噩梦" || isFishAtLocation(fish, location)) &&
    isFishActiveAtHour(fish, hour) &&
    isFishActiveInWeather(fish, weather)
  ));
  if (candidates.length === 0) {
    // 天气把该稀有度过滤空时退回无天气池，保证钓鱼永远有产出；
    // 钓点约束不参与兜底，避免限定鱼漏到其他钓点
    candidates = fishData.filter((fish) => (
      !isBossFish(fish) &&
      fish.rarity === rarity &&
      (rarity === "噩梦" || isFishAtLocation(fish, location)) &&
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
    effectiveWeight: actualWeight,
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

// 首领的金币、经验和当地宝箱组成独立奖励包；异色是唯一收益倍率例外。
export function calculateBossCatchReward(fish) {
  if (!isBossFish(fish)) throw new TypeError("只能结算首领渔获奖励");
  const shiny = Boolean(fish.isShiny);
  return {
    earnings: Math.round(
      calculateLegacyFishPrice(fish) * (shiny ? SHINY_PRICE_MULTIPLIER : 1),
    ),
    expGain: Math.max(1, Math.floor(
      (Number(fish.boss_exp) || 1) * (shiny ? SHINY_EXP_MULTIPLIER : 1),
    )),
    rewardItemId: String(fish.reward_chest_id || "").trim(),
    rewardItemCount: 1,
  };
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
      if (!Number.isSafeInteger(fish.boss_exp) || fish.boss_exp <= 0) {
        errors.push(`${label}: 首领固定经验无效`);
      }
      if (typeof fish.reward_chest_id !== "string" || !fish.reward_chest_id.trim()) {
        errors.push(`${label}: 首领当地宝箱奖励无效`);
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
      fish?.fight_timeout_seconds != null ||
      fish?.boss_exp != null ||
      fish?.reward_chest_id != null
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
    } else if (localBosses[0].reward_chest_id !== `chest_${locationId}`) {
      errors.push(`${locationConfig.name}: 首领须奖励当地宝箱 chest_${locationId}`);
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
