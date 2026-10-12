// node --experimental-vm-modules --test plugins/sakura-plugin/scripts/test-fortune-bags.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import * as crypto from "node:crypto";
import * as url from "node:url";
import Database from "better-sqlite3";
import YAML from "js-yaml";
import * as fishingRules from "../lib/fishing/rules.js";
import * as economyRules from "../lib/economy/rules.js";
import * as bagRules from "../lib/economy/fortuneBagRules.js";
import * as session from "../lib/fishing/session.js";
import * as encounter from "../lib/fishing/encounter.js";

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const readEconomy = name => YAML.load(fs.readFileSync(path.join(root, "resources/economy", `${name}.yaml`), "utf8"));

async function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sakura-fortune-bags-"));
  const modules = new Map(), timers = new Map(), buffs = new Set(), errors = [];
  let timerId = 0, sessions;
  class SessionStore extends session.FishingSessionStore {
    constructor() { super({ clearTimer: id => timers.delete(id) }); sessions = this; }
  }
  const redis = { get: async key => [...buffs].some(id => key.includes(`:${id}:`)) ? "1" : null,
    ttl: async () => -2, exists: async () => 0 };
  const context = vm.createContext({ console, Buffer, redis,
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    plugin: class { constructor(options) { Object.assign(this, options); } finish() {} setContext() {}
      getScopeKey(...parts) { return JSON.stringify(parts); } },
    Command: (pattern, handler) => handler, Cron: (pattern, handler) => handler,
    logger: { warn() {}, info() {}, error: message => errors.push(message) },
    segment: { image: value => value, at: value => `[CQ:at,qq=${value}]` },
    Math: Object.assign(Object.create(Math), { random: () => 0 }),
  });
  const configuration = Object.fromEntries(["shop", "special_items", "treasure_chest", "profession", "bag"].map(name => [name, readEconomy(name)]));
  const sources = new Set(["lib/Database.js", "lib/economy/FortuneBagManager.js", "lib/fishing/SettlementService.js",
    "lib/economy/InventoryManager.js", "lib/economy/EconomyManager.js", "lib/economy/ShopManager.js",
    "lib/economy/FishingManager.js", "lib/economy/ChestManager.js", "lib/fishing/fishData.js", "apps/fishing.js"]);
  const special = new Map([
    ["better-sqlite3", { default: Database }], ["node:fs", { default: fs }], ["fs", { default: fs }],
    ["node:path", { default: path }], ["path", { default: path }],
    ["node:crypto", crypto], ["node:url", url], ["lodash", { default: { random: (min, max) => max ?? min } }],
    [path.join(root, "lib/path.js"), { plugindata: temporary, pluginresources: path.join(root, "resources"), _path: temporary }],
    [path.join(root, "lib/setting.js"), { default: { getEconomy: name => configuration[name], getConfig: () => ({ gamegroups: ["g"], enable: true }) } }],
    [path.join(root, "lib/fishing/rules.js"), fishingRules], [path.join(root, "lib/economy/rules.js"), economyRules],
    [path.join(root, "lib/economy/inventoryRules.js"), await import("../lib/economy/inventoryRules.js")],
    [path.join(root, "lib/economy/time.js"), await import("../lib/economy/time.js")],
    [path.join(root, "lib/economy/fortuneBagRules.js"), { ...bagRules, rollPondItemType: (a, b) => bagRules.rollPondItemType(a, b, () => 0) }],
    [path.join(root, "lib/fishing/session.js"), { ...session, FishingSessionStore: SessionStore }],
    [path.join(root, "lib/fishing/encounter.js"), encounter],
    [path.resolve(root, "../../src/core/plugin.js"), { eventStorage: { run: (value, callback) => callback() } }],
    [path.join(root, "lib/economy/redisAtomic.js"), { acquireRedisLock: async () => true, releaseRedisLock: async () => true,
      completeFishingAttempt: async () => ({ success: true }) }],
  ]);
  function getModule(specifier, importer = path.join(root, "entry.js"), declaration = null) {
    const key = specifier.startsWith(".") ? path.resolve(path.dirname(importer), specifier) : specifier;
    if (modules.has(key)) return modules.get(key);
    let module;
    const exports = special.get(key);
    if (exports) {
      module = new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      }, { context, identifier: key });
    } else if (sources.has(path.relative(root, key).replaceAll("\\", "/"))) {
      module = new vm.SourceTextModule(fs.readFileSync(key, "utf8"), { context, identifier: key });
    } else {
      const names = declaration?.trim().startsWith("{")
        ? declaration.replace(/[{}\s]/gu, "").split(",").filter(Boolean) : ["default"];
      module = new vm.SyntheticModule(names, function () {
        for (const name of names) this.setExport(name, class {});
      }, { context, identifier: key });
    }
    modules.set(key, module);
    return module;
  }
  function linker(specifier, importer) {
    const source = importer instanceof vm.SourceTextModule ? fs.readFileSync(importer.identifier, "utf8") : "";
    const declaration = [...source.matchAll(/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];/gu)]
      .find(match => match[2] === specifier)?.[1];
    return getModule(specifier, importer.identifier, declaration);
  }
  async function load(relative) {
    const module = getModule(path.join(root, relative));
    if (module.status === "unlinked") await module.link(linker);
    if (module.status === "linked") await module.evaluate();
    return module.namespace;
  }
  const db = (await load("lib/Database.js")).default;
  t.after(() => {
    db.db.close();
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith("sakura-fortune-bags-"));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const Manager = (await load("lib/economy/FortuneBagManager.js")).default;
  function event(user = "u", group = "g") {
    const replies = [];
    return { group_id: group, user_id: user, msg: "", replies,
      reply: async value => { replies.push(Array.isArray(value) ? value.join("") : String(value)); return { message_id: replies.length }; } };
  }
  function stock(e, item, count) {
    db.prepare("INSERT OR REPLACE INTO inventory (group_id,user_id,item_id,count) VALUES (?,?,?,?)")
      .run(e.group_id, e.user_id, item, count);
  }
  async function fishing(e, { line = "line_steel", rod = "rod_titanium", amount = 10, expectBag = true, location = "pond", ownerId = e.user_id } = {}) {
    const FishingManager = (await load("lib/economy/FishingManager.js")).default;
    const fm = new FishingManager(e.group_id);
    fm.getUserData(e.user_id);
    db.prepare("UPDATE fishing_stats SET location=? WHERE group_id=? AND user_id=?").run(location, e.group_id, e.user_id);
    stock(e, line, 1); stock(e, rod, 1); stock(e, "bait_worm", 100);
    fm.equipRod(e.user_id, rod); fm.equipLine(e.user_id, line); fm.equipBait(e.user_id, "bait_worm");
    const ownerEvent = { ...e, user_id: ownerId };
    stock(ownerEvent, "fortune_bag", 1);
    const manager = new Manager(e);
    const deployed = new Manager(ownerEvent).deploy(location, "留给下一位的好运");
    db.prepare("UPDATE pond_fortune_bags SET amount=? WHERE id=?").run(amount, deployed.id);
    const App = (await load("apps/fishing.js")).default;
    const app = new App();
    await app.startFishing(e);
    const state = sessions.entries()[0]?.[1];
    assert.equal(Boolean(state?.fish?.isFortuneBag), expectBag, errors.join("\n"));
    await timers.get(state.waitingTimer)();
    return { app, state, manager, fm, bagId: deployed.id };
  }
  return { db, Manager, event, stock, load, fishing, buffs, timers, errors, configuration };
}

test("六种宝箱通用奖池均分40%，福袋400币且图片有效", () => {
  const shop = readEconomy("shop"), chest = readEconomy("treasure_chest");
  assert.equal(shop.categories.special_tools.items.find(item => item.id === "fortune_bag").price, 400);
  for (const { loot } of Object.values(chest.chests)) {
    const total = loot.reduce((sum, item) => sum + item.weight, 0);
    assert.equal(total, 300);
    const common = loot.filter(item => item.weight === 20);
    assert.equal(common.length, 6);
    assert.ok(common.some(item => item.item_id === "fortune_bag"));
    assert.equal(common.reduce((sum, item) => sum + item.weight, 0) / total, 0.4);
    assert.equal(loot.find(item => item.item_id === "torpedo").weight / total, 0.1);
  }
  const png = fs.readFileSync(path.join(root, "resources/fish/img/fortune_bag.png"));
  assert.equal(png.readUInt32BE(16), 204); assert.equal(png.readUInt32BE(20), 204);
});

test("福袋和鱼雷每个5权重，共用100基础池；留言和动态数值", () => {
  const torpedoWeight = fishingRules.TORPEDO_HOOK_WEIGHT_PER_ITEM;
  const total = 100 + torpedoWeight + 5;
  assert.equal(bagRules.FORTUNE_BAG_HOOK_WEIGHT_PER_ITEM, 5);
  assert.equal(torpedoWeight, 5);
  assert.equal(bagRules.rollPondItemType(1, 1, () => (torpedoWeight - 1) / total), "torpedo");
  assert.equal(bagRules.rollPondItemType(1, 1, () => torpedoWeight / total), "fortune_bag");
  assert.equal(bagRules.rollPondItemType(1, 1, () => (torpedoWeight + 5) / total), "fish");
  assert.equal(bagRules.rollPondItemType(0, 0, () => assert.fail("空池不抽签")), "fish");
  const caught = bagRules.fortuneBagAsCatch({ id: 1, amount: 70, message: "好运", location: "river" });
  assert.equal(caught.difficulty, 15); assert.equal(caught.actualWeight, 35); assert.equal(caught.effectiveWeight, 35);
  assert.equal(encounter.rollFishingEncounter({ fish: caught }, 1), false);
  assert.equal(session.shouldRecordFishEncounter({ fish: caught, phase: session.FISHING_PHASE.weightCheck }), false);
  assert.equal(bagRules.normalizeFortuneBagMessage("\n 好运\t给你 "), "好运 给你");
  assert.equal(bagRules.normalizeFortuneBagMessage("字".repeat(121)), null);
});

test("投放编号从F1递增，按群与钓点隔离，本人也能钓，多次投放不设配额", async t => {
  const f = await fixture(t), e = f.event(), manager = new f.Manager(e);
  f.stock(e, "fortune_bag", 20);
  assert.equal(manager.deploy("pond", "").reason, "invalid_message");
  for (let id = 1; id <= 20; id++) assert.equal(manager.deploy(id % 2 ? "pond" : "river", `袋${id}`).id, id);
  assert.equal(manager.getAvailableCount("pond"), 10);
  assert.equal(new f.Manager(f.event("other", "other-group")).getAvailableCount("pond"), 0);
  assert.equal(manager.getAvailableCount("lake"), 0);
  const bag = manager.reserve("pond", "s1");
  assert.equal(bag.owner_id, e.user_id);
  assert.equal(manager.getAvailableCount("pond"), 9);
  assert.equal(manager.release("wrong"), 0); assert.equal(manager.release("s1"), 1);
  assert.equal(manager.deploy("pond", "袋子").reason, "no_item");
});

test("成功发放面额、回池加10、给投放者固定经验，不抽成抵债，不重复发钱", async t => {
  const f = await fixture(t), owner = f.event("owner"), fisher = f.event("fisher");
  f.stock(owner, "fortune_bag", 1);
  const id = new f.Manager(owner).deploy("pond", "好运").id, manager = new f.Manager(fisher);
  const FM = (await f.load("lib/economy/FishingManager.js")).default;
  new FM("g").getUserData("fisher");
  f.db.prepare("UPDATE fishing_stats SET ghost_debt=400,ghost_debt_mark=3 WHERE user_id='fisher'").run();
  for (const [index, amount] of [[1, 10], [2, 20], [3, 30]]) {
    assert.equal(manager.reserve("pond", `s${index}`).amount, amount);
    assert.equal(manager.getAvailableCount("pond"), 0);
    assert.equal(new f.Manager(f.event("other")).reserve("pond", "other"), null);
    const result = manager.settle({ bagId: id, sessionId: `s${index}`, success: true, expGain: 2, rodId: "rod_bamboo", locationId: "pond" });
    assert.equal(result.earnings, amount); assert.equal(result.nextAmount, amount + 10);
    assert.equal(manager.settle({ bagId: id, sessionId: `s${index}`, success: true, locationId: "pond" }).success, false);
  }
  assert.equal(f.db.prepare("SELECT coins FROM economy WHERE user_id='fisher'").get().coins, 60);
  assert.equal(f.db.prepare("SELECT fishing_exp FROM fishing_stats WHERE user_id='owner'").get().fishing_exp, 3);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM fishing_counts").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM economy_transactions WHERE type='福袋收入'").get().n, 3);
  const row = f.db.prepare("SELECT * FROM pond_fortune_bags WHERE id=?").get(id);
  assert.equal(row.amount, 40); assert.equal(row.success_count, 3); assert.equal(row.total_paid, 60);
});

test("结算故障原子回滚，过期占用按原额回池，不能释放另一个会话", async t => {
  const f = await fixture(t), e = f.event(), manager = new f.Manager(e);
  f.stock(e, "fortune_bag", 1); const id = manager.deploy("pond", "好运").id;
  manager.reserve("pond", "s1");
  f.db.db.exec("CREATE TRIGGER block_coins BEFORE UPDATE OF coins ON economy BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
  assert.throws(() => manager.settle({ bagId: id, sessionId: "s1", success: true, locationId: "pond" }), /fixture/u);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM fishing_attempts").get().n, 0);
  assert.equal(f.db.prepare("SELECT amount,status FROM pond_fortune_bags").get().amount, 10);
  f.db.db.exec("DROP TRIGGER block_coins");
  f.db.prepare("UPDATE pond_fortune_bags SET hook_until=0").run();
  assert.equal(manager.recoverReservations(), 1);
  assert.equal(manager.reserve("pond", "s2").id, id);
  assert.equal(manager.release("s1"), 0);
  assert.equal(manager.settle({ bagId: id, sessionId: "s2", success: false }).ended, true);
  assert.equal(manager.getAvailableCount("pond"), 0);
});

test("合并商品页后漂流福袋与鱼雷按各自ID购买，宝箱福袋满包仍能领取", async t => {
  const f = await fixture(t), e = f.event();
  const Shop = (await f.load("lib/economy/ShopManager.js")).default;
  const shop = new Shop();
  f.db.prepare("INSERT INTO economy(group_id,user_id,coins,bag_level) VALUES ('g','u',5000,10)").run();
  assert.equal(shop.findItemById("fortune_bag").handler, "fishing_fortune_bag");
  assert.equal(shop.findItemById("torpedo").handler, "fishing_torpedo");
  const bought = await shop.buyItem(e, "漂流福袋", 3);
  assert.equal(bought.success, true);
  assert.equal(bought.item.handler, "fishing_fortune_bag");
  assert.equal(f.db.prepare("SELECT coins FROM economy WHERE user_id='u'").get().coins, 3800);
  assert.equal(f.db.prepare("SELECT count FROM inventory WHERE item_id='fortune_bag'").get().count, 3);
  const torpedo = await shop.buyItem(e, "鱼雷", 2);
  assert.equal(torpedo.success, true);
  assert.equal(torpedo.item.handler, "fishing_torpedo");
  assert.equal(f.db.prepare("SELECT coins FROM economy WHERE user_id='u'").get().coins, 3000);
  assert.equal(f.db.prepare("SELECT count FROM inventory WHERE item_id='torpedo'").get().count, 2);
  f.stock(e, "chest_pond", 1); f.stock(e, "bait_worm", 10000);
  const Chest = (await f.load("lib/economy/ChestManager.js")).default;
  const chest = new Chest(e); chest.rollLoot = () => ({ type: "item", item_id: "fortune_bag", count: 1 });
  assert.equal(chest.openChest(shop.findItemById("chest_pond")).success, true);
  assert.equal(f.db.prepare("SELECT count FROM inventory WHERE item_id='fortune_bag'").get().count, 4);
});

test("数据库重开保留福袋与编号序列，已沉没编号不会重复使用", async t => {
  const f = await fixture(t), e = f.event(), manager = new f.Manager(e);
  f.stock(e, "fortune_bag", 2);
  assert.equal(manager.deploy("river", "第一只").id, 1);
  manager.reserve("river", "s1");
  manager.settle({ bagId: 1, sessionId: "s1", success: false });
  f.db.db.close();
  f.db.db = new Database(f.db.dbPath);
  f.db.init();
  assert.equal(f.db.prepare("SELECT status FROM pond_fortune_bags WHERE id=1").get().status, "ended");
  assert.equal(manager.deploy("river", "第二只").id, 2);
  assert.equal(manager.reserve("river", "s2").id, 2);
  assert.equal(manager.settle({ bagId: 2, sessionId: "s2", success: true }).success, true);
  assert.equal(f.db.prepare("SELECT location FROM pond_fortune_bags WHERE id=2").get().location, "river");
});

test("真实钓鱼成功直接发钱回池，护符与天气不改数值，咬钩预警不泄露福袋", async t => {
  const f = await fixture(t), e = f.event();
  f.buffs.add("item_charm_lucky"); f.buffs.add("item_lamp_fog"); f.buffs.add("item_card_double_coin");
  const { app, state } = await f.fishing(e, { amount: 20 });
  assert.equal(state.hasLucky, false); assert.equal(state.fish.difficulty, 10); assert.equal(state.fish.effectiveWeight, 10);
  assert.ok(!e.replies.at(-1).includes("福袋"));
  const before = f.db.prepare("SELECT coins FROM economy WHERE user_id='u'").get()?.coins || 0;
  e.msg = "收竿"; await app.handleFishing(e);
  assert.equal(f.db.prepare("SELECT coins FROM economy WHERE user_id='u'").get().coins - before, 20);
  assert.equal(f.db.prepare("SELECT amount,status FROM pond_fortune_bags").get().amount, 30);
  assert.match(e.replies.join("\n"), /获得 20 樱花币/u);
  assert.equal(f.errors.length, 0, f.errors.join("\n"));
});

test("福袋困难度同当地宝箱，通过承重后仍会进入困难度判定，强拉失败终止", async t => {
  const f = await fixture(t), e = f.event();
  const { app, state } = await f.fishing(e, { line: "line_mythril", rod: "rod_bamboo", amount: 100, location: "mystic" });
  assert.equal(state.fish.difficulty, 84);
  e.msg = "收竿"; await app.handleFishing(e);
  assert.equal(state.phase, session.FISHING_PHASE.difficultyCheck);
  e.msg = "强拉"; await app.handleFishing(e);
  assert.equal(f.db.prepare("SELECT status FROM pond_fortune_bags").get().status, "ended");
  assert.ok(e.replies.includes("[CQ:at,qq=u] 🧧 有只装着 100 樱花币的福袋沉没了。"));
});

test("星愿指定品质跳过投放物，启动或系统清理释放福袋而不终止", async t => {
  const f = await fixture(t), e = f.event();
  f.db.prepare("INSERT INTO fishing_stats(group_id,user_id,star_wish) VALUES ('g','u','普通')").run();
  const first = await f.fishing(e, { expectBag: false });
  assert.equal(first.state.fish.rarity, "普通");
  assert.equal(first.manager.getAvailableCount("pond"), 1);
  first.state.cleanup();
  const { state, manager } = await f.fishing(e);
  assert.equal(manager.getAvailableCount("pond"), 1);
  state.cleanup();
  assert.equal(manager.getAvailableCount("pond"), 2);
  assert.ok(f.db.prepare("SELECT status FROM pond_fortune_bags").all().every(row => row.status === "active"));
});

for (const action of ["放弃", "超时", "收竿失败"]) {
  test(`真实${action}终止福袋，群消息公布金额并@最初投放者`, async t => {
    const f = await fixture(t), e = f.event();
    const amount = action === "收竿失败" ? 20 : 10;
    const { app, state, bagId } = await f.fishing(e, { line: "line_basic", amount });
    if (action === "超时") await app.handleFishingTimeout(e, app.buildFishingStateKey("g", "u"), state.id, { message: "超时" });
    else { e.msg = action === "放弃" ? "放弃" : "收竿"; await app.handleFishing(e); }
    const row = f.db.prepare("SELECT status FROM pond_fortune_bags WHERE id=?").get(bagId);
    assert.equal(row.status, "ended", f.errors.join("\n"));
    const notice = e.replies.filter(reply => reply.includes("福袋沉没"));
    assert.deepEqual(notice, [`[CQ:at,qq=u] 🧧 有只装着 ${amount} 樱花币的福袋沉没了。`]);
    assert.ok(!notice[0].includes("F1")); assert.ok(!notice[0].includes("池塘"));
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM economy_transactions WHERE type='福袋收入'").get().n, 0);
  });
}

test("别人终止福袋时@最初投放者，不@当前钓鱼人且不披露编号和钓点", async t => {
  const f = await fixture(t), e = f.event("fisher");
  const { app } = await f.fishing(e, { ownerId: "sender" });
  e.msg = "放弃"; await app.handleFishing(e);
  const notice = e.replies.find(reply => reply.includes("福袋沉没"));
  assert.equal(notice, "[CQ:at,qq=sender] 🧧 有只装着 10 樱花币的福袋沉没了。");
});
