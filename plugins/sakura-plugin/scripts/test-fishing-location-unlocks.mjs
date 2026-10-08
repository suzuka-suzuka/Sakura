// node --experimental-vm-modules --test plugins/sakura-plugin/scripts/test-fishing-location-unlocks.mjs
// 临时数据库验证开图口径、真实指令与重启数据保留，不访问正式玩家数据。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as rules from "../lib/fishing/rules.js";
import * as session from "../lib/fishing/session.js";
import { buildFishingLocationHtml } from "../lib/fishing/locationCard.js";

const scriptPath = fileURLToPath(import.meta.url);
const pluginRoot = path.resolve(path.dirname(scriptPath), "..");
const retained = [];

async function loadCommandApp(filename, FishingManager, fishData, { activeFishing = false } = {}) {
  const source = fs.readFileSync(path.join(pluginRoot, "apps", filename), "utf8");
  const context = vm.createContext({
    console, setTimeout, clearTimeout,
    plugin: class { getScopeKey(...parts) { return parts.join(":"); } },
    Command: (_pattern, callback) => callback,
    Cron: (_pattern, callback) => callback,
    OnEvent: (_pattern, callback) => callback,
    logger: { info() {}, warn() {}, error(message) { assert.fail(message); } },
    redis: { exists: async () => activeFishing },
    segment: { image: file => ({ type: "image", data: { file } }) },
  });
  const imports = {
    "../lib/economy/FishingManager.js": { default: FishingManager },
    "../lib/fishing/rules.js": rules,
    "../lib/fishing/session.js": session,
    "../lib/fishing/fishData.js": fishData,
    "../lib/fishing/locationCard.js": {
      createFishingLocationImage: async data => Buffer.from(buildFishingLocationHtml(data)),
    },
    "../lib/setting.js": { default: { getConfig: () => ({ gamegroups: ["group-a"] }) } },
    "../../../src/core/plugin.js": { eventStorage: new AsyncLocalStorage() },
  };
  const app = new vm.SourceTextModule(source, { context });
  retained.push(app, context);
  await app.link(specifier => {
    let exports = imports[specifier];
    if (!exports) {
      const declaration = [...source.matchAll(/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];/g)]
        .find(match => match[2] === specifier)?.[1];
      assert.ok(declaration, specifier);
      const names = declaration.trim().startsWith("{")
        ? declaration.replace(/[{}]/g, "").split(",").map(name => name.trim().split(/\s+as\s+/)[0]).filter(Boolean)
        : ["default"];
      exports = Object.fromEntries(names.map(name => [name, class {}]));
    }
    const dependency = new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
    retained.push(dependency);
    return dependency;
  });
  await app.evaluate();
  return new app.namespace.default();
}

async function runFixture(mode) {
  globalThis.logger = { info() {}, warn() {}, error() {} };
  const { default: db } = await import("../lib/Database.js");
  if (mode === "startup") {
    db.prepare(`INSERT INTO fishing_stats (group_id, user_id, location, fishing_exp, profession, profession_level)
      VALUES ('group-a', 'collector-a', 'mystic', 12345, 'abyss_hunter', 2), ('group-b', 'collector-b', 'lake', 456, 'merchant', 1)`).run();
    db.prepare(`INSERT INTO fishing_counts (group_id, user_id, fish_id, count, success_count)
      VALUES ('group-a', 'collector-a', 'fish-a', 5, 3)`).run();
    const before = db.prepare("SELECT * FROM fishing_stats ORDER BY group_id, user_id").all();
    db.init();
    assert.deepEqual(db.prepare("SELECT * FROM fishing_stats ORDER BY group_id, user_id").all(), before);
    assert.equal(db.prepare("SELECT success_count FROM fishing_counts").get().success_count, 3);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'fishing_location_resets'").get(), undefined);
    return;
  }
  if (mode === "startup-again") {
    assert.equal(db.prepare("SELECT location FROM fishing_stats WHERE user_id = 'collector-a'").get().location, "mystic");
    assert.equal(db.prepare("SELECT location FROM fishing_stats WHERE user_id = 'collector-b'").get().location, "lake");
    assert.equal(db.prepare("SELECT fishing_exp FROM fishing_stats WHERE user_id = 'collector-a'").get().fishing_exp, 12345);
    assert.equal(db.prepare("SELECT profession FROM fishing_stats WHERE user_id = 'collector-a'").get().profession, "abyss_hunter");
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'fishing_location_resets'").get(), undefined);
    return;
  }

  const { default: FishingManager } = await import("../lib/economy/FishingManager.js");
  const fishData = await import("../lib/fishing/fishData.js");
  const manager = new FishingManager("group-a");
  const allFish = fishData.getFishData();
  assert.ok(allFish.length > 0, "夹具必须加载真实鱼类资源");
  const local = id => fishData.getLocationExclusiveFish(id);
  const capture = (user, fish, success = true) => manager.recordCatch(user, 0, fish.id, success);
  const status = (user, id) => manager.getFishingLocationUnlockStatus(user, id);
  const generic = allFish.filter(fish => !fish.locations?.length);
  assert.ok(generic.length > 0);

  if (mode === "manager") {
    const user = "collector";
    assert.equal(status(user, "pond").unlocked, true);
    const pondFish = local("pond");
    assert.ok(pondFish.length >= 15);
    assert.equal(status(user, "river").unlocked, false);
    for (const fish of pondFish.slice(0, 14)) capture(user, fish);
    for (const fish of generic) capture(user, fish);
    for (let index = 0; index < 20; index++) capture(user, pondFish[0]);
    capture(user, pondFish[14], false);
    manager.getUserData(user);
    db.prepare("UPDATE fishing_stats SET fishing_exp = 1000000 WHERE group_id = ? AND user_id = ?")
      .run("group-a", user);
    assert.equal(status(user, "river").collected, 14);
    assert.equal(status(user, "river").unlocked, false, "高等级、通用鱼、目击和重复捕获均不能绕过门槛");
    assert.equal(manager.setFishingLocation(user, "river"), false);
    capture(user, pondFish[14]);
    db.prepare("UPDATE fishing_stats SET fishing_exp = 0 WHERE group_id = ? AND user_id = ?")
      .run("group-a", user);
    assert.equal(status(user, "river").unlocked, true, "低等级收录达标即可前往");
    assert.equal(manager.setFishingLocation(user, "river"), true);
    assert.equal(manager.getFishingLocation(user), "river");
    const economic = await loadCommandApp("economy.js", FishingManager, fishData);
    const rewardProgress = economic.buildDexLocationProgress({ group_id: "group-a", user_id: user }, ["pond"]);
    assert.equal(rewardProgress[0].collected, status(user, "river").collected);
    assert.equal(rewardProgress[0].total, pondFish.length);
    const shared = allFish.find(fish => fish.locations?.length === 2);
    capture("shared-only", shared);
    for (const locationId of shared.locations) {
      assert.equal(manager.getLocationDexProgress("shared-only", [locationId])[0].collected, 1);
    }
    const locations = Object.keys(rules.FISHING_LOCATIONS);
    for (let index = 1; index < locations.length; index++) {
      const userId = `route-${index}`;
      const previous = locations[index - 1];
      const next = locations[index];
      assert.equal(rules.FISHING_LOCATIONS[next].unlockLocation, previous);
      const fishes = local(previous);
      for (const fish of fishes.slice(0, 14)) capture(userId, fish);
      assert.equal(status(userId, next).unlocked, false);
      capture(userId, fishes[14]);
      assert.equal(status(userId, next).required, 15);
      assert.equal(status(userId, next).unlocked, true);
    }
    assert.equal(new FishingManager("group-b").getFishingLocationUnlockStatus(user, "river").unlocked, false);
    assert.equal(status("another-user", "river").unlocked, false);
    assert.equal(manager.setFishingLocation(user, "unknown"), false);
    db.prepare("DELETE FROM fishing_counts WHERE group_id = ? AND user_id = ?").run("group-a", user);
    assert.equal(status(user, "river").collected, 0);
    assert.equal(status(user, "river").unlocked, true, "已经解锁的资格永久保留");
    return;
  }

  const user = "command-user";
  const fishes = local("pond");
  for (const fish of fishes.slice(0, 14)) capture(user, fish);
  for (const fish of generic) capture(user, fish);
  const messages = [];
  const event = {
    group_id: "group-a", user_id: user, msg: "#前往钓点 青柳河湾",
    reply: async message => messages.push(message),
  };
  const fishing = await loadCommandApp("fishing.js", FishingManager, fishData);
  await fishing.locationList(event);
  assert.equal(messages.at(-1).type, "image", "钓点列表应发送图片");
  const card = messages.at(-1).data.file.toString();
  assert.match(card, /樱花池塘图鉴 <b>14 \/ 15<\/b> 种/);
  assert.match(card, /通用鱼不计/);
  assert.match(card, /location current/);
  assert.match(card, /#前往钓点 钓点名/);
  assert.doesNotMatch(card, /Lv\.|钓鱼等级/);
  await fishing.gotoLocation(event);
  assert.match(messages.at(-1), /当前 14\/15/);
  assert.match(messages.at(-1), /还差 1 种/);
  assert.equal(manager.getFishingLocation(user), "pond");
  capture(user, fishes[14]);
  await fishing.gotoLocation(event);
  assert.match(messages.at(-1), /来到了.*青柳河湾/);
  assert.equal(manager.getFishingLocation(user), "river");
  const active = await loadCommandApp("fishing.js", FishingManager, fishData, { activeFishing: true });
  await active.gotoLocation({ ...event, msg: "#前往钓点 樱花池塘" });
  assert.match(messages.at(-1), /钓鱼过程中不能切换钓点/);
  assert.equal(manager.getFishingLocation(user), "river");
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sakura-location-unlocks-"));
  const fixturePlugin = path.join(root, "plugins/sakura-plugin");
  fs.mkdirSync(path.join(fixturePlugin, "resources/fish"), { recursive: true });
  fs.copyFileSync(path.join(pluginRoot, "resources/fish/fish.json"), path.join(fixturePlugin, "resources/fish/fish.json"));
  return root;
}

function invokeFixture(root, mode) {
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", scriptPath, "--fixture-run", mode], {
    cwd: root, encoding: "utf8", timeout: 30000,
    env: { ...process.env, NODE_ENV: "production" },
  });
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function removeFixture(root) {
  const resolved = path.resolve(root);
  assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
  fs.rmSync(resolved, { recursive: true, force: true });
}

if (process.argv.includes("--fixture-run")) {
  try {
    await runFixture(process.argv.at(-1));
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
} else {
  test("现行数据库初始化和进程重启保留地点、职业、经验与图鉴", () => {
    const root = createFixture();
    try { invokeFixture(root, "startup"); invokeFixture(root, "startup-again"); }
    finally { removeFixture(root); }
  });

  test("五个后续地点均以专属成功收录15种开图，并与奖励保持一致", () => {
    const root = createFixture();
    try { invokeFixture(root, "manager"); }
    finally { removeFixture(root); }
  });

  test("真实钓点列表发送进度图片，切换指令14种拒绝而15种成功", () => {
    const root = createFixture();
    try { invokeFixture(root, "commands"); }
    finally { removeFixture(root); }
  });
}
