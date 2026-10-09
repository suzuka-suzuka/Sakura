import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "../../..");
const fishingManagerUrl = pathToFileURL(path.join(
  projectRoot,
  "plugins/sakura-plugin/lib/economy/FishingManager.js",
)).href;
const databaseUrl = pathToFileURL(path.join(
  projectRoot,
  "plugins/sakura-plugin/lib/Database.js",
)).href;

test("噩梦持久状态、鱼竿耐久和背包偷取按当前规则结算", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sakura-nightmare-manager-"));
  const fixtureEconomyDir = path.join(
    fixtureRoot,
    "plugins/sakura-plugin/resources/economy",
  );
  fs.mkdirSync(fixtureEconomyDir, { recursive: true });
  fs.copyFileSync(
    path.join(projectRoot, "plugins/sakura-plugin/resources/economy/shop.yaml"),
    path.join(fixtureEconomyDir, "shop.yaml"),
  );
  fs.copyFileSync(
    path.join(projectRoot, "plugins/sakura-plugin/resources/economy/profession.yaml"),
    path.join(fixtureEconomyDir, "profession.yaml"),
  );

  const script = `
    import assert from "node:assert/strict";
    const { default: FishingManager } = await import(${JSON.stringify(fishingManagerUrl)});
    const { default: db } = await import(${JSON.stringify(databaseUrl)});
    const manager = new FishingManager("group-a");
    const userId = "user-a";
    manager.getUserData(userId);

    db.prepare(\`
      UPDATE fishing_stats SET fishing_exp = 5000
      WHERE group_id = ? AND user_id = ?
    \`).run("group-a", userId);
    assert.equal(manager.chooseProfession(userId, "abyss_hunter").success, true);
    const levelOne = manager.getNightmareImmunityStatus(userId);
    assert.deepEqual(levelOne, { active: true, chance: 0.3 });
    assert.equal(manager.rollNightmareImmunity(userId, () => 0.299999).immune, true);
    assert.equal(manager.rollNightmareImmunity(userId, () => 0.3).immune, false);
    // 连续触发不消耗次数；旧充能数据不会影响新概率。
    db.prepare(\`
      UPDATE fishing_stats SET nightmare_immunity_charges = 0, nightmare_immunity_updated_at = ?
      WHERE group_id = ? AND user_id = ?
    \`).run(Date.now(), "group-a", userId);
    for (let index = 0; index < 10; index++) {
      assert.equal(manager.rollNightmareImmunity(userId, () => 0).immune, true);
    }
    let levelOneHits = 0;
    for (let index = 0; index < 1000; index++) {
      if (manager.rollNightmareImmunity(userId, () => index / 1000).immune) levelOneHits++;
    }
    assert.equal(levelOneHits, 300);

    assert.equal(manager.advanceProfession(userId).success, true);
    const advanced = manager.getNightmareImmunityStatus(userId);
    assert.deepEqual(advanced, { active: true, chance: 0.5 });
    assert.equal(manager.rollNightmareImmunity(userId, () => 0.499999).immune, true);
    assert.equal(manager.rollNightmareImmunity(userId, () => 0.5).immune, false);
    let levelTwoHits = 0;
    for (let index = 0; index < 1000; index++) {
      if (manager.rollNightmareImmunity(userId, () => index / 1000).immune) levelTwoHits++;
    }
    assert.equal(levelTwoHits, 500);
    assert.deepEqual(manager.getNightmareImmunityStatus("non-hunter"), { active: false, chance: 0 });
    assert.equal(manager.rollNightmareImmunity("non-hunter", () => assert.fail("非深渊猎手不抽免疫概率")).immune, false);
    assert.equal(FishingManager.getNightmareImmunityRules("abyss_hunter", 0), null);
    assert.equal(FishingManager.getNightmareImmunityRules("abyss_hunter", 3), null);
    const profession = FishingManager.getProfessionConfig("abyss_hunter");
    for (const [configured, expected] of [[-0.1, 0], [0, 0], [1, 1], [1.1, 1]]) {
      profession.levels[2].nightmare_immunity_chance = configured;
      assert.equal(manager.getNightmareImmunityStatus(userId).chance, expected);
      assert.equal(manager.rollNightmareImmunity(userId, () => assert.fail("0%或100%不需要随机抽签")).immune, expected === 1);
    }
    profession.levels[2].nightmare_immunity_chance = "无效";
    assert.deepEqual(manager.getNightmareImmunityStatus(userId), { active: false, chance: 0 });
    profession.levels[2].nightmare_immunity_chance = 0.5;

    const addItem = (itemId, count = 1) => db.prepare(\`
      INSERT INTO inventory (group_id, user_id, item_id, count)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(group_id, user_id, item_id)
      DO UPDATE SET count = count + excluded.count
    \`).run("group-a", userId, itemId, count);
    const itemCount = (itemId) => db.prepare(\`
      SELECT count FROM inventory
      WHERE group_id = ? AND user_id = ? AND item_id = ?
    \`).get("group-a", userId, itemId)?.count || 0;

    addItem("rod_carbon");
    assert.equal(manager.getRodControl(userId, "rod_carbon"), 110);
    manager.damageRod(userId, "rod_carbon", 5);
    assert.equal(manager.getRodStats(userId, "rod_carbon").damage, 5);
    assert.equal(manager.getRodControl(userId, "rod_carbon"), 104.5);

    assert.deepEqual(manager.applyBrideNightmareMultiplier(userId, 2), {
      applied: true,
      before: 1,
      total: 2,
    });
    assert.deepEqual(manager.applyBrideNightmareMultiplier(userId, 2), {
      applied: true,
      before: 2,
      total: 4,
    });
    assert.equal(manager.getNightmareStatus(userId).brideNightmareMultiplier, 4);

    for (let index = 0; index < 6; index += 1) manager.addGhostDebt(userId, 100);
    assert.equal(manager.getNightmareStatus(userId).ghostDebt, 600);
    assert.equal(manager.getNightmareStatus(userId).ghostDebtTurnsRemaining, 4);

    // 深压回响：持久累加层数，每层让鱼竿实际控制力再 ×0.8，倍率由层数派生。
    assert.equal(manager.addDeepPressureLayers(userId, 1).total, 1);
    const stackedDeepPressure = manager.addDeepPressureLayers(userId, 1);
    assert.equal(stackedDeepPressure.total, 2);
    assert.ok(Math.abs(stackedDeepPressure.multiplier - 0.64) < 1e-9);
    assert.equal(manager.getDeepPressureLayers(userId), 2);
    assert.ok(Math.abs(manager.getNightmareStatus(userId).deepPressureMultiplier - 0.64) < 1e-9);
    // 修理工具箱可单独解除深压回响；随后重新叠回 2 层供后续净化断言。
    const toolboxClear = manager.clearDeepPressure(userId);
    assert.equal(toolboxClear.cleared, true);
    assert.equal(toolboxClear.before, 2);
    assert.ok(Math.abs(toolboxClear.beforeMultiplier - 0.64) < 1e-9);
    assert.equal(manager.getDeepPressureLayers(userId), 0);
    assert.equal(manager.clearDeepPressure(userId).cleared, false);
    manager.addDeepPressureLayers(userId, 2);

    // 诅咒：命中 +1，生效期每抛一竿累加，钓到任意噩梦即清空。
    assert.equal(manager.addNightmareCurseLayers(userId, 1), 1);
    assert.equal(manager.accrueNightmareCurseLayer(userId), 2);
    assert.equal(manager.accrueNightmareCurseLayer(userId), 3);
    assert.equal(manager.resetNightmareCurse(userId).cleared, 3);
    assert.equal(manager.getNightmareCurseLayers(userId), 0);
    // 清空后 accrue 不会凭空造层（仅在生效期累加）。
    assert.equal(manager.accrueNightmareCurseLayer(userId), 0);
    manager.addNightmareCurseLayers(userId, 5);

    assert.equal(manager.addBlindnessLayers(userId).layers, 1);
    assert.equal(manager.addBlindnessLayers(userId).layers, 2);
    assert.ok(Math.abs(manager.getNightmareStatus(userId).reelHitRate - 0.81) < 1e-10);
    assert.equal(new FishingManager("group-a").getNightmareStatus(userId).blindnessLayers, 2);
    assert.equal(new FishingManager("group-b").getNightmareStatus(userId).blindnessLayers, 0);
    manager.repairRod(userId, "rod_carbon");
    assert.equal(manager.getNightmareStatus(userId).blindnessLayers, 2);
    manager.damageRod(userId, "rod_carbon", 5);
    const cleansable = manager.getCleansableNightmareAfflictions(userId);
    assert.equal(cleansable.curseLayers, 5);
    assert.equal(cleansable.brideMarked, true);
    assert.equal(cleansable.brideNightmareMultiplier, 4);
    assert.equal(cleansable.ghostDebt, 600);
    assert.equal(cleansable.deepPressureMarked, true);
    assert.equal(cleansable.deepPressureLayers, 2);
    assert.ok(Math.abs(cleansable.deepPressureMultiplier - 0.64) < 1e-9);
    assert.equal(cleansable.total, 5);
    assert.equal(cleansable.blindnessLayers, 2);

    const purified = manager.clearNightmareDebuffs(userId);
    assert.equal(purified.cleared, 5);
    assert.deepEqual(manager.getNightmareStatus(userId), {
      curse: {
        actualLayers: 0,
        displayedLayers: 0,
        isPranked: false,
      },
      brideNightmareMultiplier: 1,
      ghostDebt: 0,
      ghostDebtTurnsRemaining: 0,
      ghostMarked: false,
      ghostMarkLayers: 0,
      ghostMarkMultiplier: 1,
      deepPressureLayers: 0,
      deepPressureMultiplier: 1,
      blindnessLayers: 0,
      reelHitRate: 1,
    });
    assert.equal(manager.getRodStats(userId, "rod_carbon").damage, 5);
    assert.equal(manager.getRodControl(userId, "rod_carbon"), 104.5);
    assert.deepEqual(manager.repairRod(userId, "rod_carbon"), {
      durabilityRepaired: 5,
    });
    assert.equal(manager.getRodStats(userId, "rod_carbon").damage, 0);
    assert.equal(manager.getRodControl(userId, "rod_carbon"), 110);

    db.prepare(\`
      UPDATE fishing_stats SET fishing_stamina = 7, fishing_stamina_updated_at = ?
      WHERE group_id = ? AND user_id = ?
    \`).run(Date.now(), "group-a", userId);
    const forced = manager.forceFishingStaminaToOne(userId);
    assert.equal(forced.previous, 7);
    assert.equal(forced.current, 1);

    addItem("bait_worm", 2);
    addItem("bait_divine", 1);
    addItem("bait_treasure", 1);
    const stolen = manager.stealHighestValueBait(userId);
    assert.equal(stolen.stolen, true);
    assert.equal(stolen.bait.id, "bait_treasure");
    assert.equal(itemCount("bait_treasure"), 0);

    db.prepare("DELETE FROM inventory WHERE group_id = ? AND user_id = ? AND item_id LIKE 'bait_%'")
      .run("group-a", userId);
    addItem("chest_pond", 1);
    const devoured = manager.devourRandomInventoryItem(userId, ["rod_carbon"], () => 0);
    assert.equal(devoured.itemId, "chest_pond");
    assert.equal(itemCount("chest_pond"), 0);
    assert.equal(manager.devourRandomInventoryItem(userId, ["rod_carbon"], () => 0), null);
    assert.equal(itemCount("rod_carbon"), 1);
    process.exit(0);
  `;

  try {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "production" },
        timeout: 20_000,
      },
    );
    assert.equal(
      result.status,
      0,
      `隔离噩梦结算测试失败\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
