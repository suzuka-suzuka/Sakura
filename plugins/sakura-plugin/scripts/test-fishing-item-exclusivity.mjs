// node --experimental-vm-modules --test plugins/sakura-plugin/scripts/test-fishing-item-exclusivity.mjs
// 使用内存数据库验证许愿状态与真实使用入口，不访问玩家数据。
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import Database from "better-sqlite3";
import YAML from "js-yaml";
import * as fishingRules from "../lib/fishing/rules.js";
import * as economyRules from "../lib/economy/rules.js";
import * as inventoryRules from "../lib/economy/inventoryRules.js";

const configuration = Object.fromEntries(["shop", "special_items"].map(name => [
  name,
  YAML.load(fs.readFileSync(new URL(`../resources/economy/${name}.yaml`, import.meta.url), "utf8")),
]));

async function fixture(t) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE fishing_stats (
      group_id TEXT, user_id TEXT, total_catch INTEGER, total_earnings INTEGER,
      torpedo_hits INTEGER, profession TEXT, profession_level INTEGER,
      fishing_stamina INTEGER, fishing_stamina_updated_at INTEGER,
      koi_wish INTEGER DEFAULT 0, star_wish TEXT,
      PRIMARY KEY (group_id, user_id)
    );
    CREATE TABLE inventory (
      group_id TEXT, user_id TEXT, item_id TEXT, count INTEGER,
      PRIMARY KEY (group_id, user_id, item_id)
    );
  `);
  const redisValues = new Map();
  const context = vm.createContext({
    Buffer,
    plugin: class {},
    Command: (_pattern, callback) => callback,
    Cron: (_pattern, callback) => callback,
    logger: { warn() {}, info() {}, error: message => assert.fail(message) },
    segment: { image: buffer => buffer },
    redis: {
      ttl: async key => redisValues.has(key) ? 2100 : -2,
      set: async (key, value) => { redisValues.set(key, value); return "OK"; },
    },
  });
  async function load(relative, imports) {
    const source = fs.readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
    const module = new vm.SourceTextModule(source, { context });
    await module.link(specifier => {
      let exports = imports[specifier];
      if (!exports) {
        const declaration = [...source.matchAll(/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];/gu)]
          .find(match => match[2] === specifier)?.[1];
        assert.ok(declaration, specifier);
        const names = declaration.trim().startsWith("{")
          ? declaration.replace(/[{}\s]/gu, "").split(",").filter(Boolean) : ["default"];
        exports = Object.fromEntries(names.map(name => [name, class {}]));
      }
      return new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      }, { context });
    });
    await module.evaluate();
    return module.namespace.default;
  }
  class EconomyManager {
    getBagCapacity() { return 100; }
    getBagLevel() { return 1; }
    getCoins() { return 0; }
  }
  const Setting = {
    getEconomy: name => configuration[name],
    getConfig: () => ({ gamegroups: ["g", "h"] }),
  };
  const InventoryManager = await load("lib/economy/InventoryManager.js", {
    "../Database.js": { default: db },
    "./EconomyManager.js": { default: EconomyManager },
    "./inventoryRules.js": inventoryRules,
  });
  const FishingManager = await load("lib/economy/FishingManager.js", {
    "../Database.js": { default: db },
    "../setting.js": { default: Setting },
    "./InventoryManager.js": { default: InventoryManager },
    "../fishing/rules.js": fishingRules,
  });
  const ShopManager = await load("lib/economy/ShopManager.js", {
    "../Database.js": { default: db },
    "../setting.js": { default: Setting },
    "./InventoryManager.js": { default: InventoryManager },
    "./EconomyManager.js": { default: EconomyManager },
    "../fishing/rules.js": fishingRules,
  });
  const ChestManager = await load("lib/economy/ChestManager.js", {
    "./InventoryManager.js": { default: InventoryManager },
    "./ShopManager.js": { default: ShopManager },
  });
  let inventoryData;
  const App = await load("apps/economy.js", {
    "../lib/economy/EconomyManager.js": { default: EconomyManager },
    "../lib/economy/InventoryManager.js": { default: InventoryManager },
    "../lib/economy/FishingManager.js": { default: FishingManager },
    "../lib/economy/ShopManager.js": { default: ShopManager },
    "../lib/economy/ChestManager.js": { default: ChestManager },
    "../lib/economy/FishingUiImageGenerator.js": { default: class {
      async generateInventoryPages(data) { inventoryData = data; return []; }
    } },
    "../lib/setting.js": { default: Setting },
    "../lib/fishing/rules.js": fishingRules,
    "../lib/economy/rules.js": economyRules,
  });
  const app = new App();
  const event = (user = "u", group = "g") => ({
    group_id: group, user_id: user, replies: [],
    reply(value) { this.replies.push(value); },
    sendForwardMsg: async () => {},
  });
  const stock = (e, id, count = 2) => db.prepare(
    "INSERT OR REPLACE INTO inventory (group_id, user_id, item_id, count) VALUES (?, ?, ?, ?)",
  ).run(e.group_id, e.user_id, id, count);
  const count = (e, id) => new InventoryManager(e).getItemCount(id);
  const use = async (e, name, argument = "") => {
    e.match = ["", name, argument];
    await app.useItem(e);
  };
  return { db, app, event, stock, count, use, FishingManager, redisValues,
    getInventoryData: () => inventoryData };
}

for (const first of ["koi", "star"]) {
  test(`${first === "koi" ? "锦鲤许愿签" : "星愿瓶"}等待兑现时，重复与另一种许愿均不消耗`, async t => {
    const f = await fixture(t), e = f.event();
    f.stock(e, "item_sign_koi");
    f.stock(e, "item_bottle_wish");
    await f.use(e, first === "koi" ? "锦鲤许愿签" : "星愿瓶", "传说");
    const fm = new f.FishingManager(e.group_id);
    assert.equal(fm.getPendingWishes(e.user_id).koiWish, first === "koi");
    assert.equal(fm.getPendingWishes(e.user_id).starWish, first === "star" ? "传说" : null);
    await f.use(e, "锦鲤许愿签");
    await f.use(e, "星愿瓶", "史诗");
    assert.equal(f.count(e, "item_sign_koi"), first === "koi" ? 1 : 2);
    assert.equal(f.count(e, "item_bottle_wish"), first === "star" ? 1 : 2);
    assert.match(e.replies.at(-1), /已有许愿/u);
    assert.equal(f.redisValues.size, 0, "许愿不使用限时增益键");
    if (first === "koi") assert.equal(fm.consumeKoiWish(e.user_id), true);
    else assert.equal(fm.consumeStarWish(e.user_id), "传说");
    await f.use(e, first === "koi" ? "星愿瓶" : "锦鲤许愿签", "史诗");
    assert.equal(f.count(e, "item_sign_koi"), 1);
    assert.equal(f.count(e, "item_bottle_wish"), 1);
  });
}

test("许愿按群和玩家隔离，数据库拒绝另一种许愿与失败恢复覆盖", async t => {
  const f = await fixture(t), fm = new f.FishingManager("g");
  assert.equal(fm.setKoiWish("u"), true);
  assert.equal(fm.setStarWish("u", "史诗"), false);
  assert.equal(fm.restoreStarWish("u", "史诗"), false);
  assert.equal(fm.setStarWish("other", "史诗"), true);
  assert.equal(new f.FishingManager("h").setStarWish("u", "史诗"), true);
  assert.equal(fm.consumeKoiWish("u"), true);
  assert.equal(fm.setStarWish("u", "传说"), true);
  assert.equal(fm.setKoiWish("u"), false);
  assert.equal(fm.restoreKoiWish("u"), false);
  assert.equal(fm.getPendingWishes("u").starWish, "传说");
  assert.equal(fm.getPendingWishes("u").koiWish, false);
  assert.equal(fm.consumeStarWish("u"), "传说");
  assert.equal(fm.restoreKoiWish("u"), true);
  assert.equal(fm.consumeKoiWish("u"), true);
  assert.equal(fm.restoreStarWish("u", "传说"), true);
});

test("金币组仍双向拦截且不消耗，许愿组可以独立使用", async t => {
  const f = await fixture(t);
  for (const [first, second] of [
    ["双倍金币卡", "怪物诱饵"], ["怪物诱饵", "双倍金币卡"],
  ]) {
    const e = f.event(first);
    f.stock(e, "item_card_double_coin"); f.stock(e, "item_bait_monster");
    f.stock(e, "item_sign_koi");
    await f.use(e, first);
    await f.use(e, second);
    assert.equal(f.count(e, "item_card_double_coin"), first === "双倍金币卡" ? 1 : 2);
    assert.equal(f.count(e, "item_bait_monster"), first === "怪物诱饵" ? 1 : 2);
    assert.match(e.replies.at(-1), /本次未消耗道具/u);
    await f.use(e, "锦鲤许愿签");
    assert.equal(f.count(e, "item_sign_koi"), 1);
  }
});

test("背包把两种许愿和两种金币道具的分组传给渲染器，说明只保留效果", async t => {
  const f = await fixture(t), e = f.event();
  for (const id of ["item_sign_koi", "item_bottle_wish", "item_card_double_coin", "item_bait_monster", "item_sand_time"]) {
    f.stock(e, id, 1);
  }
  await f.app.myBag(e);
  const items = f.getInventoryData().items;
  const group = id => items.find(item => item.id === id).exclusiveGroup;
  assert.equal(group("item_sign_koi"), "fishing_wish");
  assert.equal(group("item_bottle_wish"), "fishing_wish");
  assert.equal(group("item_card_double_coin"), "coin_boost");
  assert.equal(group("item_bait_monster"), "coin_boost");
  assert.equal(group("item_sand_time"), undefined);
  for (const item of items) assert.doesNotMatch(item.description, /互斥|不能同时/u);
});
