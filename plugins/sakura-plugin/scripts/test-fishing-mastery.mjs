// node --test plugins/sakura-plugin/scripts/test-fishing-mastery.mjs
// 使用临时数据库验证熟练度继续增长，职业承重读取完整熟练度。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const managerUrl = pathToFileURL(path.join(pluginRoot, "lib/economy/FishingManager.js")).href;
const databaseUrl = pathToFileURL(path.join(pluginRoot, "lib/Database.js")).href;
const rulesUrl = pathToFileURL(path.join(pluginRoot, "lib/fishing/rules.js")).href;

test("鱼竿控制力封顶不截断熟练度，钓鱼大师两级鱼线加成都无上限", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sakura-fishing-mastery-"));
  const economyDir = path.join(fixtureRoot, "plugins/sakura-plugin/resources/economy");
  fs.mkdirSync(economyDir, { recursive: true });
  for (const name of ["shop.yaml", "profession.yaml"]) {
    fs.copyFileSync(path.join(pluginRoot, "resources/economy", name), path.join(economyDir, name));
  }
  const script = `
    import assert from "node:assert/strict";
    const { default: FishingManager } = await import(${JSON.stringify(managerUrl)});
    const { default: db } = await import(${JSON.stringify(databaseUrl)});
    const { getMasteryControlBonus } = await import(${JSON.stringify(rulesUrl)});
    const manager = new FishingManager("group-a");
    const userId = "user-a", rodId = "rod_legendary";
    manager.getUserData(userId);
    db.prepare("UPDATE fishing_stats SET fishing_exp = 5000 WHERE group_id = ? AND user_id = ?")
      .run("group-a", userId);
    assert.equal(manager.chooseProfession(userId, "fishing_master").success, true);
    db.prepare("INSERT INTO rod_stats (group_id, user_id, rod_id, damage, mastery) VALUES (?, ?, ?, 0, 100)")
      .run("group-a", userId, rodId);
    for (const [level, multiplier] of [[1, 0.25], [2, 0.5]]) {
      if (level === 2) assert.equal(manager.advanceProfession(userId).success, true);
      for (const mastery of [99, 100, 101, 200, 10000]) {
        db.prepare("UPDATE rod_stats SET mastery = ? WHERE group_id = ? AND user_id = ? AND rod_id = ?")
          .run(mastery, "group-a", userId, rodId);
        assert.equal(manager.getRodMastery(userId, rodId), mastery);
        assert.equal(getMasteryControlBonus(manager.getRodMastery(userId, rodId)), mastery < 100 ? 49 : 50);
        assert.equal(manager.getLineBonusFromMastery(userId, rodId), Math.floor(mastery * multiplier));
        manager.increaseRodMastery(userId, rodId);
        assert.equal(manager.getRodMastery(userId, rodId), mastery + 1);
        assert.equal(manager.getLineBonusFromMastery(userId, rodId), Math.floor((mastery + 1) * multiplier));
      }
    }
    assert.equal(manager.getLineBonusFromMastery("non-master", rodId), 0);
    process.exit(0);
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "production" },
      timeout: 20000,
    });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  } finally {
    const resolved = path.resolve(fixtureRoot);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
