// node --experimental-vm-modules --test plugins/sakura-plugin/scripts/test-fishing-encounter-integration.mjs
// 在真实指令代码中检查遭遇入口、计时和奖励，数据库、QQ 与浏览器边界均隔离。
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as rules from "../lib/fishing/rules.js";
import * as session from "../lib/fishing/session.js";
import * as encounter from "../lib/fishing/encounter.js";
import { FISHING_ENCOUNTER_GUIDE_FILE, buildEncounterGuideHtml } from "../lib/fishing/encounterGuide.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(pluginRoot, "apps/fishing.js"), "utf8");
const fishes = JSON.parse(fs.readFileSync(path.join(pluginRoot, "resources/fish/fish.json"), "utf8"));
const ordinary = { id: "test-fish", name: "测试鱼", rarity: "普通", base_price: 100, weight: [1, 1], difficulty: 1, description: "测试" };
const retained = []; // Node 22 VM 模块须保留宿主引用至测试结束。

async function harness({ chance = 1, sendImage, renderImage, exists = false } = {}) {
  const calls = { generated: 0, replies: [], settlements: [], cooldown: 0, contexts: [], effects: 0, breaks: 0, forward: null, warnings: [] };
  const clock = { now: 1_000_000 };
  const timers = new Map();
  let nextTimer = 0, sessions, lastMap;
  const setTimer = (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; };
  const clearTimer = id => timers.delete(id);
  class SessionStore extends session.FishingSessionStore { constructor() { super({ clearTimer }); sessions = this; } }
  class Manager {
    static async migrateLegacyWishKeys() { return { koiWish: 0, starWish: 0 }; }
    getNightmareStatus() { return { blindnessLayers: 0 }; }
    getRodMastery() { return 20; }
    getRodControl() { return 190; }
    getLineBonusFromMastery() { return 0; }
    getMerchantCoinMultiplier() { return 1; }
    async getFishPriceMultiplier() { return 1; }
    resetNightmareCurse() {}
    rollNightmareImmunity() { return { immune: false }; }
    breakLine() { calls.breaks++; }
  }
  class Settlement {
    settleAttempt(args) { calls.settlements.push({ method: "attempt", ...args }); return { success: true }; }
    settleInventoryCatch(args) { calls.settlements.push({ method: "inventory", ...args }); return { success: true }; }
    settleCoinCatch(args) { calls.settlements.push({ method: "coin", ...args }); return { success: true, ...args }; }
  }
  class ClockDate extends Date { static now() { return clock.now; } }
  const context = vm.createContext({
    console, Date: ClockDate, setTimeout: setTimer, clearTimeout: clearTimer, redis: {},
    plugin: class {
      finish() {} setContext(...args) { calls.contexts.push(args); }
      getScopeKey(...parts) { return JSON.stringify(parts); } destroy() {}
    },
    Command: (_pattern, fn) => fn, Cron: (_pattern, fn) => fn,
    logger: { warn: (...args) => calls.warnings.push(args), info() {}, error: (...args) => assert.fail(args.join(" ")) },
    segment: { image: file => ({ type: "image", data: { file } }), at: qq => ({ type: "at", data: { qq } }) },
  });
  const imports = {
    "../lib/fishing/rules.js": { ...rules, rollFishExp: () => 10, calculateForcePullSuccessRate: () => 1 },
    "../lib/fishing/session.js": { ...session, FishingSessionStore: SessionStore },
    "../lib/fishing/encounter.js": encounter,
    "../lib/fishing/encounterImages.js": {
      createFishingEncounterImage: async () => {
        calls.generated++;
        if (renderImage) return renderImage();
        lastMap = encounter.generateEncounterMaps({ count: 1, seed: `integration-${calls.generated}` })[0];
        return { map: lastMap, image: Buffer.from("隔离测试图片") };
      }, closeFishingEncounterBrowser: async () => {},
    },
    "../lib/fishing/encounterGuide.js": { FISHING_ENCOUNTER_GUIDE_FILE },
    "../lib/economy/FishingManager.js": { default: Manager },
    "../lib/economy/EconomyManager.js": { default: class {} },
    "../lib/economy/ShopManager.js": { default: class { findItemById() { return { name: "当地宝箱" }; } } },
    "../lib/fishing/SettlementService.js": { default: Settlement },
    "../lib/fishing/fishData.js": { getFishData: () => fishes, getFishIdSet: () => new Set(fishes.map(fish => fish.id)), getLocationExclusiveFish: () => [] },
    "../lib/fishing/shinyImage.js": { getShinyFishImagePath: async () => null },
    "../lib/setting.js": { default: { getConfig: () => ({ fishingEncounterChance: chance, gamegroups: ["group"] }) } },
    "../lib/path.js": { pluginresources: "/isolated/resources" },
    "../lib/economy/redisAtomic.js": { acquireRedisLock: async () => true, releaseRedisLock: async () => true, completeFishingAttempt: async () => true },
    "../../../src/core/plugin.js": { eventStorage: new AsyncLocalStorage() },
    "node:fs": { default: { existsSync: () => exists } },
    "node:path": { default: path }, "node:crypto": { randomUUID }, "node:url": { pathToFileURL },
  };
  const app = new vm.SourceTextModule(source, { context });
  retained.push(app, context);
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
    retained.push(dependency);
    return dependency;
  });
  await app.evaluate();
  const instance = new app.namespace.default();
  instance.setCooldownAndIncrement = async () => { calls.cooldown++; };
  instance.applyNightmareEffect = async ({ expGain }) => { calls.effects++; return { message: "原噩梦效果", expGain }; };
  const e = {
    group_id: "group", user_id: "user", msg: "收竿",
    reply: async (...args) => { calls.replies.push(args); if (args[0]?.type === "image" && sendImage) return sendImage(); return { message_id: "receipt" }; },
    react: async () => {}, sendForwardMsg: async (...args) => { calls.forward = args; },
  };
  const key = instance.buildFishingStateKey(e.group_id, e.user_id);
  const create = (fish = ordinary, extra = {}) => sessions.create(key, {
    id: randomUUID(), phase: session.FISHING_PHASE.weightCheck,
    fish: { ...fish, actualWeight: fish.weight?.[0] || 1, effectiveWeight: fish.weight?.[0] || 1 },
    rodConfig: { id: "rod_legendary", name: "传说之竿" },
    lineConfig: { id: "line_mythril", name: "秘银钓线", capacity: 1_000_000 },
    cleanup: () => sessions.finish(key), ...extra,
  });
  const answer = async (msg, elapsed = 0) => {
    const state = sessions.get(key);
    clock.now = state.encounter.attempt.startedAt + elapsed;
    return instance.handleFishing({ ...e, msg });
  };
  const correct = () => encounter.solveEncounter(lastMap)[0].sequence;
  return { instance, e, create, calls, clock, sessions, key, Manager, timers, answer, correct };
}

test("毕业装备真实收竿入口必须先完成遭遇，旧计时器停止", async () => {
  for (const hasLucky of [false]) {
    const h = await harness();
    const timerIds = [...Array(5)].map((_, index) => { const id = 100 + index; h.timers.set(id, {}); return id; });
    const state = h.create(ordinary, { hasLucky, waitingTimer: timerIds[0], totalTimer: timerIds[1], confirmTimer: timerIds[2], fishStateTimer: timerIds[3], bossAttackTimer: timerIds[4] });
    await h.instance.handleFishing(h.e);
    assert.equal(state.phase, session.FISHING_PHASE.encounter);
    assert.doesNotMatch(h.calls.replies[0][0], /玩法见|#钓鱼攻略/);
    assert.equal(h.calls.settlements.length, 0);
    assert.equal(h.calls.generated, 1);
    assert.ok(h.calls.contexts.some(args => args[2] === 65 && args[3] === true), "出图后必须刷新旧会话时限");
    assert.ok(timerIds.every(id => !h.timers.has(id)));
    // 重复调用成功入口不能越过正在进行的遭遇。
    assert.equal(await h.instance.finishSuccess(h.e, state, new h.Manager()), false);
    await h.answer(h.correct(), 30_000);
    assert.equal(h.calls.settlements.length, 1);
    assert.equal(h.calls.settlements[0].earnings, 200);
    assert.equal(h.calls.settlements[0].expGain, 20);
    const message = h.calls.replies.at(-1)[0].join("");
    assert.match(message, /水路遭遇成功！用时 30\.0 秒，樱花币×2，经验×2/);
    assert.ok(message.indexOf("水路遭遇成功") < message.indexOf("💰 价值"));
    assert.equal(message.match(/水路遭遇成功/g).length, 1);
    assert.equal(h.calls.cooldown, 1);
    assert.equal(h.timers.size, 0);
    assert.equal(h.sessions.get(h.key), null);
  }
});

test("45 秒与临近 60 秒按线性倍率结算整数金币和经验，其他收益加成继续叠加", async () => {
  for (const [elapsed, earnings, expGain] of [[45_000, 150, 15], [59_999, 100, 10]]) {
    const h = await harness();
    const state = h.create();
    await h.instance.handleFishing(h.e);
    await h.answer(h.correct(), elapsed);
    assert.equal(h.calls.settlements[0].earnings, earnings);
    assert.equal(h.calls.settlements[0].expGain, expGain);
    const message = h.calls.replies.at(-1)[0].join("");
    const multiplier = elapsed === 45_000 ? "1.5" : "1";
    assert.ok(message.includes(`樱花币×${multiplier}，经验×${multiplier}`));
    assert.ok(message.indexOf("水路遭遇成功") < message.indexOf("💰 价值"));
  }
  const h = await harness();
  const state = h.create(ordinary, { biteTime: h.clock.now, hasMonsterBait: true, hasDoubleCoin: true, environment: { expMultiplier: 2, priceMultiplier: 2 } });
  await h.instance.handleFishing(h.e);
  await h.answer(h.correct(), 30_000);
  assert.equal(h.calls.settlements[0].earnings, 100 * 2 * 3 * 2 * 2);
  assert.equal(h.calls.settlements[0].expGain, 10 * 3 * 2 * 2);
  assert.equal(state.isPerfect, false);
});

test("水路遭遇取消普通鱼、噩梦与宝藏的完美收竿经验和提示", async () => {
  for (const fish of [ordinary, fishes.find(fish => fish.rarity === "噩梦"), fishes.find(fish => fish.rarity === "宝藏")]) {
    const h = await harness();
    const state = h.create(fish, { biteTime: h.clock.now });
    await h.instance.handleFishing(h.e);
    assert.equal(state.phase, session.FISHING_PHASE.encounter);
    assert.equal(state.isPerfect, false);
    await h.answer(h.correct(), 45_000);
    assert.equal(h.calls.settlements[0].expGain, 15, "只保留基础经验与 1.5 倍遭遇奖励");
    assert.equal(h.calls.replies.some(args => JSON.stringify(args).includes("完美收竿")), false);
  }
});

test("未遭遇和好运护符仍可完美收竿，生图故障也保留原判定", async () => {
  for (const options of [{ chance: 0 }, { lucky: true }, { renderImage: () => { throw new Error("渲染失败"); } }]) {
    const h = await harness(options);
    const state = h.create(ordinary, { biteTime: h.clock.now, hasLucky: Boolean(options.lucky) });
    await h.instance.handleFishing(h.e);
    assert.equal(state.isPerfect, true);
    assert.equal(h.calls.settlements[0].expGain, 10 * rules.PERFECT_EXP_MULTIPLIER);
    assert.equal(h.calls.replies.some(args => JSON.stringify(args).includes("完美收竿")), true);
  }
});

test("异色鱼金币与经验仍叠加遭遇倍率", async () => {
  const h = await harness();
  const state = h.create(ordinary, { fish: { ...ordinary, actualWeight: 1, isShiny: true } });
  await h.instance.handleFishing(h.e);
  await h.answer(h.correct(), 30_000);
  assert.equal(h.calls.settlements[0].earnings, 100 * rules.SHINY_PRICE_MULTIPLIER * 2);
  assert.equal(h.calls.settlements[0].expGain, 10 * rules.SHINY_EXP_MULTIPLIER * 2);
});

test("噩梦与宝藏只增加经验，答错时不执行噩梦效果和宝箱入库", async () => {
  for (const fish of [fishes.find(fish => fish.rarity === "噩梦"), fishes.find(fish => fish.rarity === "宝藏")]) {
    for (const success of [true, false]) {
      const h = await harness();
      const state = h.create(fish);
      await h.instance.handleFishing(h.e);
      assert.equal(h.calls.effects, 0);
      assert.equal(h.calls.breaks, 0);
      await h.answer(success ? h.correct() : "abx", 30_000);
      const result = h.calls.settlements[0];
      assert.equal(result.expGain, success ? 20 : undefined);
      assert.equal(result.earnings || 0, 0);
      assert.equal(result.rewardItemCount, undefined);
      assert.equal(result.success, fish.rarity === "宝藏" && success ? undefined : success);
      assert.equal(result.method, fish.rarity === "宝藏" && success ? "inventory" : "attempt");
      assert.equal(h.calls.effects, fish.rarity === "噩梦" && success ? 1 : 0);
      assert.equal(h.calls.breaks, fish.rarity === "噩梦" && success ? 1 : 0);
      if (success) {
        const message = h.calls.replies.at(-1)[0].join("");
        assert.match(message, /经验×2（仅经验加成）/);
        assert.doesNotMatch(message, /樱花币×2/);
      }
    }
  }
});

test("所有首领直接按原奖励结算，概率为 1 也不触发；概率为 0 关闭普通遭遇", async () => {
  for (const fish of fishes.filter(rules.isBossFish)) {
    const h = await harness();
    const state = h.create(fish);
    const original = rules.calculateBossCatchReward(state.fish);
    await h.instance.finishSuccess(h.e, state, new h.Manager());
    assert.equal(h.calls.generated, 0);
    assert.equal(h.calls.settlements[0].earnings, original.earnings);
    assert.equal(h.calls.settlements[0].expGain, original.expGain);
    assert.equal(h.calls.settlements[0].rewardItemCount, original.rewardItemCount);
  }
  const h = await harness({ chance: 0 });
  h.create();
  await h.instance.handleFishing(h.e);
  assert.equal(h.calls.generated, 0);
  assert.equal(h.calls.settlements[0].earnings, 100);
});

test("好运护符完全跳过遭遇，重量判定未通过也不能提前触发", async () => {
  const lucky = await harness();
  lucky.create(ordinary, { hasLucky: true });
  await lucky.instance.handleFishing(lucky.e);
  assert.equal(lucky.calls.generated, 0);
  assert.equal(lucky.calls.settlements[0].earnings, 100);
  assert.equal(lucky.calls.settlements[0].expGain, 10);
  const weight = await harness();
  weight.create(ordinary, { isOverweight: true, fish: { ...ordinary, actualWeight: 3_000_000, effectiveWeight: 3_000_000 } });
  weight.Manager.prototype.damageRod = () => ({ applied: false });
  await weight.instance.handleFishing(weight.e);
  assert.equal(weight.calls.generated, 0);
  assert.equal(weight.calls.settlements[0].success, false);
});

test("遭遇先于困难度判定，成功后难鱼仍需强拉，奖励倍率沿用首次答题时间", async () => {
  const h = await harness();
  const state = h.create(ordinary, { fish: { ...ordinary, actualWeight: 1, effectiveWeight: 1, difficulty: 210 } });
  await h.instance.handleFishing(h.e);
  assert.equal(state.phase, session.FISHING_PHASE.encounter);
  assert.equal(h.calls.replies.some(args => JSON.stringify(args).includes("强拉")), false);
  await h.answer(h.correct(), 45_000);
  assert.equal(state.phase, session.FISHING_PHASE.difficultyCheck);
  assert.equal(h.calls.settlements.length, 0);
  assert.equal(h.calls.replies.some(args => JSON.stringify(args).includes("强拉")), true);
  h.clock.now += 20_000;
  await h.instance.handleFishing({ ...h.e, msg: "强拉" });
  assert.equal(h.calls.generated, 1);
  assert.equal(h.calls.settlements[0].earnings, 150);
  assert.equal(h.calls.settlements[0].expGain, 15);
});

test("首次纯操作串的语法或路线错误使鱼逃走，并发正确答案不能二次作答", async () => {
  for (const msg of ["abx", "a", "x"]) {
    const h = await harness();
    const state = h.create();
    await h.instance.handleFishing(h.e);
    h.clock.now += 5000;
    await Promise.all([h.instance.handleFishing({ ...h.e, msg }), h.instance.handleFishing({ ...h.e, msg: h.correct() })]);
    assert.equal(h.calls.settlements.length, 1);
    assert.equal(h.calls.settlements[0].success, false);
    assert.equal(h.calls.settlements[0].recordCatch, true);
    assert.equal(h.calls.settlements[0].masteryGain, 0);
    assert.equal(h.calls.cooldown, 1);
    assert.equal(h.timers.size, 0);
  }
});

test("聊天、空消息和混入其他字符的消息不占用答案机会或刷新计时", async () => {
  const h = await harness();
  const state = h.create();
  await h.instance.handleFishing(h.e);
  const startedAt = state.encounter.attempt.startedAt;
  const timerId = state.encounterTimer;
  const contextsBefore = h.calls.contexts.length;
  for (const msg of ["", "等等", "帮我看这张图", `答案是${h.correct()}`, "Ax yy Bxxx", "AxyyBxxx!", "#钓鱼攻略", "↑↓"]) {
    h.clock.now += 1000;
    await h.instance.handleFishing({ ...h.e, msg });
    assert.equal(state.encounter.inputReceived, false);
    assert.equal(state.encounter.pendingInput, null);
    assert.equal(state.encounter.attempt.submitted, false);
    assert.equal(state.encounter.attempt.startedAt, startedAt);
    assert.equal(state.encounterTimer, timerId);
    assert.equal(h.calls.settlements.length, 0);
  }
  assert.equal(h.calls.contexts.length, contextsBefore);
  await h.answer(h.correct(), 45_000);
  assert.equal(h.calls.settlements.length, 1);
  assert.equal(h.calls.settlements[0].earnings, 150);
});

test("真实遭遇接受未用完行动的路线，超出上限仍使鱼逃走", async () => {
  for (const success of [true, false]) {
    const h = await harness();
    const state = h.create();
    await h.instance.handleFishing(h.e);
    const choices = encounter.analyzeEncounterChoices(state.encounter.map);
    const route = (success ? choices.underRoutes : choices.overRoutes)[0];
    assert.ok(route);
    await h.answer(route.sequence, 30_000);
    assert.equal(h.calls.settlements.length, 1);
    if (success) {
      assert.equal(h.calls.settlements[0].earnings, 200);
      assert.ok(state.encounterResult.actions < state.encounter.map.limits.actions);
    } else {
      assert.equal(h.calls.settlements[0].success, false);
      assert.equal(h.calls.settlements[0].earnings, 0);
    }
  }
});

test("只发聊天消息也会按原截止时间自动超时", async () => {
  const h = await harness();
  const state = h.create();
  await h.instance.handleFishing(h.e);
  h.clock.now += 59_000;
  await h.instance.handleFishing({ ...h.e, msg: "再给我一点时间" });
  h.clock.now += 1000;
  await h.instance.handleFishingTimeout(h.e, h.key, state.id, { expectedPhase: session.FISHING_PHASE.encounter, timerName: "encounterTimer" });
  assert.equal(h.calls.settlements.length, 1);
  assert.equal(h.calls.settlements[0].success, false);
});

test("60 秒整提交正确答案和无提交自动超时都按失败结算一次", async () => {
  const h = await harness();
  const state = h.create();
  await h.instance.handleFishing(h.e);
  await h.answer(h.correct(), 60_000);
  assert.equal(h.calls.settlements[0].success, false);
  const timeout = await harness();
  const timed = timeout.create();
  await timeout.instance.handleFishing(timeout.e);
  timeout.clock.now += 60_000;
  const timer = timeout.timers.get(timed.encounterTimer);
  assert.equal(timer.ms, 60_000);
  timer.fn();
  await timeout.instance.handleFishingTimeout(timeout.e, timeout.key, timed.id, { expectedPhase: session.FISHING_PHASE.encounter, timerName: "encounterTimer" });
  assert.equal(timeout.calls.settlements.length, 1);
  assert.equal(timeout.calls.settlements[0].success, false);
});

test("发图等待回执时的首条答案不会丢失，回执时间之前的消息按 0 秒成功", async () => {
  let releaseSend, signalSend;
  const sending = new Promise(resolve => { signalSend = resolve; });
  const receipt = new Promise(resolve => { releaseSend = resolve; });
  const h = await harness({ sendImage: () => { signalSend(); return receipt; } });
  const state = h.create();
  const reel = h.instance.handleFishing(h.e);
  await sending;
  assert.equal(state.encounter.attempt, null);
  assert.equal(state.processing, true);
  await h.instance.handleFishing({ ...h.e, msg: "图片来了，等我看看" });
  assert.equal(state.encounter.inputReceived, false);
  h.clock.now += 20_000;
  await h.instance.handleFishing({ ...h.e, msg: h.correct() });
  await h.instance.handleFishing({ ...h.e, msg: "abx" });
  assert.equal(h.calls.settlements.length, 0);
  h.clock.now += 10_000;
  releaseSend({ message_id: "sent" });
  await reel;
  assert.equal(state.encounterResult.elapsedMs, 0);
  assert.equal(h.calls.settlements.length, 1);
  assert.equal(h.calls.settlements[0].earnings, 200);
});

test("处理锁暂存的答案使用到达时间，超时回调不能抢先结算", async () => {
  const h = await harness();
  const state = h.create();
  await h.instance.handleFishing(h.e);
  h.sessions.claimAction(h.key, state.id);
  await h.answer(h.correct(), 29_000);
  h.clock.now = state.encounter.attempt.startedAt + 61_000;
  const timeoutArgs = { expectedPhase: session.FISHING_PHASE.encounter, timerName: "encounterTimer" };
  await h.instance.handleFishingTimeout(h.e, h.key, state.id, timeoutArgs);
  assert.equal(h.calls.settlements.length, 0);
  h.sessions.releaseAction(h.key, state.id);
  await h.instance.handleFishingTimeout(h.e, h.key, state.id, timeoutArgs);
  assert.equal(h.calls.settlements[0].earnings, 200);
  assert.equal(state.encounterResult.elapsedMs, 29_000);
});

test("生图失败和发图失败按原奖励收鱼，不惩罚玩家或重抽", async () => {
  for (const options of [{ renderImage: () => { throw new Error("渲染失败"); } }, { sendImage: () => ({ status: "failed", retcode: 1 }) }, { sendImage: () => undefined }]) {
    const h = await harness(options);
    const state = h.create();
    await h.instance.handleFishing(h.e);
    assert.equal(h.calls.generated, 1);
    assert.equal(h.calls.settlements.length, 1);
    assert.equal(h.calls.settlements[0].earnings, 100);
    assert.equal(h.calls.settlements[0].expGain, 10);
    assert.equal(h.calls.warnings.length, 1);
    assert.equal(h.sessions.get(h.key), null);
  }
});

test("会话取消后返回的图片不能发出或结算，新会话不受旧回调影响", async () => {
  let releaseRender;
  const rendered = new Promise(resolve => { releaseRender = resolve; });
  const h = await harness({ renderImage: () => rendered });
  const state = h.create();
  const pending = h.instance.handleFishing(h.e);
  h.sessions.finish(h.key, state.id);
  const next = h.create();
  const map = encounter.generateEncounterMaps({ seed: "stale", count: 1 })[0];
  releaseRender({ map, image: Buffer.from("旧图") });
  await pending;
  assert.equal(h.calls.replies.length, 0);
  assert.equal(h.calls.settlements.length, 0);
  assert.equal(h.sessions.get(h.key), next);
});

test("钓鱼攻略实际合并转发含第五张遭遇图和对应摘要", async () => {
  const h = await harness({ exists: true });
  await h.instance.fishingGuide(h.e);
  const [entries, metadata] = h.calls.forward;
  assert.equal(entries.length, 5);
  assert.match(entries[4][1].data.file, /05-waterway-encounter\.jpg$/);
  assert.match(metadata.summary, /5/);
  assert.equal(metadata.news.length, 5);
  const guide = buildEncounterGuideHtml();
  assert.match(guide, /首领不触发/);
  assert.match(guide, /噩梦与宝藏只增加经验/);
});
