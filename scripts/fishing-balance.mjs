import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

import {
  BOSS_ATTACK_INTERVAL_MS,
  BOSS_PLAYER_ATTACK_COOLDOWN_MS,
  FISH_FIGHT_STATE,
  FISHING_LOCATIONS,
  FORCE_PULL_DIFFICULTY_RANGE,
  LOCAL_NIGHTMARE_CHANCE,
  NORMAL_TUG_SUCCESS_MULTIPLIER,
  WEATHER_CONFIG,
  calculateBossLineDurability,
  calculateEffectiveFishWeight,
  calculateLegacyFishPrice,
  calculateNormalTugActionEffects,
  getBossFightTimeoutMs,
  getFishFightStateChangeDelay,
  getFishingStaminaCost,
  getFishingStaminaMax,
  getRarityPoolByBaitQuality,
  resolveBossAttack,
  rollBossPlayerDamage,
  rollNormalTugPressure,
  selectNextFishFightState,
} from "../plugins/sakura-plugin/lib/fishing/rules.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(scriptDir, "..");
export const fishDataPath = path.join(
  projectRoot,
  "plugins/sakura-plugin/resources/fish/fish.json",
);
export const shopDataPath = path.join(
  projectRoot,
  "plugins/sakura-plugin/resources/economy/shop.yaml",
);

export const REGULAR_RARITIES = Object.freeze([
  "垃圾",
  "普通",
  "精品",
  "稀有",
  "史诗",
  "传说",
]);
export const GEAR_RARITIES = Object.freeze(REGULAR_RARITIES.slice(1));
export const EXCLUDED_NORMAL_RARITIES = new Set(["宝藏", "噩梦"]);
export const NEUTRAL_WEATHER = "多云";
export const BAIT_TARGET_ROIS = Object.freeze([
  0.25,
  0.1875,
  0.125,
  0.0625,
  0,
]);

export function loadFishingBalanceData() {
  return {
    fishData: JSON.parse(fs.readFileSync(fishDataPath, "utf8")),
    shop: yaml.load(fs.readFileSync(shopDataPath, "utf8")),
  };
}

export function getBaseEquipment(shop) {
  const rods = shop.categories.rods.items.slice(0, 5);
  const lines = shop.categories.lines.items.slice(0, 5);
  return rods.map((rod, index) => ({
    tier: index + 1,
    rarity: GEAR_RARITIES[index],
    rodId: rod.id,
    lineId: lines[index].id,
    control: Number(rod.control),
    capacity: Number(lines[index].capacity),
  }));
}

export function linePassAtWeight(weight, capacity) {
  const safeWeight = Math.max(0, Number(weight) || 0);
  const safeCapacity = Math.max(0, Number(capacity) || 0);
  if (safeCapacity <= 0) return 0;
  if (safeWeight <= safeCapacity) return 1;
  if (safeWeight >= safeCapacity * 2) return 0;
  return 2 - safeWeight / safeCapacity;
}

export function lineStableProbability([minimum, maximum], capacity, multiplier = 1) {
  const low = Number(minimum) * multiplier;
  const high = Number(maximum) * multiplier;
  if (high <= capacity) return 1;
  if (low >= capacity) return 0;
  return (capacity - low) / (high - low);
}

export function linePassProbability([minimum, maximum], capacity, multiplier = 1) {
  const low = Number(minimum) * multiplier;
  const high = Number(maximum) * multiplier;
  if (high === low) return linePassAtWeight(low, capacity);

  let area = Math.max(0, Math.min(high, capacity) - low);
  const riskyMinimum = Math.max(low, capacity);
  const riskyMaximum = Math.min(high, capacity * 2);
  if (riskyMaximum > riskyMinimum) {
    area += (
      linePassAtWeight(riskyMinimum, capacity) +
      linePassAtWeight(riskyMaximum, capacity)
    ) * (riskyMaximum - riskyMinimum) / 2;
  }
  return area / (high - low);
}

export function difficultyStableProbability(difficulty, control, multiplier = 1) {
  return Math.round(Number(difficulty) * multiplier) <= control ? 1 : 0;
}

export function difficultyForcePassProbability(
  difficulty,
  control,
  multiplier = 1,
) {
  const effectiveDifficulty = Math.max(
    0,
    Math.round(Number(difficulty) * multiplier),
  );
  if (effectiveDifficulty <= control) return 1;
  return Math.max(
    0,
    1 - (effectiveDifficulty - control) / FORCE_PULL_DIFFICULTY_RANGE,
  );
}

export function difficultyTugPassProbability(
  difficulty,
  control,
  multiplier = 1,
) {
  return Math.min(
    1,
    difficultyForcePassProbability(difficulty, control, multiplier) *
      NORMAL_TUG_SUCCESS_MULTIPLIER,
  );
}

function isFishAtLocation(fish, locationId) {
  return (
    !Array.isArray(fish.locations) ||
    fish.locations.length === 0 ||
    fish.locations.includes(locationId)
  );
}

function isFishActiveAtHour(fish, hour) {
  if (!Array.isArray(fish.active_hours) || fish.active_hours.length === 0) {
    return true;
  }
  return fish.active_hours.some(([start, end]) => (
    start <= end
      ? hour >= start && hour < end
      : hour >= start || hour < end
  ));
}

function isFishActiveInWeather(fish, weatherName) {
  return (
    !Array.isArray(fish.weather) ||
    fish.weather.length === 0 ||
    fish.weather.includes(weatherName)
  );
}

export function getRuntimeCandidates(
  fishData,
  rarity,
  location,
  hour,
  weatherName = NEUTRAL_WEATHER,
) {
  const baseFilter = (fish) => (
    !fish.is_boss &&
    fish.rarity === rarity &&
    isFishAtLocation(fish, location) &&
    isFishActiveAtHour(fish, hour)
  );
  let candidates = fishData.filter((fish) => (
    baseFilter(fish) && isFishActiveInWeather(fish, weatherName)
  ));
  if (candidates.length === 0) {
    candidates = fishData.filter(baseFilter);
  }
  return candidates;
}

export function getFishCheckMetrics(
  fish,
  equipment,
  weatherName = NEUTRAL_WEATHER,
) {
  const weather = WEATHER_CONFIG[weatherName] || WEATHER_CONFIG[NEUTRAL_WEATHER];
  const weightMultiplier = Number(weather.weightMultiplier) || 1;
  const difficultyMultiplier = Number(weather.difficultyMultiplier) || 1;
  const weightStable = lineStableProbability(
    fish.weight,
    equipment.capacity,
    weightMultiplier,
  );
  const weightPass = linePassProbability(
    fish.weight,
    equipment.capacity,
    weightMultiplier,
  );
  const difficultyStable = difficultyStableProbability(
    fish.difficulty,
    equipment.control,
    difficultyMultiplier,
  );
  const difficultyForcePass = difficultyForcePassProbability(
    fish.difficulty,
    equipment.control,
    difficultyMultiplier,
  );
  const difficultyTugPass = difficultyTugPassProbability(
    fish.difficulty,
    equipment.control,
    difficultyMultiplier,
  );

  return {
    weightStable,
    weightPass,
    difficultyStable,
    difficultyForcePass,
    difficultyTugPass,
    doubleStable: weightStable * difficultyStable,
    forceCatch: weightPass * difficultyForcePass,
    tugCatch: weightPass * difficultyTugPass,
  };
}

function createEmptyMetricTotals() {
  return {
    weightStable: 0,
    weightPass: 0,
    difficultyStable: 0,
    difficultyForcePass: 0,
    difficultyTugPass: 0,
    doubleStable: 0,
    forceCatch: 0,
    tugCatch: 0,
  };
}

function addMetrics(target, source, multiplier = 1) {
  for (const key of Object.keys(target)) {
    target[key] += source[key] * multiplier;
  }
  return target;
}

function divideMetrics(metrics, divisor) {
  return Object.fromEntries(
    Object.entries(metrics).map(([key, value]) => [key, value / divisor]),
  );
}

export function averageCandidateMetrics(
  candidates,
  equipment,
  weatherName = NEUTRAL_WEATHER,
) {
  if (candidates.length === 0) {
    throw new Error("候选鱼池不能为空");
  }
  const totals = createEmptyMetricTotals();
  for (const fish of candidates) {
    addMetrics(totals, getFishCheckMetrics(fish, equipment, weatherName));
  }
  return divideMetrics(totals, candidates.length);
}

export function evaluateRarityRuntime(
  fishData,
  rarity,
  equipment,
  {
    weatherNames = [NEUTRAL_WEATHER],
    weatherWeighted = false,
    locations = Object.keys(FISHING_LOCATIONS),
    hours = Array.from({ length: 24 }, (_, hour) => hour),
  } = {},
) {
  const totals = createEmptyMetricTotals();
  const locationTotals = new Map();
  const scenarios = [];
  let totalWeight = 0;

  for (const location of locations) {
    const currentLocationTotals = createEmptyMetricTotals();
    let locationWeight = 0;
    for (const hour of hours) {
      for (const weatherName of weatherNames) {
        const scenarioWeight = weatherWeighted
          ? Number(WEATHER_CONFIG[weatherName]?.weight) || 0
          : 1;
        if (scenarioWeight <= 0) continue;
        const candidates = getRuntimeCandidates(
          fishData,
          rarity,
          location,
          hour,
          weatherName,
        );
        const metrics = averageCandidateMetrics(
          candidates,
          equipment,
          weatherName,
        );
        addMetrics(totals, metrics, scenarioWeight);
        addMetrics(currentLocationTotals, metrics, scenarioWeight);
        totalWeight += scenarioWeight;
        locationWeight += scenarioWeight;
        scenarios.push({
          location,
          hour,
          weather: weatherName,
          candidateCount: candidates.length,
          ...metrics,
        });
      }
    }
    locationTotals.set(
      location,
      divideMetrics(currentLocationTotals, locationWeight),
    );
  }

  return {
    average: divideMetrics(totals, totalWeight),
    byLocation: Object.fromEntries(locationTotals),
    scenarios,
  };
}

function getNightmareRuntimeCandidates(
  fishData,
  hour,
  weatherName = NEUTRAL_WEATHER,
) {
  const baseFilter = (fish) => (
    !fish.is_boss &&
    fish.rarity === "噩梦" &&
    isFishActiveAtHour(fish, hour)
  );
  let candidates = fishData.filter((fish) => (
    baseFilter(fish) && isFishActiveInWeather(fish, weatherName)
  ));
  if (candidates.length === 0) candidates = fishData.filter(baseFilter);
  return candidates;
}

function averageNightmareMetrics(
  candidates,
  location,
  equipment,
  weatherName,
) {
  const local = candidates.filter((fish) => (
    Array.isArray(fish.locations) && fish.locations.includes(location)
  ));
  const other = candidates.filter((fish) => (
    !Array.isArray(fish.locations) || !fish.locations.includes(location)
  ));
  if (local.length === 0 || other.length === 0) {
    return averageCandidateMetrics(candidates, equipment, weatherName);
  }

  const metrics = createEmptyMetricTotals();
  addMetrics(
    metrics,
    averageCandidateMetrics(local, equipment, weatherName),
    LOCAL_NIGHTMARE_CHANCE,
  );
  addMetrics(
    metrics,
    averageCandidateMetrics(other, equipment, weatherName),
    1 - LOCAL_NIGHTMARE_CHANCE,
  );
  return metrics;
}

export function evaluateNightmareRuntime(
  fishData,
  equipment,
  {
    weatherNames = [NEUTRAL_WEATHER],
    weatherWeighted = false,
    locations = Object.keys(FISHING_LOCATIONS),
    hours = Array.from({ length: 24 }, (_, hour) => hour),
  } = {},
) {
  const totals = createEmptyMetricTotals();
  const locationTotals = new Map();
  const scenarios = [];
  let totalWeight = 0;

  for (const location of locations) {
    const currentLocationTotals = createEmptyMetricTotals();
    let locationWeight = 0;
    for (const hour of hours) {
      for (const weatherName of weatherNames) {
        const scenarioWeight = weatherWeighted
          ? Number(WEATHER_CONFIG[weatherName]?.weight) || 0
          : 1;
        if (scenarioWeight <= 0) continue;
        const candidates = getNightmareRuntimeCandidates(
          fishData,
          hour,
          weatherName,
        );
        const metrics = averageNightmareMetrics(
          candidates,
          location,
          equipment,
          weatherName,
        );
        addMetrics(totals, metrics, scenarioWeight);
        addMetrics(currentLocationTotals, metrics, scenarioWeight);
        totalWeight += scenarioWeight;
        locationWeight += scenarioWeight;
        scenarios.push({
          location,
          hour,
          weather: weatherName,
          candidateCount: candidates.length,
          ...metrics,
        });
      }
    }
    locationTotals.set(
      location,
      divideMetrics(currentLocationTotals, locationWeight),
    );
  }

  return {
    average: divideMetrics(totals, totalWeight),
    byLocation: Object.fromEntries(locationTotals),
    scenarios,
  };
}

function getNormalBaitEntries(quality) {
  const { pool, weights } = getRarityPoolByBaitQuality(quality);
  const entries = pool
    .map((rarity, index) => ({ rarity, weight: weights[index] }))
    .filter(({ rarity }) => !EXCLUDED_NORMAL_RARITIES.has(rarity));
  const normalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  return entries.map((entry) => ({
    ...entry,
    probability: entry.weight / normalWeight,
  }));
}

export function evaluateAlignedBaitRuntime(
  fishData,
  equipment,
  quality,
  {
    weatherNames = [NEUTRAL_WEATHER],
    weatherWeighted = false,
    locations = Object.keys(FISHING_LOCATIONS),
    hours = Array.from({ length: 24 }, (_, hour) => hour),
  } = {},
) {
  const baitEntries = getNormalBaitEntries(quality);
  const totals = createEmptyMetricTotals();
  const locationTotals = new Map();
  const scenarios = [];
  let totalWeight = 0;

  for (const location of locations) {
    const currentLocationTotals = createEmptyMetricTotals();
    let locationWeight = 0;
    for (const hour of hours) {
      for (const weatherName of weatherNames) {
        const scenarioWeight = weatherWeighted
          ? Number(WEATHER_CONFIG[weatherName]?.weight) || 0
          : 1;
        if (scenarioWeight <= 0) continue;
        const metrics = createEmptyMetricTotals();
        for (const baitEntry of baitEntries) {
          const candidates = getRuntimeCandidates(
            fishData,
            baitEntry.rarity,
            location,
            hour,
            weatherName,
          );
          const candidateMetrics = averageCandidateMetrics(
            candidates,
            equipment,
            weatherName,
          );
          addMetrics(metrics, candidateMetrics, baitEntry.probability);
        }
        addMetrics(totals, metrics, scenarioWeight);
        addMetrics(currentLocationTotals, metrics, scenarioWeight);
        totalWeight += scenarioWeight;
        locationWeight += scenarioWeight;
        scenarios.push({
          location,
          hour,
          weather: weatherName,
          ...metrics,
        });
      }
    }
    locationTotals.set(
      location,
      divideMetrics(currentLocationTotals, locationWeight),
    );
  }

  return {
    baitEntries,
    average: divideMetrics(totals, totalWeight),
    byLocation: Object.fromEntries(locationTotals),
    scenarios,
  };
}

export function createBalanceReport(
  fishData,
  shop,
  {
    weatherNames = [NEUTRAL_WEATHER],
    weatherWeighted = false,
  } = {},
) {
  const equipment = getBaseEquipment(shop);
  return equipment.map((currentEquipment, index) => {
    const aligned = evaluateAlignedBaitRuntime(
      fishData,
      currentEquipment,
      index + 1,
      { weatherNames, weatherWeighted },
    );
    const sameTier = evaluateRarityRuntime(
      fishData,
      GEAR_RARITIES[index],
      currentEquipment,
      { weatherNames, weatherWeighted },
    );
    return {
      tier: index + 1,
      rarity: GEAR_RARITIES[index],
      equipment: currentEquipment,
      aligned,
      sameTier,
    };
  });
}

export function getRoundedWeightSamples([minimum, maximum]) {
  const low = Number(minimum);
  const high = Number(maximum);
  const width = high - low;
  if (width === 0) return [{ weight: low, probability: 1 }];

  const samples = [];
  for (
    let cent = Math.floor(low * 100) - 2;
    cent <= Math.ceil(high * 100) + 2;
    cent += 1
  ) {
    const weight = cent / 100;
    const intervalLength = Math.max(
      0,
      Math.min(high, weight + 0.005) - Math.max(low, weight - 0.005),
    );
    if (intervalLength > 1e-14) {
      samples.push({ weight, probability: intervalLength / width });
    }
  }
  return samples;
}

export function getFishCoinExpectation(
  fish,
  equipment,
  weatherName = NEUTRAL_WEATHER,
) {
  const weather = WEATHER_CONFIG[weatherName] || WEATHER_CONFIG[NEUTRAL_WEATHER];
  const difficultyPass = difficultyForcePassProbability(
    fish.difficulty,
    equipment.control,
    weather.difficultyMultiplier,
  );
  let catchProbability = 0;
  let expectedRevenue = 0;

  for (const sample of getRoundedWeightSamples(fish.weight)) {
    const actualWeight = sample.weight;
    const effectiveWeight = calculateEffectiveFishWeight(
      actualWeight,
      weather.weightMultiplier,
    );
    const weightPass = linePassAtWeight(effectiveWeight, equipment.capacity);
    const caughtSampleProbability = (
      sample.probability * weightPass * difficultyPass
    );
    catchProbability += caughtSampleProbability;
    expectedRevenue += caughtSampleProbability * calculateLegacyFishPrice(
      { ...fish, actualWeight },
      weather.priceMultiplier,
    );
  }

  return {
    catchProbability,
    expectedRevenue,
    successfulCatchValue: catchProbability > 0
      ? expectedRevenue / catchProbability
      : 0,
  };
}

function selectIntegerPrice(expectedRevenue, targetRoi) {
  const rawPrice = expectedRevenue / (1 + targetRoi);
  const center = Math.max(1, Math.round(rawPrice));
  const candidates = new Set();
  for (let offset = -2; offset <= 2; offset += 1) {
    candidates.add(Math.max(1, center + offset));
  }
  return [...candidates]
    .map((price) => ({
      price,
      roi: expectedRevenue / price - 1,
    }))
    .sort((left, right) => (
      Math.abs(left.roi - targetRoi) - Math.abs(right.roi - targetRoi) ||
      left.price - right.price
    ))[0];
}

export function evaluateBaitEconomics(
  fishData,
  shop,
  {
    targetRois = BAIT_TARGET_ROIS,
    weatherNames = [NEUTRAL_WEATHER],
    weatherWeighted = false,
    locations = Object.keys(FISHING_LOCATIONS),
    hours = Array.from({ length: 24 }, (_, hour) => hour),
  } = {},
) {
  const equipment = getBaseEquipment(shop);
  const baits = shop.categories.baits.items
    .filter((bait) => !bait.boss_bait && Number(bait.quality) <= 5)
    .sort((left, right) => left.quality - right.quality);
  const fishMetricCache = new Map();

  return baits.map((bait, baitIndex) => {
    const currentEquipment = equipment[bait.quality - 1];
    const { pool, weights } = getRarityPoolByBaitQuality(bait.quality);
    const totalRarityWeight = weights.reduce(
      (sum, weight) => sum + Math.max(0, Number(weight) || 0),
      0,
    );
    let totalScenarioWeight = 0;
    let expectedRevenue = 0;
    let coinCatchProbability = 0;
    let specialProbability = 0;

    for (const location of locations) {
      for (const hour of hours) {
        for (const weatherName of weatherNames) {
          const scenarioWeight = weatherWeighted
            ? Number(WEATHER_CONFIG[weatherName]?.weight) || 0
            : 1;
          if (scenarioWeight <= 0) continue;
          let scenarioRevenue = 0;
          let scenarioCoinCatchProbability = 0;
          let scenarioSpecialProbability = 0;

          for (let rarityIndex = 0; rarityIndex < pool.length; rarityIndex += 1) {
            const rarity = pool[rarityIndex];
            const rarityWeight = Math.max(
              0,
              Number(weights[rarityIndex]) || 0,
            );
            if (EXCLUDED_NORMAL_RARITIES.has(rarity)) {
              scenarioSpecialProbability += rarityWeight / totalRarityWeight;
              continue;
            }
            // 宝藏与噩梦不进入“常规捕获率”的成功/失败分母，但仍消耗
            // 一枚鱼饵。其额外收益与损失按本轮口径记为 0，因此这里保留
            // 原始抽取概率，不把其余常规稀有度重新放大到 100%。
            const rarityProbability = rarityWeight / totalRarityWeight;
            const candidates = getRuntimeCandidates(
              fishData,
              rarity,
              location,
              hour,
              weatherName,
            );
            let rarityRevenue = 0;
            let rarityCatchProbability = 0;
            for (const fish of candidates) {
              const cacheKey = [
                fish.id,
                currentEquipment.tier,
                weatherName,
              ].join(":");
              if (!fishMetricCache.has(cacheKey)) {
                fishMetricCache.set(
                  cacheKey,
                  getFishCoinExpectation(
                    fish,
                    currentEquipment,
                    weatherName,
                  ),
                );
              }
              const metrics = fishMetricCache.get(cacheKey);
              rarityRevenue += metrics.expectedRevenue / candidates.length;
              rarityCatchProbability += (
                metrics.catchProbability / candidates.length
              );
            }
            scenarioRevenue += rarityProbability * rarityRevenue;
            scenarioCoinCatchProbability += (
              rarityProbability * rarityCatchProbability
            );
          }

          expectedRevenue += scenarioWeight * scenarioRevenue;
          coinCatchProbability += (
            scenarioWeight * scenarioCoinCatchProbability
          );
          specialProbability += scenarioWeight * scenarioSpecialProbability;
          totalScenarioWeight += scenarioWeight;
        }
      }
    }

    expectedRevenue /= totalScenarioWeight;
    coinCatchProbability /= totalScenarioWeight;
    specialProbability /= totalScenarioWeight;
    const normalEventProbability = 1 - specialProbability;
    const regularCatchProbability = normalEventProbability > 0
      ? coinCatchProbability / normalEventProbability
      : 0;
    const targetRoi = Number(targetRois[baitIndex]) || 0;
    const suggested = selectIntegerPrice(expectedRevenue, targetRoi);
    return {
      tier: bait.quality,
      baitId: bait.id,
      baitName: bait.name,
      currentPrice: bait.price,
      targetRoi,
      expectedRevenue,
      regularCatchProbability,
      coinCatchProbability,
      specialProbability,
      successfulCatchValue: coinCatchProbability > 0
        ? expectedRevenue / coinCatchProbability
        : 0,
      suggestedPrice: suggested.price,
      realizedRoi: suggested.roi,
      currentRoi: expectedRevenue / bait.price - 1,
    };
  });
}

export function formatPercent(value) {
  return `${(Number(value) * 100).toFixed(2)}%`;
}

function createSeededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

export function simulateBossWinRate({
  boss,
  effectiveControl,
  lineCapacity,
  rodDurability,
  iterations = 20_000,
  seed = 1,
}) {
  const random = createSeededRandom(seed);
  let victories = 0;

  for (let run = 0; run < iterations; run += 1) {
    let bossHp = boss.hp;
    let distance = 50;
    let tension = 50;
    let lineDurability = calculateBossLineDurability(lineCapacity);
    let currentRodDurability = rodDurability;
    let stamina = getFishingStaminaMax(1) - getFishingStaminaCost();
    let fishState = FISH_FIGHT_STATE.calm;
    let nextStateChangeAt = getFishFightStateChangeDelay(random);
    let lastPlayerAttackAt = -BOSS_PLAYER_ATTACK_COOLDOWN_MS;
    const pressure = rollNormalTugPressure(random);
    let won = false;

    for (let now = 0; now < getBossFightTimeoutMs(boss); now += 1000) {
      while (now >= nextStateChangeAt) {
        fishState = selectNextFishFightState(fishState, random);
        nextStateChangeAt += getFishFightStateChangeDelay(random);
      }

      if (now > 0 && now % BOSS_ATTACK_INTERVAL_MS === 0 && bossHp > 0) {
        const attack = resolveBossAttack(boss, random);
        lineDurability -= attack.lineDamage;
        currentRodDurability -= attack.rodDamage;
        distance = Math.min(100, distance + attack.distanceGain);
        tension = Math.min(100, tension + attack.tensionGain);
        stamina -= attack.staminaDrain;
        bossHp = Math.min(boss.hp, bossHp + attack.heal);
        if (
          lineDurability <= 0 ||
          currentRodDurability <= 0 ||
          distance >= 100 ||
          tension >= 100 ||
          stamina <= 0
        ) {
          break;
        }
      }

      if (bossHp > 0 && now - lastPlayerAttackAt >= BOSS_PLAYER_ATTACK_COOLDOWN_MS) {
        bossHp = Math.max(0, bossHp - rollBossPlayerDamage(effectiveControl, random));
        lastPlayerAttackAt = now;
        if (bossHp <= 0 && distance <= 0) won = true;
        if (won) break;
        continue;
      }

      const pull = calculateNormalTugActionEffects({
        fishDifficulty: boss.difficulty,
        effectiveControl,
        pressure,
        stateId: fishState,
        action: "pull",
      });
      const loosen = calculateNormalTugActionEffects({
        fishDifficulty: boss.difficulty,
        effectiveControl,
        pressure,
        stateId: fishState,
        action: "loosen",
      });
      const shouldLoosen = (
        tension + pull.tensionEffect >= 88 &&
        distance + loosen.distanceEffect < 96
      );
      if (shouldLoosen) {
        tension = Math.max(0, tension - loosen.tensionEffect);
        distance += loosen.distanceEffect;
      } else {
        distance -= pull.distanceEffect;
        tension += pull.tensionEffect;
      }

      if (tension >= 100 || distance >= 100) break;
      if (distance <= 0) {
        if (bossHp > 0) distance = 5;
        else {
          won = true;
          break;
        }
      }
    }

    if (won) victories += 1;
  }
  return victories / iterations;
}

export function createBossBalanceReport(fishData, shop) {
  const legendaryRod = shop.categories.rods.items[4];
  const mythrilLine = shop.categories.lines.items[4];
  return fishData
    .filter((fish) => fish.is_boss)
    .map((boss, index) => ({
      id: boss.id,
      name: boss.name,
      location: boss.locations[0],
      winRate: simulateBossWinRate({
        boss,
        effectiveControl: legendaryRod.control,
        lineCapacity: mythrilLine.capacity,
        rodDurability: legendaryRod.durability,
        seed: 0x5a17 + index * 0x10000,
      }),
    }));
}

export function createSpecialBalanceReport(fishData, shop) {
  const equipment = getBaseEquipment(shop);
  return [
    {
      rarity: "宝藏",
      referenceRarity: "精品",
      metrics: evaluateRarityRuntime(fishData, "宝藏", equipment[1]).average,
      reference: evaluateRarityRuntime(fishData, "精品", equipment[1]).average,
    },
    {
      rarity: "噩梦",
      referenceRarity: "稀有",
      metrics: evaluateNightmareRuntime(fishData, equipment[2]).average,
      reference: evaluateRarityRuntime(fishData, "稀有", equipment[2]).average,
    },
  ];
}

function formatReportTable(report) {
  const headers = [
    "档位",
    "重量稳过",
    "重量通过",
    "困难稳过",
    "困难通过",
    "双稳过",
    "强拉捕获",
    "精准溜鱼",
  ];
  const rows = report.map((entry) => {
    const metrics = entry.aligned.average;
    return [
      `${entry.tier}-${entry.rarity}`,
      formatPercent(metrics.weightStable),
      formatPercent(metrics.weightPass),
      formatPercent(metrics.difficultyStable),
      formatPercent(metrics.difficultyForcePass),
      formatPercent(metrics.doubleStable),
      formatPercent(metrics.forceCatch),
      formatPercent(metrics.tugCatch),
    ];
  });
  const widths = headers.map((header, column) => Math.max(
    header.length,
    ...rows.map((row) => row[column].length),
  ));
  const line = (row) => row
    .map((value, index) => value.padEnd(widths[index], " "))
    .join("  ");
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...rows]
    .join("\n");
}

function isMainModule() {
  return process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const { fishData, shop } = loadFishingBalanceData();
  if (process.argv.includes("--bait-roi")) {
    const baitReport = evaluateBaitEconomics(fishData, shop);
    console.log([
      "档位  鱼饵      常规捕获  单次期望  目标ROI  建议价  实际ROI  现价ROI",
      ...baitReport.map((entry) => [
        String(entry.tier).padEnd(4, " "),
        entry.baitName.padEnd(8, " "),
        formatPercent(entry.regularCatchProbability).padEnd(9, " "),
        entry.expectedRevenue.toFixed(2).padStart(8, " "),
        formatPercent(entry.targetRoi).padStart(8, " "),
        String(entry.suggestedPrice).padStart(6, " "),
        formatPercent(entry.realizedRoi).padStart(8, " "),
        formatPercent(entry.currentRoi).padStart(8, " "),
      ].join("  ")),
    ].join("\n"));
    process.exit(0);
  }
  if (process.argv.includes("--special")) {
    for (const entry of createSpecialBalanceReport(fishData, shop)) {
      console.log(`${entry.rarity}（参照${entry.referenceRarity}）`);
      for (const key of [
        "weightStable",
        "weightPass",
        "difficultyStable",
        "difficultyForcePass",
        "doubleStable",
        "forceCatch",
        "tugCatch",
      ]) {
        console.log(
          `  ${key}: ${formatPercent(entry.metrics[key])} / ` +
          `${formatPercent(entry.reference[key])}`,
        );
      }
    }
    process.exit(0);
  }
  if (process.argv.includes("--boss")) {
    const bossReport = createBossBalanceReport(fishData, shop);
    for (const boss of bossReport) {
      console.log(`${boss.name} (${boss.location}): ${formatPercent(boss.winRate)}`);
    }
    process.exit(0);
  }
  const allWeather = process.argv.includes("--all-weather");
  const weatherNames = allWeather
    ? Object.keys(WEATHER_CONFIG)
    : [NEUTRAL_WEATHER];
  const report = createBalanceReport(fishData, shop, {
    weatherNames,
    weatherWeighted: allWeather,
  });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReportTable(report));
  }
}
