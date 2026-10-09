// node --test plugins/sakura-plugin/scripts/test-fishing-ghost-debt.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import {
  calculateGhostDebtPayment,
  GHOST_DEBT_PRINCIPAL,
  GHOST_DEBT_REPAYMENT_CASTS,
  ghostMarkMultiplierFromLayers,
} from "../lib/fishing/rules.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleUrl = relative => pathToFileURL(path.join(pluginRoot, relative)).href;

test("放贷四百，当竿不计息或消耗四竿期限", () => {
  assert.equal(GHOST_DEBT_PRINCIPAL, 400);
  assert.equal(GHOST_DEBT_REPAYMENT_CASTS, 4);
  const result = calculateGhostDebtPayment(0, 400);
  assert.equal(result.remainingDebt, 400);
  assert.equal(result.remainingTurns, 4);
  assert.equal(result.interestAdded, 0);
  assert.equal(result.writtenOff, false);
});

test("欠款超过原四百阈值仍持续，第四竿未清才新增印记", () => {
  let debt = 400, turns = 4, marks = 0;
  for (const [remainingDebt, remainingTurns] of [[500, 3], [625, 2], [782, 1], [0, 0]]) {
    const result = calculateGhostDebtPayment(0, debt, {
      debtTurnsRemaining: turns, ghostMarkLayers: marks, accrueInterest: true,
    });
    assert.equal(result.remainingDebt, remainingDebt);
    assert.equal(result.remainingTurns, remainingTurns);
    assert.equal(result.writtenOff, remainingTurns === 0);
    assert.equal(result.ghostMarkLayers, remainingTurns === 0 ? 1 : 0);
    debt = result.remainingDebt; turns = result.remainingTurns; marks = result.ghostMarkLayers;
  }
});

test("第四竿仍有还款机会，足额与超额还清不会新增印记", () => {
  for (const earnings of [782, 900]) {
    const result = calculateGhostDebtPayment(earnings, 782, {
      debtTurnsRemaining: 1, accrueInterest: true,
    });
    assert.equal(result.debtPaid, 782);
    assert.equal(result.earnings, earnings - 782);
    assert.equal(result.remainingDebt, 0);
    assert.equal(result.remainingTurns, 0);
    assert.equal(result.interestAdded, 0);
    assert.equal(result.writtenOff, false);
    assert.equal(result.ghostMarkLayers, 0);
  }
});

test("印记按零点九连乘，先抽成再抵债，到期只新增一层", () => {
  for (const [layers, earnings] of [[0, 1000], [1, 900], [2, 810], [3, 729]]) {
    assert.equal(calculateGhostDebtPayment(1000, 0, { ghostMarkLayers: layers }).earnings, earnings);
    assert.equal(ghostMarkMultiplierFromLayers(layers), 0.9 ** layers);
  }
  const result = calculateGhostDebtPayment(1000, 900, {
    ghostMarkLayers: 2, debtTurnsRemaining: 1, accrueInterest: true,
  });
  assert.equal(result.earningsAfterMark, 810);
  assert.equal(result.debtPaid, 810);
  assert.equal(result.debtAfterPayment, 90);
  assert.equal(result.earnings, 0);
  assert.equal(result.ghostMarkLayers, 3);
  assert.equal(calculateGhostDebtPayment(1000, 0, { ghostMarkLayers: result.ghostMarkLayers }).earnings, 729);
});

test("先偿还再滚百分之二十五利息，非抛竿收入不减少还款机会", () => {
  const cast = calculateGhostDebtPayment(100, 400, { accrueInterest: true });
  assert.equal(cast.debtPaid, 100);
  assert.equal(cast.remainingDebt, 375);
  assert.equal(cast.remainingTurns, 3);
  const blast = calculateGhostDebtPayment(100, 375, { debtTurnsRemaining: 3 });
  assert.equal(blast.remainingDebt, 275);
  assert.equal(blast.remainingTurns, 3);
  assert.equal(blast.interestAdded, 0);
  assert.equal(blast.writtenOff, false);
});

function withFixture(run) {
  const tempRoot = path.resolve(os.tmpdir());
  const fixtureRoot = fs.mkdtempSync(path.join(tempRoot, "sakura-ghost-debt-"));
  assert.equal(path.dirname(fixtureRoot), tempRoot);
  const resourceDir = path.join(fixtureRoot, "plugins/sakura-plugin/resources/economy");
  fs.mkdirSync(resourceDir, { recursive: true });
  for (const filename of ["shop.yaml", "profession.yaml"]) {
    fs.copyFileSync(path.join(pluginRoot, "resources/economy", filename), path.join(resourceDir, filename));
  }
  try { run(fixtureRoot); }
  finally { fs.rmSync(fixtureRoot, { recursive: true, force: true }); }
}

function runIsolated(fixtureRoot, script) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: fixtureRoot, encoding: "utf8", timeout: 20_000,
    env: { ...process.env, NODE_ENV: "production" },
  });
  assert.equal(result.status, 0, `隔离债务测试失败\n${result.stdout}\n${result.stderr}`);
}

test("真实数据库结算覆盖失败、宝箱、重复结算、二次印记、爆破与净化", () => withFixture(fixtureRoot => {
  runIsolated(fixtureRoot, `
    import assert from "node:assert/strict";
    const {default: Manager} = await import(${JSON.stringify(moduleUrl("lib/economy/FishingManager.js"))});
    const {default: Settlement} = await import(${JSON.stringify(moduleUrl("lib/fishing/SettlementService.js"))});
    const {default: db} = await import(${JSON.stringify(moduleUrl("lib/Database.js"))});
    const manager = new Manager("ghost-test");
    const user = "debtor";
    const settlement = new Settlement({group_id: "ghost-test", user_id: user});
    const status = () => manager.getNightmareStatus(user);
    manager.addGhostDebt(user, 400);
    settlement.settleAttempt({sessionId: "loan", success: true, accrueGhostInterest: false});
    assert.equal(status().ghostDebtTurnsRemaining, 4);
    const firstArgs = {sessionId: "paid-first", fishId: "fish", earnings: 100};
    const first = settlement.settleCoinCatch(firstArgs);
    assert.equal(first.remainingDebt, 375);
    assert.equal(first.remainingTurns, 3);
    assert.equal(first.earnings, 0);
    assert.deepEqual(settlement.settleCoinCatch(firstArgs), {success: false, reason: "duplicate"});
    assert.equal(status().ghostDebt, 375);
    assert.equal(status().ghostDebtTurnsRemaining, 3);
    const box = settlement.settleInventoryCatch({sessionId: "treasure", fishId: "chest_pond"});
    assert.equal(box.remainingDebt, 469);
    assert.equal(box.remainingTurns, 2);
    const failed = settlement.settleAttempt({sessionId: "failed"});
    assert.equal(failed.remainingDebt, 587);
    assert.equal(failed.remainingTurns, 1);
    const expired = settlement.settleAttempt({sessionId: "expired"});
    assert.equal(expired.writtenOff, true);
    assert.equal(status().ghostDebt, 0);
    assert.equal(status().ghostDebtTurnsRemaining, 0);
    assert.equal(status().ghostMarkLayers, 1);
    assert.deepEqual(settlement.settleAttempt({sessionId: "expired"}), {success: false, reason: "duplicate"});
    assert.equal(status().ghostMarkLayers, 1);
    assert.equal(new Manager("another-group").getNightmareStatus(user).ghostMarkLayers, 0);
    assert.equal(settlement.settleCoinCatch({sessionId: "marked-income", fishId: "fish", earnings: 1000}).earnings, 900);
    manager.addGhostDebt(user, 400);
    assert.equal(status().ghostMarkLayers, 1);
    const blast = settlement.settleTorpedoBlast({earnings: 100});
    assert.equal(blast.debtPaid, 90);
    assert.equal(blast.remainingDebt, 310);
    assert.equal(blast.remainingTurns, 4);
    for(let i=0;i<4;i++) settlement.settleAttempt({sessionId: "second-debt-"+i});
    assert.equal(status().ghostMarkLayers, 2);
    assert.equal(settlement.settleCoinCatch({sessionId: "twice-marked-income", fishId: "fish", earnings: 1000}).earnings, 810);
    manager.addGhostDebt(user, 400);
    settlement.settleAttempt({sessionId: "repeat-before-loan"});
    assert.equal(status().ghostDebtTurnsRemaining, 3);
    manager.addGhostDebt(user, 400);
    assert.equal(status().ghostDebt, 900);
    assert.equal(status().ghostDebtTurnsRemaining, 4);
    assert.equal(status().ghostMarkLayers, 2);
    const coinsBefore = db.prepare("SELECT coins FROM economy WHERE group_id=? AND user_id=?").get("ghost-test",user).coins;
    const purified = manager.clearNightmareDebuffs(user);
    assert.equal(purified.ghostMarkLayers, 2);
    assert.equal(status().ghostDebt, 0);
    assert.equal(status().ghostDebtTurnsRemaining, 0);
    assert.equal(status().ghostMarkLayers, 0);
    assert.equal(status().ghostMarkMultiplier, 1);
    assert.equal(db.prepare("SELECT coins FROM economy WHERE group_id=? AND user_id=?").get("ghost-test",user).coins, coinsBefore);
    db.db.close();
    process.exit(0);
  `);
}));

test("已有数据库只补期限字段，不转换状态或在再次启动时重置期限", () => withFixture(fixtureRoot => {
  const dataDir = path.join(fixtureRoot, "plugins/sakura-plugin/data");
  fs.mkdirSync(dataDir, { recursive: true });
  const fixtureDb = new Database(path.join(dataDir, "sakura.sqlite"));
  fixtureDb.exec(`CREATE TABLE fishing_stats (
    group_id TEXT, user_id TEXT, ghost_debt INTEGER DEFAULT 0, ghost_debt_mark INTEGER DEFAULT 0,
    PRIMARY KEY (group_id, user_id)
  ); INSERT INTO fishing_stats (group_id,user_id) VALUES ('schema-test','user');`);
  fixtureDb.close();
  runIsolated(fixtureRoot, `
    import assert from "node:assert/strict";
    const {default: db} = await import(${JSON.stringify(moduleUrl("lib/Database.js"))});
    const row = () => db.prepare("SELECT * FROM fishing_stats").get();
    assert.equal(row().ghost_debt_turns_remaining,0);
    assert.equal(row().ghost_debt,0);
    assert.equal(row().ghost_debt_mark,0);
    db.prepare("UPDATE fishing_stats SET ghost_debt=400,ghost_debt_turns_remaining=2,ghost_debt_mark=2").run();
    db.init();
    assert.equal(row().ghost_debt_turns_remaining,2);
    assert.equal(row().ghost_debt,400);
    assert.equal(row().ghost_debt_mark,2);
    db.db.close();
  `);
}));
