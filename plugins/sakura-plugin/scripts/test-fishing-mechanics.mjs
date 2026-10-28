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
import * as encounter from "../lib/fishing/encounter.js";
import { createBossBoundaryReport, readBossBalanceInputs, simulateBossScenario } from "./fishing-boss-balance.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fish = JSON.parse(fs.readFileSync(path.join(pluginRoot, "resources/fish/fish.json"), "utf8"));
const { bosses, rods } = readBossBalanceInputs();
// Node 22 的 VM 模块在多次异步测试间保留宿主引用，避免上下文过早回收。
const harnessModules = [];

test("裂魂怨灵作为全钓点全天通用噩梦加载，效果类型通过数据校验", () => {
  const wraith = fish.find(entry => entry.id === "nightmare_soul_wraith");
  assert.ok(wraith);
  assert.equal(wraith.rarity, "噩梦");
  assert.equal(wraith.nightmare_effect.type, "vulnerability");
  assert.equal(wraith.locations, undefined);
  assert.deepEqual(wraith.active_hours, [[0, 24]]);
  assert.deepEqual(rules.validateLegacyFishData(fish), []);
});

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

test("熟练度100封顶提供50控制力，奇数熟练度向下取整", () => {
  for (const [mastery, expected] of [
    [-1, 0], [0, 0], [1, 0], [2, 1], [20, 10], [99, 49],
    [99.9, 49], [100, 50], [101, 50], [200, 50], [10000, 50],
    ["200", 50], [undefined, 0], [NaN, 0],
  ]) {
    assert.equal(rules.getMasteryControlBonus(mastery), expected, `熟练度 ${mastery}`);
  }
  // 高熟练度也先与耐久折算后的竿身控制力相加，再受深压影响。
  const control = rules.calculateRodDurabilityControl(190, 152, 190) + rules.getMasteryControlBonus(200);
  assert.equal(control, 202);
  assert.ok(Math.abs(control * rules.deepPressureMultiplierFromLayers(1) - 161.6) < 1e-9);
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

test("探囊鬼手以100币为偷取上限，余额不超过100时掏空，下一击才重砸", () => {
  const ape = bosses.find(boss => boss.id === "boss_river_ape_king");
  assert.equal(rules.BOSS_COIN_STEAL_MAX, 100);
  assert.equal(ape.boss_mechanic.max, rules.BOSS_COIN_STEAL_MAX);
  for (const coinBalance of [1, 50, 99, 100]) {
    const hit = rules.resolveBossAttack(ape, () => assert.fail("掏空余额不消耗随机数"), { coinBalance });
    assert.equal(hit.coinSteal, coinBalance);
    assert.equal(hit.rodDamage, 2);
    assert.equal(hit.stealFallback, false);
    const next = rules.resolveBossAttack(ape, () => assert.fail("重砸不消耗随机数"), {
      coinBalance: coinBalance - hit.coinSteal,
    });
    assert.equal(next.coinSteal, 0);
    assert.equal(next.rodDamage, 8);
    assert.equal(next.stealFallback, true);
  }
  const fallback = { ...ape, boss_mechanic: { ...ape.boss_mechanic, max: undefined } };
  for (const boss of [ape, fallback]) {
    for (const [roll, expected] of [[0, 0], [0.5, 50], [0.999999999999, 100]]) {
      const hit = rules.resolveBossAttack(boss, () => roll, { coinBalance: 101 });
      assert.equal(hit.coinSteal, expected);
      assert.equal(hit.rodDamage, 2);
      assert.equal(hit.stealFallback, false);
    }
    let coinBalance = 1100;
    for (let round = 1; round <= 11; round++) {
      const hit = rules.resolveBossAttack(boss, () => 1, { coinBalance, attackRound: round });
      assert.equal(hit.coinSteal, 100);
      assert.equal(hit.rodDamage, 2);
      assert.equal(hit.stealFallback, false);
      coinBalance -= hit.coinSteal;
    }
    assert.equal(coinBalance, 0);
  }
});

async function harness({ withImages = false } = {}) {
  const calls = { settlements: [], replies: [], breaks: 0, rodDamage: 0, cooldown: 0, rolls: 0, refunds: 0, immunityRolls: 0 };
  const player = { layers: 1, curseLayers: 5, curseStopped: false, immune: false, roll: 0.95, durability: 190, coins: 1000 };
  class Manager {
    getNightmareStatus() { return { blindnessLayers: player.layers, vulnerable: Boolean(player.vulnerable) }; }
    applyNightmareVulnerability() { const applied = !player.vulnerable; player.vulnerable = true; return { applied }; }
    applyBrideNightmareMultiplier(user, factor) { player.bride = (player.bride || 1) * factor; return { total: player.bride }; }
    addDeepPressureLayers(user, amount) { player.deep = (player.deep || 0) + amount; return { added: amount, total: player.deep }; }
    convertHighestQualityBaitsToWorms(user, kinds) { const converted = player.baits?.splice(0, kinds) || []; return { converted, total: converted.reduce((sum, entry) => sum + entry.count, 0) }; }
    devourRandomInventoryItem(user, excluded = []) { assert.deepEqual(Array.from(excluded), []); return player.items?.shift() || null; }
    getRodMastery() { return 20; }
    getRodControl() { return player.durability; }
    getRodDurabilityInfo() { return { currentDurability: player.durability, maxDurability: player.maxDurability || 190 }; }
    getLineBonusFromMastery() { return 0; }
    rollNightmareImmunity() { calls.immunityRolls++; return { immune: player.immune, active: true, chance: 0.3 }; }
    addNightmareCurseLayers(user, amount) { player.curseStopped = false; player.curseLayers += amount; return player.curseLayers; }
    stopNightmareCurseAccrual() { player.curseStopped = player.curseLayers > 0; }
    addBlindnessLayers(user, amount) { player.layers += amount; return { layers: player.layers, hitRate: rules.getBlindReelHitRate(player.layers) }; }
    addGhostDebt(user, amount) { player.debt = (player.debt || 0) + amount; return { total: player.debt }; }
    breakLine() { calls.breaks++; }
    damageRod(user, rod, amount) { calls.rodDamage += amount; player.durability = Math.max(0, player.durability - amount); return { applied: true, isBroken: player.durability <= 0, currentDurability: player.durability, maxDurability: 190 }; }
  }
  class Settlement {
    settleAttempt(args) { calls.settlements.push(args); return player.settleResult || { success: true }; }
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
    "lodash": { default: { random: (min, max) => player.randomMax ? max : min } },
    "../lib/economy/ShopManager.js": { default: class { findItemById(id) { return { name: id }; } findItemByName() { return null; } } },
    "../lib/GroupDataCleaner.js": { dataCleanupGuards: new Set() },
    "../lib/fishing/rules.js": rules,
    "../lib/fishing/encounter.js": encounter,
    "../lib/setting.js": { default: { getConfig: () => ({ fishingEncounterChance: 0 }) } },
    "../lib/fishing/session.js": { ...session, FishingSessionStore: SessionStore, resolveBlindReel: (state, layers) => session.resolveBlindReel(state, layers, () => { calls.rolls++; return player.roll; }) },
    "../lib/economy/FishingManager.js": { default: Manager },
    "../lib/economy/EconomyManager.js": { default: class {
      getCoins() { return player.coins; }
      addCoins(e, amount) { player.coins += amount; }
      reduceCoins(e, amount) { player.coins -= amount; }
    } },
    "../lib/fishing/SettlementService.js": { default: Settlement },
    "../lib/fishing/fishData.js": { getFishData: () => fish, getFishIdSet: () => new Set(fish.map(f => f.id)), getLocationExclusiveFish: () => [] },
    "../lib/path.js": { pluginresources: withImages ? path.join(pluginRoot, "resources") : "/isolated/resources" },
    "node:fs": { default: { existsSync: imagePath => withImages && fs.existsSync(imagePath) } },
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
    assert.equal(h.calls.immunityRolls, 0);
    assert.equal(h.calls.settlements[0].success, false);
    assert.equal(h.calls.settlements[0].earnings, 0);
    assert.equal(h.calls.settlements[0].recordCatch, false);
    assert.equal(h.calls.settlements[0].masteryGain, 0);
    assert.equal(h.calls.breaks, 0);
    assert.equal(h.calls.rodDamage, 0);
    assert.equal(h.calls.cooldown, 1);
    assert.equal(h.player.layers, 1);
    assert.equal(h.player.curseStopped, false);
    assert.equal(state.reelAccuracy.hit, false);
    assert.equal(h.sessions.get(h.key), null);
  }
});

test("完整免疫覆盖所有噩梦，河神在免疫未触发时仍只保线", async () => {
  for (const entry of fish.filter(entry => entry.rarity === "噩梦")) {
    const h = await harness();
    h.player.immune = true;
    const state = h.create(entry, { hasRiverBless: true });
    h.instance.applyNightmareEffect = async () => assert.fail("免疫触发后不应执行任何噩梦惩罚");
    await h.instance.finishSuccess(h.e, state, new h.Manager());
    assert.equal(h.calls.immunityRolls, 1);
    assert.equal(h.player.curseLayers, 5);
    assert.equal(h.calls.breaks, 0);
    assert.equal(h.calls.rodDamage, 0);
    assert.equal(h.calls.refunds, 0);
    assert.equal(h.calls.settlements.length, 1);
    assert.equal(h.player.coins, 1000);
  }
  const h = await harness();
  const state = h.create(fish.find(entry => entry.id === "nightmare_lake_corpse_fisher"), { hasRiverBless: true });
  await h.instance.finishSuccess(h.e, state, new h.Manager());
  assert.equal(h.calls.immunityRolls, 1);
  assert.equal(h.calls.breaks, 0);
  assert.equal(h.calls.refunds, 1);
  assert.equal(h.player.layers, 2);
});

test("钓到非骷髅噩梦停止诅咒叠加并保留层数，完整免疫也能停止叠加", async () => {
  for (const { id } of fish.filter(entry => entry.rarity === "噩梦" && entry.nightmare_effect?.type !== "curse")) {
    for (const immune of [false, true]) {
      const h = await harness();
      h.player.immune = immune;
      h.instance.applyNightmareEffect = async ({ expGain }) => ({ message: "", expGain, rodBroken: false, ghostLoanIssued: false });
      const state = h.create(fish.find(entry => entry.id === id));
      await h.instance.finishSuccess(h.e, state, new h.Manager());
      assert.equal(h.player.curseLayers, 5, `${id} 免疫=${immune} 应保留旧诅咒`);
      assert.equal(h.player.curseStopped, true, `${id} 免疫=${immune} 应停止逐竿叠加`);
      assert.equal(h.calls.settlements.length, 1);
    }
  }
});

test("骷髅在原有诅咒上加一层并恢复叠加，免疫阻止新增，重复收竿不重复叠层", async () => {
  for (const initialLayers of [0, 5]) for (const stopped of [false, true]) for (const immune of [false, true]) {
    const h = await harness();
    h.player.layers = 0;
    h.player.curseLayers = initialLayers;
    h.player.curseStopped = stopped;
    h.player.immune = immune;
    h.create(fish.find(entry => entry.id === "nightmare_cursed_skull"), { hasLucky: true });
    await Promise.all([h.instance.handleFishing(h.e), h.instance.handleFishing(h.e)]);
    const expectedLayers = initialLayers + Number(!immune);
    assert.equal(h.player.curseLayers, expectedLayers);
    assert.equal(h.player.curseStopped, immune ? stopped : false);
    assert.equal(h.calls.immunityRolls, 1);
    assert.equal(h.calls.settlements.length, 1);
    assert.equal(h.sessions.get(h.key), null);
    const message = h.calls.replies.flat(2).join("\n");
    assert.equal(message.includes(`☠️ 诅咒附身！噩梦诅咒缠上了你，当前 ${expectedLayers} 层。此后每抛一竿层数 +1，钓到其他噩梦后停止叠加`), !immune);
  }
});

test("幽灵船真实结算放款四百，当竿不计息，完整免疫同时挡下放款与欠款", async () => {
  for (const immune of [false, true]) {
    const h = await harness();
    h.player.immune = immune;
    const state = h.create(fish.find(entry => entry.id === "nightmare_coast_ghost_ship"));
    await h.instance.finishSuccess(h.e, state, new h.Manager());
    assert.equal(h.player.coins, immune ? 1000 : 1400);
    assert.equal(h.player.debt || 0, immune ? 0 : 400);
    assert.equal(h.calls.settlements[0].accrueGhostInterest, immune);
    assert.equal(Boolean(h.calls.settlements[0].ghostLoanIssued), !immune);
    const message = h.calls.replies.flat(2).join("\n");
    assert.equal(message.includes("💰 还清前，垂钓所得会全额抵债。"), !immune);
    assert.equal(message.includes("📈 从下一竿起，每竿未清部分涨到 1.25 倍。"), !immune);
    assert.equal(message.includes("🩸 滚到800仍未还清就勾销债务，代价是垂钓所得永远被抽走10%"), !immune);
    assert.equal(message.includes("4 竿内必须还清"), false);
    assert.equal(message.includes("只有钓上来的鱼"), false);
  }
});

test("裂魂怨灵施加易伤不自我放大，重复与免疫遵守持久状态规则", async () => {
  for (const vulnerable of [false, true]) for (const immune of [false, true]) {
    const h = await harness();
    h.player.vulnerable = vulnerable;
    h.player.immune = immune;
    const state = h.create(fish.find(f => f.id === "nightmare_soul_wraith"));
    await h.instance.finishSuccess(h.e, state, new h.Manager());
    assert.equal(Boolean(h.player.vulnerable), vulnerable || !immune);
    assert.equal(h.calls.rodDamage, 0);
    assert.equal(h.calls.breaks, Number(!immune));
    const message = h.calls.replies.flat(2).join("\n");
    assert.equal(message.includes("本次惩罚翻倍"), false);
    assert.equal(message.includes("易伤持续生效"), vulnerable && !immune);
    assert.equal(message.includes("留下魂裂"), !vulnerable && !immune);
    assert.equal(message.includes("直到被净化"), false);
    assert.equal(h.player.curseStopped, true);
  }
});

test("裂魂怨灵真实结算从鱼种同名PNG读取并发送图片", async () => {
  const imagePath = path.join(pluginRoot, "resources/fish/img/nightmare_soul_wraith.png");
  const png = fs.readFileSync(imagePath);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 204);
  assert.equal(png.readUInt32BE(20), 204);
  const h = await harness({ withImages: true });
  const state = h.create(fish.find(entry => entry.id === "nightmare_soul_wraith"));
  await h.instance.finishSuccess(h.e, state, new h.Manager());
  const message = h.calls.replies.flat(2);
  assert.ok(message.includes(`file:///${imagePath}`));
  assert.equal(h.player.vulnerable, true);
});

test("易伤覆盖伤竿、偷钱、各类叠层和借款，完整免疫与重复收竿不多扣", async () => {
  for (const immune of [false, true]) {
    for (const [id, verify] of [
      ["monster_mimic", h => assert.equal(h.calls.rodDamage, 40)],
      ["nightmare_bone_shark", h => assert.equal(h.calls.rodDamage, 78)],
      ["nightmare_thief_murloc", h => assert.equal(h.player.coins, 200)],
      ["nightmare_void_devourer", h => assert.equal(h.player.coins, 600)],
      ["nightmare_cursed_skull", h => assert.equal(h.player.curseLayers, 7)],
      ["nightmare_pond_drowned_bride", h => assert.equal(h.player.bride, 8)],
      ["nightmare_lake_corpse_fisher", h => assert.equal(h.player.layers, 3)],
      ["nightmare_abyss_diving_bell", h => assert.equal(h.player.deep, 3)],
      ["nightmare_coast_ghost_ship", h => { assert.equal(h.player.coins, 1400); assert.equal(h.player.debt, 1100); }],
    ]) {
      const h = await harness();
      Object.assign(h.player, { vulnerable: true, immune, randomMax: true, bride: 2, deep: 1, debt: 300, maxDurability: 191 });
      const state = h.create(fish.find(f => f.id === id), { hasRiverBless: true });
      assert.equal(await h.instance.finishSuccess(h.e, state, new h.Manager()), true);
      assert.equal(await h.instance.finishSuccess(h.e, state, new h.Manager()), false);
      assert.equal(h.calls.settlements.length, 1);
      assert.equal(h.calls.breaks, 0);
      assert.equal(h.player.vulnerable, true);
      const message = h.calls.replies.flat(2).join("\n");
      assert.equal(message.includes("易伤生效，本次惩罚翻倍"), !immune);
      if (!immune) verify(h);
      else {
        assert.equal(h.player.coins, 1000);
        assert.equal(h.calls.rodDamage, 0);
        assert.equal(h.player.layers, 1);
        assert.equal(h.player.curseLayers, 5);
        assert.equal(h.player.bride, 2);
        assert.equal(h.player.deep, 1);
        assert.equal(h.player.debt, 300);
      }
    }
  }
});

test("易伤偷取不足不追加伤竿，食星之影无伤竿兜底，其他偷取保留兜底", async () => {
  for (const id of ["nightmare_river_water_monkey", "nightmare_mystic_star_eater"]) {
    for (const count of [0, 1, 2]) {
      const h = await harness();
      h.player.vulnerable = true;
      h.player.baits = Array.from({ length: count }, (_, i) => ({ bait: { name: `bait-${i}` }, count: 10 + i }));
      h.player.items = Array.from({ length: count }, (_, i) => ({ itemId: `item-${i}` }));
      const state = h.create(fish.find(f => f.id === id));
      await h.instance.finishSuccess(h.e, state, new h.Manager());
      assert.equal(h.calls.rodDamage, id === "nightmare_river_water_monkey" && count === 0 ? 40 : 0);
      assert.equal(id.includes("monkey") ? h.player.baits.length : h.player.items.length, 0);
      assert.equal(h.calls.breaks, 1);
      const message = h.calls.replies.flat(2).join("\n");
      if (count) assert.ok(message.includes(id.includes("monkey") ? "bait-0" : "item-0"));
      if (count === 2) assert.ok(message.includes(id.includes("monkey") ? "bait-1" : "item-1"));
    }
  }
  for (const id of ["nightmare_thief_murloc", "nightmare_void_devourer"]) for (const coins of [0, 1, 100]) {
    const h = await harness();
    Object.assign(h.player, { vulnerable: true, coins, randomMax: true });
    await h.instance.finishSuccess(h.e, h.create(fish.find(f => f.id === id)), new h.Manager());
    assert.equal(h.calls.rodDamage, coins === 0 ? 40 : 0);
    assert.ok(h.player.coins >= 0);
    if (id.includes("murloc")) assert.equal(h.player.coins, 0);
  }
});

test("水猴普通调包一种、易伤两种，免疫和重复结算不调包，无目标按易伤损竿", async () => {
  for (const vulnerable of [false, true]) for (const immune of [false, true]) for (const count of [0, 1, 3]) {
    const h = await harness();
    Object.assign(h.player, { vulnerable, immune, baits: Array.from({ length: count }, (_, i) => ({ bait: { name: `鱼饵${i}` }, count: 30 + i })) });
    const state = h.create(fish.find(f => f.id === "nightmare_river_water_monkey"));
    await h.instance.finishSuccess(h.e, state, new h.Manager());
    await h.instance.finishSuccess(h.e, state, new h.Manager());
    const kinds = immune ? 0 : Math.min(count, vulnerable ? 2 : 1);
    assert.equal(h.player.baits.length, count - kinds);
    assert.equal(h.calls.rodDamage, !immune && count === 0 ? (vulnerable ? 40 : 20) : 0);
    const message = h.calls.replies.flat(2).join("\n");
    if (kinds) assert.ok(message.includes(`蚯蚓 ×${kinds === 2 ? 61 : 30}`));
    assert.equal(h.calls.settlements.length, 1);
  }
});

test("失败竿欠款达到八百也播报新增印记层数和连乘倍率，重复失败不再次结算", async () => {
  const h = await harness();
  h.player.settleResult = {
    success: true, writtenOff: true, ghostMarkLayers: 2, ghostMarkMultiplier: 0.81,
  };
  const state = h.create(fish.find(entry => entry.rarity === "普通"));
  assert.equal(await h.instance.finishFailedAttempt(h.e, state), true);
  assert.equal(await h.instance.finishFailedAttempt(h.e, state), false);
  assert.equal(h.calls.settlements.length, 1);
  const message = h.calls.replies.flat(2).join("\n");
  assert.ok(message.includes("欠款已达 800"));
  assert.equal(message.includes("竿期限"), false);
  assert.ok(message.includes("当前 2 层"));
  assert.ok(message.includes("×0.81"));
});

test("重复收竿消息只判定一次噩梦免疫", async () => {
  const h = await harness();
  h.player.layers = 0;
  h.player.immune = true;
  h.create(fish.find(entry => entry.id === "nightmare_lake_corpse_fisher"), { hasLucky: true });
  await Promise.all([h.instance.handleFishing(h.e), h.instance.handleFishing(h.e)]);
  assert.equal(h.calls.immunityRolls, 1);
  assert.equal(h.calls.settlements.length, 1);
  assert.equal(h.calls.breaks, 0);
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
    assert.equal(h.calls.immunityRolls, 1);
    assert.equal(h.player.curseLayers, 5);
    const message = h.calls.replies.flat(2).join("\n");
    assert.equal(message.includes("概率完整免疫"), false);
    assert.equal(message.includes("本次已触发"), false);
    assert.equal(message.includes("本次未触发"), false);
    assert.equal(message.includes("猎魔守护完全隔绝了这次噩梦"), immune);
    assert.equal(message.includes("免疫储存"), false);
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

test("食星之影吞掉当前鱼竿后不再结算该竿熟练度，易伤仍继续吞取", async () => {
  for (const items of [
    [{ itemId: "rod_legendary" }],
    [{ itemId: "rod_legendary" }, { itemId: "bait_worm" }],
    [{ itemId: "bait_worm" }, { itemId: "rod_legendary" }],
    [{ itemId: "rod_carbon" }],
  ]) {
    const h = await harness();
    const losesCurrentRod = items.some(item => item.itemId === "rod_legendary");
    h.player.vulnerable = true;
    h.player.items = [...items];
    const state = h.create(fish.find(f => f.id === "nightmare_mystic_star_eater"));
    await h.instance.finishSuccess(h.e, state, new h.Manager());
    assert.equal(h.calls.settlements[0].rodId, losesCurrentRod ? null : "rod_legendary");
    assert.equal(h.player.items.length, 0);
    assert.equal(h.calls.rodDamage, 0);
  }
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
