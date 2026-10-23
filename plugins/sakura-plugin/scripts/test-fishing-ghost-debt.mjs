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
  GHOST_DEBT_MARK_THRESHOLD,
  ghostMarkMultiplierFromLayers,
} from "../lib/fishing/rules.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleUrl = relative => pathToFileURL(path.join(pluginRoot, relative)).href;

test("放贷四百，当竿不计息，抽成阈值为八百", () => {
  assert.equal(GHOST_DEBT_PRINCIPAL, 400);
  assert.equal(GHOST_DEBT_MARK_THRESHOLD, 800);
  const result = calculateGhostDebtPayment(0, 400);
  assert.equal(result.remainingDebt, 400);
  assert.equal(result.interestAdded, 0);
  assert.equal(result.writtenOff, false);
});

test("放贷达到八百或更高也保留债务，下一竿先还款、再计息、最后检查阈值", () => {
  for (const debt of [800, 900, 1200]) {
    const loan = calculateGhostDebtPayment(0, debt, { deferWriteOff: true, ghostMarkLayers: 2 });
    assert.equal(loan.remainingDebt, debt);
    assert.equal(loan.writtenOff, false);
    assert.equal(loan.interestAdded, 0);
    assert.equal(loan.ghostMarkLayers, 2);
  }
  for (const [earnings, remainingDebt, marks] of [[200, 750, 0], [100, 0, 1], [800, 0, 0]]) {
    const next = calculateGhostDebtPayment(earnings, 800, { accrueInterest: true });
    assert.equal(next.remainingDebt, remainingDebt);
    assert.equal(next.ghostMarkLayers, marks);
  }
});

test("未还款时欠款滚到八百以上才勾销，向上取整保持原利息规则", () => {
  let debt = 400, marks = 0;
  for (const remainingDebt of [500, 625, 782, 0]) {
    const result = calculateGhostDebtPayment(0, debt, {
      ghostMarkLayers: marks, accrueInterest: true,
    });
    assert.equal(result.remainingDebt, remainingDebt);
    assert.equal(result.writtenOff, remainingDebt === 0);
    assert.equal(result.ghostMarkLayers, remainingDebt === 0 ? 1 : 0);
    debt = result.remainingDebt; marks = result.ghostMarkLayers;
  }
});

test("欠款低于八百可持续超过四竿，旧期限参数不再影响结果", () => {
  let debt = calculateGhostDebtPayment(200, 400, { accrueInterest: true }).remainingDebt;
  for (let cast = 0; cast < 12; cast++) {
    const result = calculateGhostDebtPayment(50, debt, {
      debtTurnsRemaining: 0, accrueInterest: true,
    });
    assert.equal(result.remainingDebt, 250);
    assert.equal(result.writtenOff, false);
    assert.equal(result.ghostMarkLayers, 0);
    debt = result.remainingDebt;
  }
});

test("八百阈值包含恰好八百和越过阈值，七百九十九不触发", () => {
  for (const [debt, expectedDebt, writtenOff] of [[639, 799, false], [640, 0, true], [641, 0, true]]) {
    const result = calculateGhostDebtPayment(0, debt, { accrueInterest: true });
    assert.equal(result.remainingDebt, expectedDebt);
    assert.equal(result.writtenOff, writtenOff);
    assert.equal(result.ghostMarkLayers, Number(writtenOff));
  }
  // 先偿还本竿收益，偿还后滚到 799 可继续，滚到 800 才触发。
  assert.equal(calculateGhostDebtPayment(143, 782, { accrueInterest: true }).remainingDebt, 799);
  assert.equal(calculateGhostDebtPayment(142, 782, { accrueInterest: true }).writtenOff, true);
});

test("先还款再判断阈值，足额与超额还清不会新增印记", () => {
  for (const earnings of [782, 900]) {
    const result = calculateGhostDebtPayment(earnings, 782, {
      accrueInterest: true,
    });
    assert.equal(result.debtPaid, 782);
    assert.equal(result.earnings, earnings - 782);
    assert.equal(result.remainingDebt, 0);
    assert.equal(result.interestAdded, 0);
    assert.equal(result.writtenOff, false);
    assert.equal(result.ghostMarkLayers, 0);
  }
});

test("印记按零点九连乘，先抽成再抵债，达到阈值只新增一层", () => {
  for (const [layers, earnings] of [[0, 1000], [1, 900], [2, 810], [3, 729]]) {
    assert.equal(calculateGhostDebtPayment(1000, 0, { ghostMarkLayers: layers }).earnings, earnings);
    assert.equal(ghostMarkMultiplierFromLayers(layers), 0.9 ** layers);
  }
  const result = calculateGhostDebtPayment(100, 750, {
    ghostMarkLayers: 2, accrueInterest: true,
  });
  assert.equal(result.earningsAfterMark, 81);
  assert.equal(result.debtPaid, 81);
  assert.equal(result.debtAfterPayment, 669);
  assert.equal(result.earnings, 0);
  assert.equal(result.writtenOff, true);
  assert.equal(result.ghostMarkLayers, 3);
  assert.equal(calculateGhostDebtPayment(1000, 0, { ghostMarkLayers: result.ghostMarkLayers }).earnings, 729);
});

test("先偿还再滚百分之二十五利息，非抛竿收入只抵债不计息", () => {
  const cast = calculateGhostDebtPayment(100, 400, { accrueInterest: true });
  assert.equal(cast.debtPaid, 100);
  assert.equal(cast.remainingDebt, 375);
  const payment = calculateGhostDebtPayment(100, 375);
  assert.equal(payment.remainingDebt, 275);
  assert.equal(payment.interestAdded, 0);
  assert.equal(payment.writtenOff, false);
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

test("真实数据库结算覆盖超过四竿、旧期限、重复结算、重复放贷、抵债与净化", () => withFixture(fixtureRoot => {
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
    settlement.settleAttempt({sessionId: "loan", success: true, ghostLoanIssued: true});
    assert.equal(status().ghostDebt, 400);
    db.prepare("UPDATE fishing_stats SET ghost_debt_turns_remaining=0 WHERE group_id=? AND user_id=?").run("ghost-test",user);
    const firstArgs = {sessionId: "paid-first", fishId: "fish", earnings: 100};
    const first = settlement.settleCoinCatch(firstArgs);
    assert.equal(first.remainingDebt, 375);
    assert.equal(first.earnings, 0);
    assert.deepEqual(settlement.settleCoinCatch(firstArgs), {success: false, reason: "duplicate"});
    assert.equal(status().ghostDebt, 375);
    const box = settlement.settleInventoryCatch({sessionId: "treasure", fishId: "chest_pond"});
    assert.equal(box.remainingDebt, 469);
    const failed = settlement.settleAttempt({sessionId: "failed"});
    assert.equal(failed.remainingDebt, 587);
    const fourth = settlement.settleAttempt({sessionId: "fourth"});
    assert.equal(fourth.remainingDebt, 734);
    assert.equal(fourth.writtenOff, false);
    assert.equal(status().ghostMarkLayers, 0);
    const threshold = settlement.settleAttempt({sessionId: "threshold"});
    assert.equal(threshold.writtenOff, true);
    assert.equal(status().ghostDebt, 0);
    assert.equal(status().ghostMarkLayers, 1);
    assert.deepEqual(settlement.settleAttempt({sessionId: "threshold"}), {success: false, reason: "duplicate"});
    assert.equal(status().ghostMarkLayers, 1);
    assert.equal(new Manager("another-group").getNightmareStatus(user).ghostMarkLayers, 0);
    assert.equal(settlement.settleCoinCatch({sessionId: "marked-income", fishId: "fish", earnings: 1000}).earnings, 900);
    manager.addGhostDebt(user, 400);
    assert.equal(status().ghostMarkLayers, 1);
    const payment = settlement.settleCoinCatch({sessionId: "repay", fishId: "fish", earnings: 100});
    assert.equal(payment.debtPaid, 90);
    assert.equal(payment.remainingDebt, 388);
    for(let i=0;i<3;i++) settlement.settleAttempt({sessionId: "second-debt-"+i});
    assert.equal(status().ghostDebt, 759);
    assert.equal(status().ghostMarkLayers, 1);
    settlement.settleAttempt({sessionId: "second-debt-threshold"});
    assert.equal(status().ghostMarkLayers, 2);
    assert.equal(settlement.settleCoinCatch({sessionId: "twice-marked-income", fishId: "fish", earnings: 1000}).earnings, 810);
    manager.addGhostDebt(user, 400);
    settlement.settleAttempt({sessionId: "repeat-before-loan"});
    assert.equal(status().ghostDebt, 500);
    manager.addGhostDebt(user, 400);
    assert.equal(status().ghostDebt, 900);
    assert.equal(status().ghostMarkLayers, 2);
    const repeatLoan = settlement.settleAttempt({sessionId: "repeat-loan", success: true, ghostLoanIssued: true});
    assert.equal(repeatLoan.interestAdded, 0);
    assert.equal(repeatLoan.writtenOff, false);
    assert.equal(status().ghostDebt, 900);
    assert.equal(status().ghostMarkLayers, 2);
    assert.deepEqual(settlement.settleAttempt({sessionId: "repeat-loan", ghostLoanIssued: true}), {success: false, reason: "duplicate"});
    assert.equal(status().ghostDebt, 900);
    // 已有两层抽成，500收益先变405，再抵债，余款495计息为619，仍有还款机会。
    const afterLoan = settlement.settleCoinCatch({sessionId: "repay-repeat-loan", fishId: "fish", earnings: 500});
    assert.equal(afterLoan.remainingDebt, 619);
    assert.equal(status().ghostMarkLayers, 2);
    settlement.settleAttempt({sessionId: "after-repeat-loan-1"});
    settlement.settleAttempt({sessionId: "after-repeat-loan-2"});
    assert.equal(status().ghostDebt, 0);
    assert.equal(status().ghostMarkLayers, 3);
    manager.addGhostDebt(user, 400);
    const coinsBefore = db.prepare("SELECT coins FROM economy WHERE group_id=? AND user_id=?").get("ghost-test",user).coins;
    const purified = manager.clearNightmareDebuffs(user);
    assert.equal(purified.ghostMarkLayers, 3);
    assert.equal(status().ghostDebt, 0);
    assert.equal(status().ghostMarkLayers, 0);
    assert.equal(status().ghostMarkMultiplier, 1);
    assert.equal(db.prepare("SELECT coins FROM economy WHERE group_id=? AND user_id=?").get("ghost-test",user).coins, coinsBefore);
    db.db.close();
    process.exit(0);
  `);
}));

test("真实借款八百后下一竿还二百可保留债务，还一百才触发印记，足额还清无印记", () => withFixture(fixtureRoot => {
  runIsolated(fixtureRoot, `
    import assert from "node:assert/strict";
    const {default: Manager} = await import(${JSON.stringify(moduleUrl("lib/economy/FishingManager.js"))});
    const {default: Settlement} = await import(${JSON.stringify(moduleUrl("lib/fishing/SettlementService.js"))});
    const {default: db} = await import(${JSON.stringify(moduleUrl("lib/Database.js"))});
    for (const [payment, debt, marks] of [[200,750,0],[100,0,1],[800,0,0]]) {
      const user = "repay-" + payment;
      const manager = new Manager("loan-test");
      const settlement = new Settlement({group_id: "loan-test", user_id: user});
      manager.addGhostDebt(user, 800);
      const loan = settlement.settleAttempt({sessionId: "loan-" + user, success: true, ghostLoanIssued: true});
      assert.equal(loan.remainingDebt, 800);
      assert.equal(loan.ghostMarkLayers, 0);
      assert.equal(loan.interestAdded, 0);
      const next = settlement.settleCoinCatch({sessionId: "next-" + user, fishId: "fish", earnings: payment});
      assert.equal(next.remainingDebt, debt);
      assert.equal(next.ghostMarkLayers, marks);
      assert.deepEqual(settlement.settleCoinCatch({sessionId: "next-" + user, fishId: "fish", earnings: payment}), {success: false, reason: "duplicate"});
      assert.equal(manager.getNightmareStatus(user).ghostDebt, debt);
      assert.equal(manager.getNightmareStatus(user).ghostMarkLayers, marks);
    }
    db.db.close();
    process.exit(0);
  `);
}));

test("已有数据库仍可启动，保留旧字段但不转换债务或印记状态", () => withFixture(fixtureRoot => {
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
