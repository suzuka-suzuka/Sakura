// node --experimental-vm-modules --test plugins/sakura-plugin/scripts/test-fishing-mechanics.mjs
// 在隔离 VM 中运行真实指令方法，替换数据库、网络和定时器边界。
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as rules from "../lib/fishing/rules.js";
import * as session from "../lib/fishing/session.js";
import { createBossBoundaryReport, readBossBalanceInputs, simulateBossScenario } from "./fishing-boss-balance.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fish = JSON.parse(fs.readFileSync(path.join(pluginRoot, "resources/fish/fish.json"), "utf8"));
const { bosses, rods } = readBossBalanceInputs();
// Node 22 的 VM 模块在多次异步测试间保留宿主引用，避免上下文过早回收。
const harnessModules = [];

test("致盲按乘法叠层，单次收竿重试不会再次抽签", () => {
  for (const layers of [0, 1, 2, 3, 5, 10]) assert.equal(rules.getBlindReelHitRate(layers), 0.9 ** layers);
  const state = {};
  let draws = 0;
  const first = session.resolveBlindReel(state, 2, () => { draws++; return 0.82; });
  assert.equal(first.hit, false);
  assert.equal(session.resolveBlindReel(state, 0, () => { draws++; return 0; }), first);
  assert.equal(draws, 1);
  assert.equal(session.resolveBlindReel({}, 0, () => assert.fail("无致盲不消耗随机数")).hit, true);
  assert.equal(session.resolveBlindReel({}, 1, () => 0.89999).hit, true);
  assert.equal(session.resolveBlindReel({}, 1, () => 0.9).hit, false);
});

test("骸骨鲨按最大耐久扣20%，耐久折算覆盖零值与熟练度相加顺序", () => {
  assert.deepEqual([10, 100, 190, 950, 101].map(max => rules.calculateRodPercentDamage(max, 0.2)), [2, 20, 38, 190, 21]);
  assert.equal(rules.calculateRodDurabilityControl(190, 152, 190) + rules.getMasteryControlBonus(20), 162);
  assert.equal(rules.calculateRodDurabilityControl(190, 760, 950), 152);
  assert.equal(rules.calculateRodDurabilityControl(190, 0, 190), 0);
  assert.equal(rules.calculateRodDurabilityControl(190, 100, 0), 0);
});

test("首领按命中前距离增伤，吞舟递增损耗不受张力影响", () => {
  assert.deepEqual(rules.validateLegacyFishData(fish), []);
  assert.ok(bosses.every(boss => boss.difficulty === rules.BOSS_BASE_DIFFICULTY && boss.difficulty === 215));
  const carp = bosses[0], maw = bosses[4];
  assert.deepEqual([0, 30, 30.1, 60, 60.1, 99].map(distance => {
    const hit = rules.resolveBossAttack(carp, () => 0, { distance });
    assert.equal(Object.hasOwn(hit, "staminaDrain"), false);
    assert.equal(Object.hasOwn(hit, "lineDamage"), false);
    return hit.rodDamage;
  }), [2, 2, 3, 3, 4, 4]);
  for (const tension of [0, 100]) {
    const hits = Array.from({ length: 11 }, (_, i) => rules.resolveBossAttack(maw, () => 0, { tension, attackRound: i + 1 }));
    assert.deepEqual(hits.map(x => x.rodDamage), [1, 2, 3, 4, 5, 5, 5, 5, 5, 5, 5]);
    assert.ok(hits.every(x => !Object.hasOwn(x, "lineDamage") && !Object.hasOwn(x, "rodControlLoss")));
  }
  const invalid = structuredClone(fish);
  invalid.find(f => f.is_boss).difficulty = rules.BOSS_BASE_DIFFICULTY - 1;
  assert.ok(rules.validateLegacyFishData(invalid).some(error => error.includes("首领基础困难度必须统一")));
  invalid.find(f => f.is_boss).difficulty = rules.BOSS_BASE_DIFFICULTY;
  invalid.find(f => f.id === "nightmare_bone_shark").nightmare_effect.ratio = 1.1;
  assert.ok(rules.validateLegacyFishData(invalid).length > 0);
});

test("玩家攻击随实时控制力变化，首领只伤鱼竿，锯鲨在40和80张力切换损伤", () => {
  for (const [control, minimum, maximum] of [[190, 36, 40], [200, 38, 42], [171, 33, 37]]) {
    assert.equal(rules.rollBossPlayerDamage(control, () => 0), minimum);
    assert.equal(rules.rollBossPlayerDamage(control, () => 0.999), maximum);
  }
  const normal = rules.resolveBossAttack(bosses[1], () => 0.5, { coinBalance: 1000 });
  assert.equal(normal.rodDamage, 2);
  assert.ok(bosses.every(boss => !Object.hasOwn(rules.resolveBossAttack(boss), "lineDamage")));
  assert.equal(rules.resolveBossAttack(bosses[1], () => 0, { coinBalance: 0 }).rodDamage, 8);
  assert.equal(rules.resolveBossAttack(bosses[5]).heal, 6);
  assert.deepEqual([-1, 0, 39, 39.99, 40, 79, 79.99, 80, 99, 100].map(tension =>
    rules.resolveBossAttack(bosses[3], () => 0, { tension }).rodDamage), [2, 2, 2, 2, 3, 3, 3, 4, 4, 4]);
  const invalid = structuredClone(fish);
  invalid.find(f => f.id === bosses[3].id).boss_mechanic.high_tension = 40;
  assert.ok(rules.validateLegacyFishData(invalid).some(error => error.includes("首领张力竿损配置无效")));
});

async function harness() {
  const calls = { settlements: [], replies: [], breaks: 0, rodDamage: 0, cooldown: 0, rolls: 0, refunds: 0 };
  const player = { layers: 1, immune: false, roll: 0.95, durability: 190, coins: 1000 };
  class Manager {
    static async migrateLegacyWishKeys() { return { koiWish: 0, starWish: 0 }; }
    getNightmareStatus() { return { blindnessLayers: player.layers }; }
    getRodMastery() { return 20; }
    getRodControl() { return player.durability; }
    getRodDurabilityInfo() { return { currentDurability: player.durability, maxDurability: 190 }; }
    getLineBonusFromMastery() { return 0; }
    consumeNightmareImmunity() { return { immune: player.immune, active: false }; }
    resetNightmareCurse() {}
    addBlindnessLayers(user, amount) { player.layers += amount; return { layers: player.layers, hitRate: rules.getBlindReelHitRate(player.layers) }; }
    breakLine() { calls.breaks++; }
    damageRod(user, rod, amount) { calls.rodDamage += amount; player.durability = Math.max(0, player.durability - amount); return { applied: true, isBroken: player.durability <= 0, currentDurability: player.durability, maxDurability: 190 }; }
  }
  class Settlement {
    settleAttempt(args) { calls.settlements.push(args); return { success: true }; }
  }
  let sessions;
  class SessionStore extends session.FishingSessionStore { constructor() { super(); sessions = this; } }
  const context = vm.createContext({
    console, setTimeout: () => 1, clearTimeout() {},
    plugin: class { finish() {} setContext() {} getScopeKey(...parts) { return JSON.stringify(parts); } },
    Command: (pattern, fn) => fn, Cron: (pattern, fn) => fn,
    logger: { warn: () => {}, info: () => {}, error: (...args) => assert.fail(args.join(" ")) },
    segment: { at: x => x, image: x => x },
  });
  const imports = {
    "../lib/fishing/rules.js": rules,
    "../lib/fishing/session.js": { ...session, FishingSessionStore: SessionStore, resolveBlindReel: (state, layers) => session.resolveBlindReel(state, layers, () => { calls.rolls++; return player.roll; }) },
    "../lib/economy/FishingManager.js": { default: Manager },
    "../lib/economy/EconomyManager.js": { default: class {
      getCoins() { return player.coins; }
      reduceCoins(e, amount) { player.coins -= amount; }
    } },
    "../lib/fishing/SettlementService.js": { default: Settlement },
    "../lib/fishing/fishData.js": { getFishData: () => fish, getFishIdSet: () => new Set(fish.map(f => f.id)), getLocationExclusiveFish: () => [] },
    "../lib/path.js": { pluginresources: "/isolated/resources" },
    "node:fs": { default: { existsSync: () => false } },
    "node:path": { default: path },
  };
  const source = fs.readFileSync(path.join(pluginRoot, "apps/fishing.js"), "utf8");
  const app = new vm.SourceTextModule(source, { context });
  harnessModules.push(app, context);
  await app.link(specifier => {
    let exports = imports[specifier];
    if (!exports) {
      const declaration = [...source.matchAll(/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];/g)].find(match => match[2] === specifier)?.[1];
      assert.ok(declaration, specifier);
      const names = declaration.startsWith("{") ? declaration.replace(/[{}\s]/g, "").split(",").filter(Boolean) : ["default"];
      exports = Object.fromEntries(names.map(name => [name, class {}]));
    }
    const dependency = new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
    harnessModules.push(dependency);
    return dependency;
  });
  await app.evaluate();
  const instance = new app.namespace.default();
  instance.setCooldownAndIncrement = async () => { calls.cooldown++; };
  instance.grantRiverBlessRefund = () => { calls.refunds++; return "河神保线补偿"; };
  const e = { group_id: "group", user_id: "user", msg: "收竿", reply: async (...args) => { calls.replies.push(args); } };
  const key = instance.buildFishingStateKey(e.group_id, e.user_id);
  const create = (entry, extra = {}) => sessions.create(key, {
    id: `test-${calls.settlements.length}`, phase: session.FISHING_PHASE.weightCheck,
    fish: { ...entry, actualWeight: entry.weight?.[0] || 1 },
    rodConfig: { id: "rod_legendary", name: "传说之竿" }, lineConfig: { id: "line_mythril", name: "秘银钓线", capacity: 210 },
    deepPressureMultiplier: 1,
    cleanup: () => sessions.finish(key), ...extra,
  });
  return { instance, e, create, calls, player, sessions, key, Manager };
}

test("真实收竿入口：致盲空钩先于护符、超重、噩梦和首领，重复消息仅结算一次", async () => {
  for (const entry of [fish.find(f => f.rarity === "普通"), bosses[0], fish.find(f => f.rarity === "噩梦"), { id: "torpedo", isTorpedo: true }]) {
    const h = await harness();
    const state = h.create(entry, { hasLucky: true, isOverweight: true });
    h.e.msg = "攻";
    await h.instance.handleFishing(h.e);
    assert.equal(h.calls.rolls, 0);
    h.e.msg = "收竿";
    await Promise.all([h.instance.handleFishing(h.e), h.instance.handleFishing(h.e)]);
    assert.equal(h.calls.rolls, 1);
    assert.equal(h.calls.settlements.length, 1);
    assert.equal(h.calls.settlements[0].success, false);
    assert.equal(h.calls.settlements[0].earnings, 0);
    assert.equal(h.calls.settlements[0].recordCatch, false);
    assert.equal(h.calls.settlements[0].masteryGain, 0);
    assert.equal(h.calls.breaks, 0);
    assert.equal(h.calls.rodDamage, 0);
    assert.equal(h.calls.cooldown, 1);
    assert.equal(h.player.layers, 1);
    assert.equal(state.reelAccuracy.hit, false);
    assert.equal(h.sessions.get(h.key), null);
  }
});

test("命中后进入首领战；战中攻不重复抽致盲，净化后的新收竿不受旧层数影响", async () => {
  const h = await harness();
  h.player.roll = 0.1;
  const state = h.create(bosses[0]);
  await h.instance.handleFishing(h.e);
  assert.equal(state.phase, session.FISHING_PHASE.fighting);
  assert.equal(h.calls.rolls, 1);
  h.player.roll = 0.99;
  h.e.msg = "攻";
  await h.instance.handleFishing(h.e);
  assert.ok(state.bossHp < bosses[0].hp);
  assert.equal(h.calls.rolls, 1);
  h.sessions.finish(h.key);
  h.player.layers = 0;
  const newState = h.create(bosses[0]);
  h.e.msg = "收竿";
  await h.instance.handleFishing(h.e);
  assert.equal(newState.phase, session.FISHING_PHASE.fighting);
  assert.equal(h.calls.rolls, 1);
});

test("真实噩梦结算：捞尸人叠层并断线，完整免疫挡下两者，骸骨鲨按最大耐久扣损", async () => {
  for (const immune of [false, true]) {
    const h = await harness();
    h.player.immune = immune;
    const state = h.create(fish.find(f => f.id === "nightmare_lake_corpse_fisher"));
    await h.instance.finishSuccess(h.e, state, new h.Manager());
    assert.equal(h.player.layers, immune ? 1 : 2);
    assert.equal(h.calls.breaks, immune ? 0 : 1);
    assert.equal(h.calls.rodDamage, 0);
    assert.equal(h.calls.settlements.length, 1);
  }
  const h = await harness();
  h.player.durability = 30;
  const state = h.create(fish.find(f => f.id === "nightmare_bone_shark"));
  await h.instance.finishSuccess(h.e, state, new h.Manager());
  assert.equal(h.calls.rodDamage, 38);
  assert.equal(h.player.durability, 0);
  assert.equal(h.calls.breaks, 1);
  assert.equal(h.calls.settlements[0].rodId, null);
});

test("真实首领反击没有临时线池或累计断线，锯鲨按命中前张力伤竿", async () => {
  const h = await harness();
  const state = h.create(bosses[1]);
  await h.instance.startFightingPhase(h.e, state, { boss: true });
  assert.equal(Object.hasOwn(state, "bossLineDurability"), false);
  assert.equal(Object.hasOwn(state, "bossLineMaxDurability"), false);
  for (let i = 0; i < 11; i++) await h.instance.executeBossAttack(h.e, state);
  assert.equal(h.calls.breaks, 0);
  assert.equal(h.calls.rodDamage, 22);
  assert.equal(h.calls.settlements.length, 0);
  assert.equal(h.calls.replies.flat().join("\n").includes("鱼线本场"), false);
  assert.equal(h.calls.replies.flat().join("\n").includes("🧵 鱼线\n"), false);
  for (const [tension, expected] of [[39, 2], [40, 3], [79, 3], [80, 4]]) {
    const shark = await harness();
    const fight = shark.create(bosses[3]);
    await shark.instance.startFightingPhase(shark.e, fight, { boss: true });
    fight.tension = tension;
    await shark.instance.executeBossAttack(shark.e, fight);
    assert.equal(shark.calls.rodDamage, expected);
    assert.equal(shark.calls.breaks, 0);
    assert.equal(shark.calls.settlements.length, 0);
  }
});

test("张力达到100仍断线，首领反击和玩家拉距均保留河神保线与失败结算", async () => {
  for (const source of ["counter", "pull"]) for (const protect of [false, true]) {
    const h = await harness();
    const state = h.create(bosses[2], { hasRiverBless: protect });
    await h.instance.startFightingPhase(h.e, state, { boss: true });
    if (source === "counter") {
      state.tension = 87;
      await h.instance.executeBossAttack(h.e, state);
      assert.equal(state.tension, 99);
      assert.equal(h.calls.breaks, 0);
      assert.equal(h.calls.settlements.length, 0);
      state.tension = 88;
      await h.instance.executeBossAttack(h.e, state);
    } else {
      state.tension = 99;
      state.normalTugPressure = 0;
      h.e.msg = "拉";
      await h.instance.handleFishing(h.e);
    }
    assert.equal(h.calls.breaks, protect ? 0 : 1);
    assert.equal(h.calls.refunds, protect && source === "counter" ? 1 : 0);
    assert.equal(h.calls.settlements.length, 1);
    assert.equal(h.calls.settlements[0].success, false);
    assert.equal(h.sessions.get(h.key), null);
  }
});

test("真实首领收竿仍经过鱼线承重，严重超重仍断线且好运护符不绕过", async () => {
  const h = await harness();
  h.player.layers = 0;
  h.create(bosses[0], { fish: { ...bosses[0], actualWeight: 421, effectiveWeight: 421 }, isOverweight: true, hasLucky: true });
  await h.instance.handleFishing(h.e);
  assert.equal(h.calls.breaks, 1);
  assert.equal(h.calls.rodDamage, 10);
  assert.equal(h.calls.settlements.length, 1);
  assert.equal(h.calls.settlements[0].success, false);
  assert.equal(h.sessions.get(h.key), null);
});

test("满耐久熟练20在最大压力、伤害两端及状态轮换边界下必须全胜", () => {
  for (const row of createBossBoundaryReport()) {
    assert.equal(row.failed, 0, `${row.name} 边界失败：${JSON.stringify(row.failures)}`);
    assert.ok(row.maxSeconds < 60, `${row.name} 边界超时`);
    assert.ok(row.maxRodDamage <= 10, `${row.name} 超出满耐久熟练20的竿损余量`);
  }
});

test("满耐久传说竿与秘银线、熟练20、每秒操作必须全胜，耐久损耗仍影响胜率", () => {
  const rod = rods.find(r => r.id === "rod_legendary");
  for (const boss of bosses) {
    const options = { boss, rod, lineCapacity: 210, actionIntervalMs: 1000, iterations: 10000 };
    const novice = simulateBossScenario(options);
    const trained = simulateBossScenario({ ...options, mastery: 20 });
    const experienced = simulateBossScenario({ ...options, mastery: 40 });
    const damaged = simulateBossScenario({ ...options, mastery: 20, durabilityRatio: 0.9 });
    assert.equal(trained.winRate, 1, `${boss.name} 熟练20必须全胜：${JSON.stringify(trained.outcomes)}`);
    assert.equal(experienced.winRate, 1, `${boss.name} 熟练40必须全胜：${JSON.stringify(experienced.outcomes)}`);
    assert.ok(novice.winRate < trained.winRate, `${boss.name} 熟练度未影响挑战`);
    assert.ok(trained.winRodDamage >= 5 && trained.winRodDamage <= 10, `${boss.name} 胜局耐久损耗超出预算`);
    assert.ok(damaged.winRate < trained.winRate - 0.5, `${boss.name} 未计入实时耐久损伤`);
    assert.ok(novice.averageRodDamage > 0);
  }
});
