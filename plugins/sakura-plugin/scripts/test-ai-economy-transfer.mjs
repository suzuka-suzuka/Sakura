// node --test plugins/sakura-plugin/scripts/test-ai-economy-transfer.mjs
// 执行真实工具、余额事务与冷却代码，隔离数据库位置、图片及 Redis 服务。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import * as rules from "../lib/economy/rules.js";
import { acquireRedisLock, releaseRedisLock } from "../lib/economy/redisAtomic.js";

const pluginRoot = new URL("../", import.meta.url);
const Database = createRequire(new URL("package.json", pluginRoot))("better-sqlite3");
const managerSource = readFileSync(new URL("lib/economy/EconomyManager.js", pluginRoot), "utf8")
  .replace(/^import .*$/gm, "")
  .replace("export default class EconomyManager", "class EconomyManager");
const toolSource = readFileSync(new URL("lib/AIUtils/tools/EconomyTool.js", pluginRoot), "utf8")
  .replace(/^import[\s\S]*?from ["'][^"']+["'];\r?$/gm, "")
  .replace("export class EconomyTool", "class EconomyTool");

function setup(t, { botCoins = 1000, userCoins = 100, level = 3, master = false, random = 0, cooling = false, renderFails = false } = {}) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE economy (
      group_id TEXT, user_id TEXT, coins INTEGER DEFAULT 0,
      experience INTEGER DEFAULT 0, level INTEGER DEFAULT 1, bag_level INTEGER DEFAULT 1,
      PRIMARY KEY (group_id, user_id)
    );
    CREATE TABLE economy_transactions (
      id INTEGER PRIMARY KEY, group_id TEXT, user_id TEXT, target_user_id TEXT,
      type TEXT, amount INTEGER, balance_after INTEGER, note TEXT, related_id TEXT, created_at INTEGER
    );
  `);
  const EconomyManager = vm.runInNewContext(`${managerSource}\nEconomyManager;`, {
    Setting: { getConfig: () => ({}) }, db,
  });
  const images = [];
  let draws = 0;
  let lockCalls = 0;
  const locks = new Map();
  const cooldownKey = "sakura:economy:ai_transfer:cooldown:10000:20000:10001";
  if (cooling) locks.set(cooldownKey, "已有冷却");
  const e = {
    user_id: "10001", self_id: "10000", group_id: "20000", isMaster: master,
    getInfo: async id => ({ nickname: id }), reply: async () => {},
  };
  const manager = new EconomyManager(e);
  for (const [userId, coins] of [[e.self_id, botCoins], [e.user_id, userCoins], ["10002", 0]]) {
    manager.ensureUser({ user_id: userId });
    db.prepare("UPDATE economy SET coins = ?, level = ? WHERE user_id = ?").run(coins, level, userId);
  }
  const math = Object.create(Math);
  math.random = () => { draws++; return random; };
  const tool = vm.runInNewContext(`${toolSource}\nnew EconomyTool();`, {
    ...rules, AbstractTool: class {}, EconomyManager, randomUUID,
    acquireRedisLock, releaseRedisLock, Math: math,
    redis: {
      async set(key, token, ex, ttl, nx) {
        lockCalls++;
        assert.equal(ex, "EX");
        assert.equal(ttl, 60);
        assert.equal(nx, "NX");
        if (locks.has(key)) return null;
        locks.set(key, token);
        return "OK";
      },
      async eval(_script, count, key, token) {
        assert.equal(count, 1);
        return locks.get(key) === token && locks.delete(key) ? 1 : 0;
      },
    },
    segment: { image: value => value }, console: { error() {} },
    EconomyImageGenerator: class {
      async generateTransferImage(data) {
        if (renderFails) throw new Error("测试图片失败");
        images.push(data);
        return "测试图片";
      }
    },
  });
  return {
    manager, e, db, images, locks, cooldownKey,
    coins: id => manager.getCoins({ user_id: id }),
    draws: () => draws, lockCalls: () => lockCalls,
    execute: (amount, targetQQ = "10002") => tool.func({ action: "transfer", targetQQ, amount }, e),
    executeFine: (amount, targetQQ = "10001") => tool.func({ action: "fine", targetQQ, amount }, e),
  };
}

for (const [requested, actual] of [[10, 10], [75, 75], [200, 100]]) {
  test(`独立罚款由 AI 指定 ${requested} 币，实际扣除 ${actual} 币`, async t => {
    const h = setup(t);
    assert.match(await h.executeFine(requested), new RegExp(`罚款成功！已扣除 .* ${actual} 樱花币，并转入你自己的账户。`));
    assert.equal(h.coins("10001"), 100 - actual);
    assert.equal(h.coins("10000"), 1000 + actual);
    assert.equal(h.db.prepare("SELECT SUM(coins) AS total FROM economy").get().total, 1100);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS count FROM economy_transactions").get().count, 2);
    assert.equal(h.draws(), 0);
    assert.equal(h.lockCalls(), 0);
  });
}

test("独立罚款拒绝缺失或非法金额，不默认扣 50 币", async t => {
  const h = setup(t);
  for (const amount of [undefined, null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.match(await h.executeFine(amount), /参数错误：罚款金额/);
  }
  assert.equal(h.coins("10001"), 100);
  assert.equal(h.coins("10000"), 1000);
});

test("独立罚款保留普通用户不能罚其他人和不能罚 AI 的权限限制", async t => {
  const h = setup(t);
  assert.match(await h.executeFine(10, "10002"), /权限不足/);
  assert.match(await h.executeFine(10, "10000"), /不能罚款自己/);
  assert.equal(h.coins("10000"), 1000);
  assert.equal(h.coins("10001"), 100);
});

test("主人可以让 AI 按指定金额罚其他人", async t => {
  const h = setup(t, { master: true });
  h.db.prepare("UPDATE economy SET coins = 200 WHERE user_id = '10002'").run();
  assert.match(await h.executeFine(80, "10002"), /罚款成功！已扣除 .* 80 樱花币/);
  assert.equal(h.coins("10002"), 120);
  assert.equal(h.coins("10000"), 1080);
});

test("独立罚款目标没钱时拒绝扣款", async t => {
  const h = setup(t, { userCoins: 0 });
  assert.match(await h.executeFine(80), /没钱可扣/);
  assert.equal(h.coins("10000"), 1000);
});

test("独立罚款扣款失败时不报告成功", async t => {
  const h = setup(t);
  h.manager.constructor.prototype.transferCoins = () => false;
  assert.match(await h.executeFine(80), /罚款失败：对方余额发生变化/);
  assert.equal(h.coins("10001"), 100);
  assert.equal(h.coins("10000"), 1000);
});

test("金额比例对应概率曲线，封顶 90%，超过余额与无余额为零", () => {
  for (const [amount, expected] of [[1, 0.9], [50, 0.9], [100, 0.8], [200, 0.5], [300, 1 / 3.25], [400, 0.2], [500, 1 / 7.25], [1000, 1 / 26], [1001, 0]]) {
    assert.ok(Math.abs(rules.getNonMasterAiTransferSuccessRate(1000, amount) - expected) < 1e-12);
  }
  for (const [balance, amount] of [[0, 1], [-1, 1], [NaN, 1], [Infinity, 1], [1000, 0], [1000, -1], [1000, NaN], [1000, Infinity]]) {
    assert.equal(rules.getNonMasterAiTransferSuccessRate(balance, amount), 0);
  }
});

for (const [amount, random, success] of [[100, 0.79, true], [100, 0.81, false], [200, 0.4999, true], [200, 0.5, false], [400, 0.1999, true], [400, 0.2, false], [1, 0.8999, true], [1, 0.9, false], [1000, 0.03, true]]) {
  test(`索要 ${amount}、随机值 ${random}：${success ? "成功转账" : "失败罚款"}`, async t => {
    const h = setup(t, { random });
    const result = await h.execute(amount);
    assert.match(result, success ? /转账成功/ : /罚款 50/);
    if (!success) {
      assert.match(result, /本次索要失败：未通过赠送判定/);
      assert.match(result, /实际罚款 50 樱花币/);
      assert.match(result, /本次不要重试转账/);
      assert.doesNotMatch(result, /骗子|骗取/);
    }
    assert.equal(h.coins("10000"), success ? 1000 - amount : 1050);
    assert.equal(h.coins("10001"), success ? 100 : 50);
    assert.equal(h.coins("10002"), success ? amount : 0);
    assert.equal(h.db.prepare("SELECT SUM(coins) AS total FROM economy").get().total, 1100);
    assert.equal(h.locks.has(h.cooldownKey), success);
    assert.equal(h.images.length, success ? 1 : 0);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS count FROM economy_transactions").get().count, 2);
  });
}

for (const [botCoins, userCoins, fine] of [[1000, 100, 50], [1000, 23, 23], [1000, 0, 0], [0, 100, 50]]) {
  test(`超额索要必罚，AI 余额 ${botCoins}、发起人余额 ${userCoins}`, async t => {
    const h = setup(t, { botCoins, userCoins });
    const result = await h.execute(botCoins + 1);
    assert.match(result, /索要金额.*超过你的当前余额/);
    assert.match(result, new RegExp(`实际罚款 ${fine} 樱花币`));
    assert.match(result, /本次不要重试转账/);
    assert.doesNotMatch(result, /骗子|骗取/);
    if (!fine) assert.match(result, /余额为 0，未扣款/);
    assert.equal(h.coins("10000"), botCoins + fine);
    assert.equal(h.coins("10001"), userCoins - fine);
    assert.equal(h.coins("10002"), 0);
    assert.equal(h.draws(), 0);
    assert.equal(h.lockCalls(), 0);
  });
}

test("个人冷却仍罚发起人，不罚收款人、不覆盖已有冷却且不向 AI 透露原因", async t => {
  const h = setup(t, { cooling: true });
  const result = await h.execute(100);
  assert.match(result, /本次索要失败：未通过赠送判定/);
  assert.match(result, /实际罚款 50 樱花币/);
  assert.match(result, /本次不要重试转账/);
  assert.doesNotMatch(result, /骗子|骗取|冷却|分钟|秒/);
  assert.equal(h.coins("10001"), 50);
  assert.equal(h.coins("10002"), 0);
  assert.equal(h.locks.get(h.cooldownKey), "已有冷却");
  const randomFailure = setup(t, { random: 0.99 });
  assert.equal(result, await randomFailure.execute(100));
});

test("同群不同发起人互不占用冷却，同一人更换收款人仍受冷却限制", async t => {
  const h = setup(t);
  assert.match(await h.execute(100), /转账成功/);
  h.e.user_id = "10003";
  h.manager.ensureUser(h.e);
  h.db.prepare("UPDATE economy SET coins = 100, level = 3 WHERE user_id = ?").run(h.e.user_id);
  assert.match(await h.execute(100), /转账成功/);
  const secondCooldownKey = "sakura:economy:ai_transfer:cooldown:10000:20000:10003";
  assert.equal(h.locks.has(h.cooldownKey), true);
  assert.equal(h.locks.has(secondCooldownKey), true);
  h.e.user_id = "10001";
  const result = await h.execute(100, "10003");
  assert.match(result, /未通过赠送判定/);
  assert.match(result, /实际罚款 50 樱花币/);
  assert.doesNotMatch(result, /冷却|分钟|秒/);
  assert.equal(h.coins("10001"), 50);
  assert.equal(h.coins("10003"), 100);
  assert.equal(h.coins("10002"), 200);
});

test("冷却按群和机器人分别隔离", async t => {
  for (const otherKey of [
    "sakura:economy:ai_transfer:cooldown:10000:20001:10001",
    "sakura:economy:ai_transfer:cooldown:10004:20000:10001",
  ]) {
    const h = setup(t);
    h.locks.set(otherKey, "其他范围的冷却");
    assert.match(await h.execute(100), /转账成功/);
    assert.equal(h.locks.get(otherKey), "其他范围的冷却");
  }
});

test("罚款扣款失败时如实报告实际罚款为零，保留原始失败原因", async t => {
  const h = setup(t);
  h.manager.constructor.prototype.transferCoins = () => false;
  const result = await h.execute(1001);
  assert.match(result, /索要金额.*超过你的当前余额/);
  assert.match(result, /实际罚款 0 樱花币/);
  assert.match(result, /余额在扣款时发生变化，未完成扣款/);
  assert.match(result, /本次不要重试转账/);
  assert.doesNotMatch(result, /骗子|骗取|转入你的账户/);
  assert.equal(h.coins("10001"), 100);
  assert.equal(h.coins("10000"), 1000);
});

test("主人超额仍转出全部余额，跳过概率、罚款与冷却", async t => {
  const h = setup(t, { master: true, cooling: true, random: 0.99 });
  assert.match(await h.execute(2000), /转账 1000 樱花币/);
  assert.equal(h.coins("10000"), 0);
  assert.equal(h.coins("10001"), 100);
  assert.equal(h.coins("10002"), 1000);
  assert.equal(h.draws(), 0);
  assert.equal(h.lockCalls(), 0);
});

test("Lv.1 用户可以参与 AI 转账，成功与失败按正常规则处理", async t => {
  const success = setup(t, { level: 1 });
  assert.match(await success.execute(100), /转账成功/);
  assert.equal(success.coins("10002"), 100);
  const failure = setup(t, { level: 1, random: 0.99 });
  assert.match(await failure.execute(100), /未通过赠送判定.*实际罚款 50 樱花币/);
  assert.equal(failure.coins("10001"), 50);
});

test("非法金额拒绝且不罚款，小数仍按原规则向下取整", async t => {
  const h = setup(t);
  for (const amount of [Infinity, NaN, 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.match(await h.execute(amount), /参数错误/);
  }
  assert.equal(h.coins("10001"), 100);
  assert.match(await h.execute(100.9), /转账 100 樱花币/);
});

test("实际扣款失败释放冷却，不额外罚款", async t => {
  const h = setup(t);
  const originalTransfer = h.manager.constructor.prototype.transferCoins;
  h.manager.constructor.prototype.transferCoins = () => false;
  t.after(() => { h.manager.constructor.prototype.transferCoins = originalTransfer; });
  assert.match(await h.execute(200), /余额不足/);
  assert.equal(h.locks.has(h.cooldownKey), false);
  assert.equal(h.coins("10001"), 100);
});

test("图片失败仍保留成功转账及冷却", async t => {
  const h = setup(t, { renderFails: true });
  assert.match(await h.execute(200), /转账成功/);
  assert.equal(h.coins("10000"), 800);
  assert.equal(h.coins("10002"), 200);
  assert.equal(h.locks.has(h.cooldownKey), true);
});
