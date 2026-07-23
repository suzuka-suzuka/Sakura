import fs from "node:fs";

import {
  GEAR_RARITIES,
  NEUTRAL_WEATHER,
  fishDataPath,
  createSpecialBalanceReport,
  getBaseEquipment,
  getFishCheckMetrics,
  getRuntimeCandidates,
  loadFishingBalanceData,
} from "./fishing-balance.mjs";

const TARGETS = Object.freeze({
  garbage: Object.freeze({
    weightStable: 0.8,
    weightPass: 0.9,
    difficultyStable: 1,
    difficultyForcePass: 1,
    doubleStable: 0.8,
    forceCatch: 0.9,
  }),
  same: Object.freeze({
    weightStable: 0.92,
    weightPass: 0.97,
    difficultyStable: 0.86,
    difficultyForcePass: 0.94,
    doubleStable: 0.82,
    forceCatch: 0.92,
  }),
  previous: Object.freeze({
    weightStable: 0.45,
    weightPass: 0.83,
    difficultyStable: 0.25,
    difficultyForcePass: 0.74,
    doubleStable: 0,
    forceCatch: 0.6,
  }),
});

const METRIC_WEIGHTS = Object.freeze({
  weightStable: 2,
  weightPass: 2,
  difficultyStable: 2,
  difficultyForcePass: 2,
  doubleStable: 4,
  forceCatch: 5,
});

const SPECIAL_CALIBRATION = Object.freeze({
  treasure: Object.freeze({
    chest_pond: Object.freeze({ difficulty: 10, weight: [2.5, 4.5] }),
    chest_river: Object.freeze({ difficulty: 15, weight: [4.5, 7] }),
    chest_lake: Object.freeze({ difficulty: 20, weight: [6.5, 9] }),
    chest_coast: Object.freeze({ difficulty: 30, weight: [8.5, 11.5] }),
    chest_abyss: Object.freeze({ difficulty: 41, weight: [11, 14.5] }),
    chest_mystic: Object.freeze({ difficulty: 84, weight: [14.17, 17.93] }),
  }),
  nightmare: Object.freeze({
    monster_mimic: Object.freeze({ difficulty: 70, weight: [54, 55.28] }),
    nightmare_bone_shark: Object.freeze({ difficulty: 90, weight: [77, 86] }),
    nightmare_thief_murloc: Object.freeze({ difficulty: 60, weight: [16, 24] }),
    nightmare_void_devourer: Object.freeze({ difficulty: 134, weight: [24, 32] }),
    nightmare_cursed_skull: Object.freeze({ difficulty: 132, weight: [12, 20] }),
    nightmare_pond_drowned_bride: Object.freeze({ difficulty: 60, weight: [18, 26] }),
    nightmare_river_water_monkey: Object.freeze({ difficulty: 65, weight: [20, 28] }),
    nightmare_lake_corpse_fisher: Object.freeze({ difficulty: 70, weight: [23, 31] }),
    nightmare_coast_ghost_ship: Object.freeze({ difficulty: 75, weight: [28, 36] }),
    nightmare_abyss_diving_bell: Object.freeze({ difficulty: 85, weight: [38, 47.33] }),
    nightmare_mystic_star_eater: Object.freeze({ difficulty: 81, weight: [35, 43] }),
  }),
});

const LOCATIONS = Object.freeze([
  "pond",
  "river",
  "lake",
  "coast",
  "abyss",
  "mystic",
]);
const HOURS = Object.freeze(Array.from({ length: 24 }, (_, hour) => hour));

function round2(value) {
  return Math.round(value * 100) / 100;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function createRarityContext(fishData, rarity) {
  const entries = fishData.filter((fish) => !fish.is_boss && fish.rarity === rarity);
  const indexById = new Map(entries.map((fish, index) => [fish.id, index]));
  const scenarios = [];

  for (const location of LOCATIONS) {
    for (const hour of HOURS) {
      const candidates = getRuntimeCandidates(
        fishData,
        rarity,
        location,
        hour,
        NEUTRAL_WEATHER,
      );
      scenarios.push({
        location,
        hour,
        indices: candidates.map((fish) => indexById.get(fish.id)),
      });
    }
  }

  return { rarity, entries, scenarios };
}

function evaluateContext(context, equipment) {
  const metricKeys = Object.keys(METRIC_WEIGHTS);
  const totals = Object.fromEntries(metricKeys.map((key) => [key, 0]));
  const locationTotals = Object.fromEntries(
    LOCATIONS.map((location) => [
      location,
      Object.fromEntries(metricKeys.map((key) => [key, 0])),
    ]),
  );
  const locationCounts = Object.fromEntries(LOCATIONS.map((location) => [location, 0]));
  const scenarioMetrics = [];

  for (const scenario of context.scenarios) {
    const current = Object.fromEntries(metricKeys.map((key) => [key, 0]));
    for (const index of scenario.indices) {
      const metrics = getFishCheckMetrics(
        context.entries[index],
        equipment,
        NEUTRAL_WEATHER,
      );
      for (const key of metricKeys) current[key] += metrics[key];
    }
    for (const key of metricKeys) {
      current[key] /= scenario.indices.length;
      totals[key] += current[key];
      locationTotals[scenario.location][key] += current[key];
    }
    locationCounts[scenario.location] += 1;
    scenarioMetrics.push({ ...scenario, ...current });
  }

  const scenarioCount = context.scenarios.length;
  return {
    average: Object.fromEntries(
      metricKeys.map((key) => [key, totals[key] / scenarioCount]),
    ),
    byLocation: Object.fromEntries(LOCATIONS.map((location) => [
      location,
      Object.fromEntries(metricKeys.map((key) => [
        key,
        locationTotals[location][key] / locationCounts[location],
      ])),
    ])),
    scenarios: scenarioMetrics,
  };
}

function squaredMetricError(actual, target, keys) {
  return keys.reduce((sum, key) => {
    const difference = actual[key] - target[key];
    return sum + difference * difference * METRIC_WEIGHTS[key];
  }, 0);
}

function targetObjective(
  context,
  equipment,
  target,
  keys,
  {
    locationWeight = 0.25,
    scenarioTolerance = 0.07,
    scenarioWeight = 0.2,
  } = {},
) {
  const result = evaluateContext(context, equipment);
  let score = squaredMetricError(result.average, target, keys);

  for (const location of LOCATIONS) {
    score += squaredMetricError(result.byLocation[location], target, keys) *
      locationWeight / LOCATIONS.length;
  }

  for (const scenario of result.scenarios) {
    for (const key of keys) {
      const difference = Math.abs(scenario[key] - target[key]) - scenarioTolerance;
      if (difference > 0) {
        score += difference * difference * METRIC_WEIGHTS[key] *
          scenarioWeight / result.scenarios.length;
      }
    }
  }
  return score;
}

function buildObjective(context, equipment, tierIndex, keys) {
  if (context.rarity === "垃圾") {
    return () => targetObjective(
      context,
      equipment[0],
      TARGETS.garbage,
      keys,
      { scenarioTolerance: 0.15 },
    );
  }

  return () => {
    let score = targetObjective(
      context,
      equipment[tierIndex],
      TARGETS.same,
      keys,
    );
    if (tierIndex > 0) {
      score += targetObjective(
        context,
        equipment[tierIndex - 1],
        TARGETS.previous,
        keys,
      );
    }
    if (tierIndex > 1) {
      const twoTiersLower = evaluateContext(context, equipment[tierIndex - 2]);
      for (const key of keys) {
        const maximum = key.includes("Stable") ? 0 : key === "forceCatch" ? 0.01 : 0.02;
        const excess = twoTiersLower.average[key] - maximum;
        if (excess > 0) score += excess * excess * METRIC_WEIGHTS[key] * 5;
      }
    }
    return score;
  };
}

function uniqueWeightCandidates(candidates) {
  const seen = new Set();
  return candidates.filter(([minimum, maximum]) => {
    const low = round2(Math.max(0.01, minimum));
    const high = round2(Math.max(low + 0.01, maximum));
    const key = `${low}:${high}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(([minimum, maximum]) => {
    const low = round2(Math.max(0.01, minimum));
    return [low, round2(Math.max(low + 0.01, maximum))];
  });
}

function createWeightCandidates(tierIndex, equipment, garbage = false) {
  const current = equipment[tierIndex].capacity;
  if (garbage) {
    return uniqueWeightCandidates([
      [0.15 * current, 0.55 * current],
      [0.35 * current, 0.75 * current],
      [0.65 * current, 0.95 * current],
      [0.85 * current, 0.99 * current],
      [1.1 * current, 1.4 * current],
      [1.2 * current, 1.5 * current],
      [1.35 * current, 1.65 * current],
      [1.5 * current, 1.85 * current],
    ]);
  }

  const candidates = [];
  if (tierIndex > 0) {
    const previous = equipment[tierIndex - 1].capacity;
    const twoTiersLower = tierIndex > 1
      ? equipment[tierIndex - 2].capacity
      : 0;
    const stablePreviousMinimum = Math.max(
      previous * 0.65,
      twoTiersLower * 2,
    );
    candidates.push(
      [stablePreviousMinimum, previous * 0.9],
      [Math.max(stablePreviousMinimum, previous * 0.82), previous * 0.98],
    );

    for (const passRate of [0.95, 0.9, 0.83, 0.75, 0.65, 0.5, 0.25]) {
      const center = previous * (2 - passRate);
      const halfWidth = previous * 0.045;
      if (center - halfWidth > previous && center + halfWidth < current) {
        candidates.push([center - halfWidth, center + halfWidth]);
      }
    }
  } else {
    candidates.push(
      [current * 0.2, current * 0.6],
      [current * 0.45, current * 0.85],
      [current * 0.75, current * 0.98],
    );
  }

  candidates.push(
    [current * 0.78, current * 0.98],
    [current * 0.85, current * 1.15],
    [current * 1.05, current * 1.25],
  );
  for (const passRate of [0.9, 0.8, 0.7, 0.625, 0.5, 0.3, 0.1]) {
    const center = current * (2 - passRate);
    const halfWidth = current * 0.1;
    candidates.push([center - halfWidth, center + halfWidth]);
  }
  return uniqueWeightCandidates(candidates);
}

function createDifficultyCandidates(tierIndex, equipment, garbage = false) {
  if (garbage) return [4, 6, 8, 10];
  const current = equipment[tierIndex].control;
  const values = new Set();
  if (tierIndex > 0) {
    const previous = equipment[tierIndex - 1].control;
    for (const offset of [-1, 0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 49]) {
      values.add(Math.max(0, previous + offset));
    }
  } else {
    for (const value of [2, 5, 8, 10]) values.add(value);
  }
  for (const offset of [0, 5, 10, 15, 20, 21, 22, 25, 30, 35, 40, 45, 50]) {
    values.add(current + offset);
  }
  return [...values].sort((left, right) => left - right);
}

function optimizeField({
  context,
  candidates,
  getValue,
  setValue,
  objective,
  rounds = 5,
}) {
  let bestScore = objective();
  for (let round = 0; round < rounds; round += 1) {
    let changed = 0;
    const orderedEntries = round % 2 === 0
      ? context.entries
      : [...context.entries].reverse();
    for (const fish of orderedEntries) {
      const original = getValue(fish);
      let localBest = original;
      let localBestScore = bestScore;
      for (const candidate of candidates) {
        setValue(fish, candidate);
        const score = objective();
        if (score + 1e-12 < localBestScore) {
          localBestScore = score;
          localBest = candidate;
        }
      }
      setValue(fish, localBest);
      if (JSON.stringify(localBest) !== JSON.stringify(original)) changed += 1;
      bestScore = localBestScore;
    }
    if (changed === 0) break;
  }
  return bestScore;
}

function calibrateGarbage(fishData, equipment) {
  const context = createRarityContext(fishData, "垃圾");
  for (const fish of context.entries) fish.difficulty = Math.min(10, fish.difficulty);
  const objective = buildObjective(
    context,
    equipment,
    0,
    ["weightStable", "weightPass", "doubleStable", "forceCatch"],
  );
  optimizeField({
    context,
    candidates: createWeightCandidates(0, equipment, true),
    getValue: (fish) => [...fish.weight],
    setValue: (fish, value) => { fish.weight = [...value]; },
    objective,
    rounds: 8,
  });
  return context;
}

function calibrateRegularRarity(fishData, equipment, tierIndex) {
  const rarity = GEAR_RARITIES[tierIndex];
  const context = createRarityContext(fishData, rarity);

  const weightObjective = buildObjective(
    context,
    equipment,
    tierIndex,
    ["weightStable", "weightPass"],
  );
  optimizeField({
    context,
    candidates: createWeightCandidates(tierIndex, equipment),
    getValue: (fish) => [...fish.weight],
    setValue: (fish, value) => { fish.weight = [...value]; },
    objective: weightObjective,
    rounds: 7,
  });

  const fullObjective = buildObjective(
    context,
    equipment,
    tierIndex,
    [
      "weightStable",
      "weightPass",
      "difficultyStable",
      "difficultyForcePass",
      "doubleStable",
      "forceCatch",
    ],
  );
  optimizeField({
    context,
    candidates: createDifficultyCandidates(tierIndex, equipment),
    getValue: (fish) => fish.difficulty,
    setValue: (fish, value) => { fish.difficulty = value; },
    objective: fullObjective,
    rounds: 8,
  });

  // 最后一轮允许重量与困难度相关性共同收敛。
  optimizeField({
    context,
    candidates: createWeightCandidates(tierIndex, equipment),
    getValue: (fish) => [...fish.weight],
    setValue: (fish, value) => { fish.weight = [...value]; },
    objective: fullObjective,
    rounds: 4,
  });
  optimizeField({
    context,
    candidates: createDifficultyCandidates(tierIndex, equipment),
    getValue: (fish) => fish.difficulty,
    setValue: (fish, value) => { fish.difficulty = value; },
    objective: fullObjective,
    rounds: 4,
  });
  return context;
}

function calibrateGraduationRarity(fishData) {
  const context = createRarityContext(fishData, GEAR_RARITIES.at(-1));
  const difficultyById = new Map([
    ["fantasy_leviathan_spawn", 160],
    ["fantasy_abyssal_whale", 194],
    ["fantasy_star_eater", 210],
    ["fantasy_star_serpent", 210],
    ["fantasy_eclipse_leviathan", 210],
  ]);

  // 中性天气下只有两条全天候全钓点传说鱼，困难稳过率会以约47个百分点
  // 跳变，无法像大鱼池一样细调。这里固定经过全场景枚举得到的五条锚点：
  // 同档强拉约93%、低一档约58%，神之诱饵整杆约96%。
  for (const fish of context.entries) {
    if (difficultyById.has(fish.id)) {
      fish.difficulty = difficultyById.get(fish.id);
    }
  }
  return context;
}

function calibrateSpecialRarities(fishData) {
  const configuredIds = new Set();
  for (const group of Object.values(SPECIAL_CALIBRATION)) {
    for (const [id, values] of Object.entries(group)) {
      const fish = fishData.find((entry) => entry.id === id);
      if (!fish) throw new Error(`找不到特殊渔获 ${id}`);
      fish.difficulty = values.difficulty;
      fish.weight = [...values.weight];
      configuredIds.add(id);
    }
  }

  const specialRows = fishData.filter((fish) => (
    !fish.is_boss && (fish.rarity === "宝藏" || fish.rarity === "噩梦")
  ));
  if (specialRows.some((fish) => !configuredIds.has(fish.id))) {
    throw new Error("存在尚未纳入换算表的宝藏或噩梦");
  }
}

function preservePriceChallengeOrder(fishData) {
  for (const rarity of ["垃圾", ...GEAR_RARITIES]) {
    const rows = fishData.filter((fish) => !fish.is_boss && fish.rarity === rarity);
    const sortedPrices = rows.map((fish) => fish.base_price).sort((a, b) => a - b);
    const ranked = [...rows].sort((left, right) => {
      const leftChallenge = left.difficulty + average(left.weight);
      const rightChallenge = right.difficulty + average(right.weight);
      return leftChallenge - rightChallenge || left.id.localeCompare(right.id);
    });
    ranked.forEach((fish, index) => {
      fish.base_price = sortedPrices[index];
    });
  }
}

function printRarityResult(context, equipment, tierIndex) {
  const sameEquipment = context.rarity === "垃圾"
    ? equipment[0]
    : equipment[tierIndex];
  const same = evaluateContext(context, sameEquipment).average;
  const summary = {
    rarity: context.rarity,
    weightStable: round2(same.weightStable * 100),
    weightPass: round2(same.weightPass * 100),
    difficultyStable: round2(same.difficultyStable * 100),
    difficultyPass: round2(same.difficultyForcePass * 100),
    doubleStable: round2(same.doubleStable * 100),
    catch: round2(same.forceCatch * 100),
  };
  if (context.rarity !== "垃圾" && tierIndex > 0) {
    const previous = evaluateContext(context, equipment[tierIndex - 1]).average;
    summary.previousCatch = round2(previous.forceCatch * 100);
  }
  console.log(JSON.stringify(summary));
}

function main() {
  const { fishData, shop } = loadFishingBalanceData();
  const equipment = getBaseEquipment(shop);
  const specialOnly = process.argv.includes("--special");
  const tierArgument = process.argv.find((argument) => argument.startsWith("--tier="));
  const selectedTier = tierArgument
    ? Number(tierArgument.slice("--tier=".length))
    : null;

  if (!specialOnly && (selectedTier === null || selectedTier === 0)) {
    const garbageContext = calibrateGarbage(fishData, equipment);
    printRarityResult(garbageContext, equipment, 0);
  }

  for (let tierIndex = 0; tierIndex < GEAR_RARITIES.length; tierIndex += 1) {
    if (specialOnly) break;
    if (selectedTier !== null && selectedTier !== tierIndex + 1) continue;
    const context = tierIndex === GEAR_RARITIES.length - 1
      ? calibrateGraduationRarity(fishData)
      : calibrateRegularRarity(fishData, equipment, tierIndex);
    printRarityResult(context, equipment, tierIndex);
  }

  if (selectedTier === null || specialOnly) {
    calibrateSpecialRarities(fishData);
    for (const entry of createSpecialBalanceReport(fishData, shop)) {
      console.log(JSON.stringify({
        rarity: entry.rarity,
        reference: entry.referenceRarity,
        weightStable: round2(entry.metrics.weightStable * 100),
        weightPass: round2(entry.metrics.weightPass * 100),
        difficultyStable: round2(entry.metrics.difficultyStable * 100),
        difficultyPass: round2(entry.metrics.difficultyForcePass * 100),
        doubleStable: round2(entry.metrics.doubleStable * 100),
        catch: round2(entry.metrics.forceCatch * 100),
      }));
    }
  }

  if (selectedTier === null && !specialOnly) preservePriceChallengeOrder(fishData);
  if (process.argv.includes("--write")) {
    fs.writeFileSync(fishDataPath, `${JSON.stringify(fishData, null, 2)}\n`, "utf8");
    console.log(`已写入 ${fishDataPath}`);
  } else {
    console.log("预览完成；传入 --write 才会写入 fish.json");
  }
}

main();
