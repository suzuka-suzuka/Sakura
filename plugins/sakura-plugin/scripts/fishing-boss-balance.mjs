// 首领校准工具：仅读取配置、执行纯规则，不连接玩家数据库或 Redis。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";
import {
  BOSS_ATTACK_INTERVAL_MS, BOSS_PLAYER_ATTACK_COOLDOWN_MS,
  FISH_FIGHT_STATE, SHINY_DIFFICULTY_MULTIPLIER,
  calculateNormalTugActionEffects,
  calculateRodDurabilityControl, getMasteryControlBonus,
  getBossFightTimeoutMs, getFishFightStateChangeDelay,
  rollNormalTugPressure, selectNextFishFightState, resolveBossAttack,
  rollBossPlayerDamage, getBlindReelHitRate,
} from "../lib/fishing/rules.js";

export function createSeededRandom(seed) {
  let value = seed >>> 0;
  return () => ((value = (Math.imul(value, 1664525) + 1013904223) >>> 0) / 0x100000000);
}

export function simulateBossBattle({
  boss, rod, lineCapacity = 210, mastery = 0, durabilityRatio = 1,
  actionIntervalMs = 1000, coinBalance = 1000, shiny = false,
  strategy = "adaptive", random = Math.random,
  // 验收可分别固定压力、伤害与状态随机源，默认仍共享同一条随机序列。
  pressureRandom = random, playerDamageRandom = random, weightRandom = random,
  stateRandom = random, bossRandom = random,
}) {
  const difficulty = shiny ? Math.round(boss.difficulty * SHINY_DIFFICULTY_MULTIPLIER) : boss.difficulty;
  const actualWeight = Math.round((boss.weight[0] + (boss.weight[1] - boss.weight[0]) * weightRandom()) * 100) / 100;
  const maxRodDurability = rod.durability || rod.control;
  const initialRodDurability = Math.max(0, Math.floor(maxRodDurability * durabilityRatio));
  let currentRodDurability = initialRodDurability;
  let coins = coinBalance;
  let hp = boss.hp;
  let distance = 50;
  let tension = 50;
  let attacks = 0;
  let lastAttackAt = -BOSS_PLAYER_ATTACK_COOLDOWN_MS;
  let fishState = FISH_FIGHT_STATE.calm;
  let nextStateAt = getFishFightStateChangeDelay(stateRandom);
  let nextBossAt = BOSS_ATTACK_INTERVAL_MS;
  let nextActionAt = actionIntervalMs;
  const pressure = rollNormalTugPressure(pressureRandom);
  const control = () => calculateRodDurabilityControl(rod.control, currentRodDurability, maxRodDurability) + getMasteryControlBonus(mastery);
  const result = (outcome, elapsed) => ({
    outcome, elapsed, attacks,
    rodDamage: initialRodDurability - Math.max(0, currentRodDurability),
    coinsLost: coinBalance - coins, finalControl: control(),
  });
  if (currentRodDurability <= 0) return result("rod", 0);
  // 与实际收竿相同，超重先判鱼线，再损伤鱼竿；超重拉距也损耗耐久。
  if (actualWeight > lineCapacity) {
    if (actualWeight > lineCapacity * 2 || random() >= 2 - actualWeight / lineCapacity) {
      currentRodDurability -= actualWeight > lineCapacity * 2 ? 10 : 5;
      return result("overweight", 0);
    }
    currentRodDurability -= 5;
    if (currentRodDurability <= 0) return result("rod", 0);
  }
  const timeout = getBossFightTimeoutMs(boss);
  // 事件驱动；同一时刻先轮换状态，再结算反击，最后执行玩家动作。
  while (true) {
    const now = Math.min(nextStateAt, nextBossAt, nextActionAt);
    if (now >= timeout) return result("timeout", timeout);
    if (now === nextStateAt) {
      fishState = selectNextFishFightState(fishState, stateRandom);
      nextStateAt += getFishFightStateChangeDelay(stateRandom);
    }
    if (now === nextBossAt) {
      if (hp > 0) {
        const hit = resolveBossAttack(boss, bossRandom, { tension, distance, attackRound: ++attacks, coinBalance: coins });
        currentRodDurability -= hit.rodDamage;
        coins = Math.max(0, coins - hit.coinSteal);
        distance = Math.min(100, distance + hit.distanceGain);
        tension = Math.min(100, tension + hit.tensionGain);
        hp = Math.min(boss.hp, hp + hit.heal);
        if (currentRodDurability <= 0) return result("rod", now);
        if (tension >= 100) return result("tension", now);
        if (distance >= 100) return result("escape", now);
      }
      nextBossAt = hp > 0 ? nextBossAt + BOSS_ATTACK_INTERVAL_MS : Infinity;
    }
    if (now !== nextActionAt) continue;
    nextActionAt += actionIntervalMs;
    const effects = (action) => calculateNormalTugActionEffects({ fishDifficulty: difficulty, effectiveControl: control(), pressure, stateId: fishState, action });
    const pull = effects("pull");
    const loosen = effects("loosen");
    const imminentHit = hp > 0 && nextBossAt <= nextActionAt;
    const tensionGain = imminentHit && boss.boss_mechanic.type === "tension_surge" ? boss.boss_mechanic.amount : 0;
    // 仅使用玩家可见的状态：优先避开即将到来的张力崩断，锯鲨命中前主动卸力。
    const canLoosen = distance + loosen.distanceEffect < 100;
    const sharkHit = boss.boss_mechanic.type === "tension_rod_damage" && imminentHit && canLoosen
      ? resolveBossAttack(boss, () => 0, { tension }).rodDamage : 0;
    const canReduceRodDamage = sharkHit > 0 &&
      resolveBossAttack(boss, () => 0, { tension: tension - loosen.tensionEffect }).rodDamage < sharkHit;
    const defend = strategy === "adaptive" && canLoosen && imminentHit && (
      tension + tensionGain >= 95 ||
      (canReduceRodDamage && currentRodDurability <= sharkHit)
    );
    // 鲤王反击前若一次拉距即可进入低伤区，优先拉；其他时候仍优先冷却完成的攻击。
    const approach = strategy === "adaptive" && boss.boss_mechanic.type === "distance_damage" && imminentHit &&
      distance > boss.boss_mechanic.near_distance && distance - pull.distanceEffect <= boss.boss_mechanic.near_distance &&
      tension + pull.tensionEffect < 90;
    if (!defend && !approach && hp > 0 && now - lastAttackAt >= BOSS_PLAYER_ATTACK_COOLDOWN_MS) {
      hp = Math.max(0, hp - rollBossPlayerDamage(control(), playerDamageRandom));
      lastAttackAt = now;
      if (hp <= 0) nextBossAt = Infinity;
      if (hp <= 0 && distance <= 0) return result("win", now);
      continue;
    }
    const shouldLoosen = defend || (strategy === "adaptive" && canReduceRodDamage) ||
      (!approach && canLoosen && tension + pull.tensionEffect + tensionGain >= 88);
    if (shouldLoosen) {
      tension = Math.max(0, tension - loosen.tensionEffect);
      distance += loosen.distanceEffect;
    } else {
      distance -= pull.distanceEffect;
      tension += pull.tensionEffect;
      if (actualWeight > lineCapacity) currentRodDurability -= 1;
    }
    if (currentRodDurability <= 0) return result("rod", now);
    if (tension >= 100) return result("tension", now);
    if (distance >= 100) return result("escape", now);
    if (distance <= 0) {
      if (hp > 0) distance = 5;
      else return result("win", now);
    }
  }
}

export function simulateBossScenario(options) {
  const { iterations = 10000, seed = 0x5a17, blindnessLayers = 0 } = options;
  const random = createSeededRandom(seed);
  const outcomes = {};
  let rodDamage = 0, winRodDamage = 0, winSeconds = 0, coinsLost = 0;
  for (let i = 0; i < iterations; i++) {
    const result = simulateBossBattle({ ...options, random });
    outcomes[result.outcome] = (outcomes[result.outcome] || 0) + 1;
    rodDamage += result.rodDamage;
    coinsLost += result.coinsLost;
    if (result.outcome === "win") {
      winSeconds += result.elapsed / 1000;
      winRodDamage += result.rodDamage;
    }
  }
  const wins = outcomes.win || 0;
  return {
    winRate: wins / iterations,
    winRatePerCast: wins / iterations * getBlindReelHitRate(blindnessLayers),
    averageRodDamage: rodDamage / iterations,
    winRodDamage: wins ? winRodDamage / wins : null,
    winSeconds: wins ? winSeconds / wins : null,
    averageCoinsLost: coinsLost / iterations,
    outcomes, iterations,
  };
}

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function readBossBalanceInputs() {
  const fish = JSON.parse(fs.readFileSync(path.join(pluginRoot, "resources/fish/fish.json"), "utf8"));
  const shop = yaml.load(fs.readFileSync(path.join(pluginRoot, "resources/economy/shop.yaml"), "utf8"));
  return { bosses: fish.filter(f => f.is_boss), rods: shop.categories.rods.items, lineCapacity: shop.categories.lines.items.find(x => x.id === "line_mythril").capacity };
}

// 有限边界集合：最大鱼重、最大合法压力、伤害两端、全部七次状态选择组合，
// 加入固定时长边界与8/12秒交替时长。它不等同于枚举所有毫秒级随机过程。
export function createBossBoundaryReport() {
  const { bosses, rods, lineCapacity } = readBossBalanceInputs();
  const rod = rods.find(r => r.id === "rod_legendary");
  const fixedDelays = [8000, 8001, 9000, 9999, 10000, 10001, 11000, 11999, 12000];
  return bosses.map(boss => {
    let cases = 0, wins = 0, maxSeconds = 0, maxRodDamage = 0;
    const failures = [];
    const check = (timing, choices, damageRoll, fixedDelay) => {
      let calls = 0, delayIndex = 0, stateIndex = 0;
      const stateRandom = () => {
        if (calls++ % 2 === 0) return fixedDelay == null
          ? (timing >>> delayIndex++) & 1 : (fixedDelay - 8000) / 4000;
        return ((choices >>> stateIndex++) & 1) ? 0.999999999999 : 0;
      };
      const result = simulateBossBattle({
        boss, rod, lineCapacity, mastery: 20, actionIntervalMs: 1000,
        pressureRandom: () => 1, weightRandom: () => 1, bossRandom: () => 1,
        playerDamageRandom: () => damageRoll, stateRandom,
      });
      cases++;
      if (result.outcome === "win") wins++;
      else if (failures.length < 3) failures.push({ timing, choices, damageRoll, fixedDelay, result });
      maxSeconds = Math.max(maxSeconds, result.elapsed / 1000);
      maxRodDamage = Math.max(maxRodDamage, result.rodDamage);
    };
    for (const delay of fixedDelays) for (let choices = 0; choices < 128; choices++) {
      for (const roll of [0, 0.999999999999]) check(0, choices, roll, delay);
    }
    for (let timing = 0; timing < 128; timing++) for (let choices = 0; choices < 128; choices++) {
      for (const roll of [0, 0.999999999999]) check(timing, choices, roll, null);
    }
    return { name: boss.name, cases, wins, failed: cases - wins, maxSeconds, maxRodDamage, failures };
  });
}

export function createBossBaselineAcceptance({ iterations = 10000 } = {}) {
  const { bosses, rods, lineCapacity } = readBossBalanceInputs();
  const rod = rods.find(r => r.id === "rod_legendary");
  const baseline = bosses.map(boss => ({ name: boss.name, ...simulateBossScenario({
    boss, rod, lineCapacity, mastery: 20, actionIntervalMs: 1000, iterations,
  }) }));
  const boundaries = createBossBoundaryReport();
  return {
    requirements: { rod: rod.id, durabilityRatio: 1, lineCapacity, mastery: 20, actionIntervalMs: 1000, coinBalance: 1000, shiny: false, blindnessLayers: 0 },
    passed: baseline.every(x => x.winRate === 1) && boundaries.every(x => x.failed === 0),
    baseline, boundaries,
  };
}

export function createBossBalanceMatrix({ iterations = 10000 } = {}) {
  const { bosses, rods, lineCapacity } = readBossBalanceInputs();
  const scenarios = [
    { name: "传说满耐久_熟练0", mastery: 0 },
    { name: "传说满耐久_熟练10", mastery: 10 },
    { name: "传说满耐久_熟练20", mastery: 20 },
    { name: "传说满耐久_熟练40", mastery: 40 },
    { name: "传说满耐久_熟练80", mastery: 80 },
    { name: "传说90%耐久_熟练20", mastery: 20, durabilityRatio: 0.9 },
    { name: "传说95%耐久_熟练20", mastery: 20, durabilityRatio: 0.95 },
    { name: "传说90%耐久_熟练40", mastery: 40, durabilityRatio: 0.9 },
    { name: "传说80%耐久_熟练20", mastery: 20, durabilityRatio: 0.8 },
    { name: "传说80%耐久_熟练80", mastery: 80, durabilityRatio: 0.8 },
    { name: "传说60%耐久_熟练40", mastery: 40, durabilityRatio: 0.6 },
    { name: "星穹满耐久_熟练0", mastery: 0, rodId: "rod_astral" },
    { name: "传说满耐久_熟练20_每2秒操作", mastery: 20, actionIntervalMs: 2000 },
    { name: "传说满耐久_熟练20_通用打法", mastery: 20, strategy: "generic" },
    { name: "传说满耐久_熟练80_异色", mastery: 80, shiny: true },
    { name: "传说满耐久_熟练120_异色", mastery: 120, shiny: true },
    { name: "传说满耐久_熟练160_异色", mastery: 160, shiny: true },
  ];
  return scenarios.map(scenario => ({
    scenario: scenario.name,
    bosses: bosses.map(boss => ({ name: boss.name, ...simulateBossScenario({
      ...scenario, boss, rod: rods.find(r => r.id === (scenario.rodId || "rod_legendary")), lineCapacity, iterations,
    }) })),
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const iterations = Number(process.argv[2]) || 10000;
  if (process.argv.includes("--verify-baseline")) {
    const result = createBossBaselineAcceptance({ iterations });
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } else {
    const result = createBossBalanceMatrix({ iterations });
    if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
    else for (const row of result) console.log(row.scenario, row.bosses.map(b => `${b.name} ${(b.winRate * 100).toFixed(1)}%`).join(" | "));
  }
}
