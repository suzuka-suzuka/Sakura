// 使用本机 Chrome 验证真实运行时生图路径；不连接 QQ、Redis 或数据库。
// node plugins/sakura-plugin/scripts/test-fishing-encounter-render.mjs
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFishingEncounterImage, closeFishingEncounterBrowser } from "../lib/fishing/encounterImages.js";
import { analyzeEncounterChoices, encounterFingerprint, solveEncounter, validateEncounterInput } from "../lib/fishing/encounter.js";

try {
  const images = [];
  const reports = [];
  for (let index = 0; index < 3; index++) {
    const started = performance.now();
    // 故意复用种子，验证真实服务仍排除近期布局并重新渲染。
    const { map, image } = await createFishingEncounterImage({ seed: "运行时生图回归" });
    const choices = analyzeEncounterChoices(map);
    const solutions = solveEncounter(map);
    assert.equal(choices.hasMeaningfulChoice, true);
    assert.equal(map.rows.length, 6);
    assert.ok(map.rows.every(row => row.length === 5));
    assert.ok(choices.routes.length >= 3 && choices.routes.length <= 4);
    assert.ok(choices.underRoutes.length >= 1 && choices.overRoutes.length >= 1);
    assert.ok(solutions.length > 0 && solutions.every(route => validateEncounterInput(map, route.sequence).success));
    assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(image.readUInt32BE(16), 1800);
    assert.ok(images.every(previous => encounterFingerprint(previous.map) !== encounterFingerprint(map) && !previous.image.equals(image)));
    assert.notEqual(map.limits.actions, images.at(-1)?.map.limits.actions);
    reports.push({ maxActions: map.limits.actions, routes: choices.routes.length, valid: solutions.length, bytes: image.length, elapsedMs: Math.round(performance.now() - started) });
    images.push({ map, image });
  }
  // 复现开发模式快照的“复制 lib、共用 resources”，确保不依赖源码目录层级。
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cacheRoot = path.resolve(pluginRoot, "../../.cache");
  await fs.mkdir(cacheRoot, { recursive: true });
  const snapshotRoot = await fs.mkdtemp(path.join(cacheRoot, "fishing-render-snapshot-check-"));
  let snapshotModule;
  let snapshotReport;
  const resourcesLink = path.join(snapshotRoot, "v1/sakura-plugin/resources");
  try {
    const targetDir = path.join(snapshotRoot, "v1/sakura-plugin/lib/fishing");
    await fs.mkdir(targetDir, { recursive: true });
    for (const name of ["encounter.js", "encounterImages.js", "encounterRenderer.js"]) {
      await fs.copyFile(path.join(pluginRoot, "lib/fishing", name), path.join(targetDir, name));
    }
    await fs.symlink(path.join(pluginRoot, "resources"), resourcesLink, "junction");
    snapshotModule = await import(pathToFileURL(path.join(targetDir, "encounterImages.js")));
    const { map, image } = await snapshotModule.createFishingEncounterImage({ seed: "热重载快照小图" });
    assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(map.rows.length, 6);
    assert.ok(solveEncounter(map).every(route => validateEncounterInput(map, route.sequence).success));
    snapshotReport = { maxActions: map.limits.actions, bytes: image.length };
  } finally {
    await snapshotModule?.closeFishingEncounterBrowser();
    // 先解除资源 junction，再确认临时路径位于本次缓存目录内后删除。
    await fs.unlink(resourcesLink).catch(error => { if (error.code !== "ENOENT") throw error; });
    const resolvedSnapshot = await fs.realpath(snapshotRoot);
    assert.equal(path.dirname(resolvedSnapshot), await fs.realpath(cacheRoot));
    assert.ok(path.basename(resolvedSnapshot).startsWith("fishing-render-snapshot-check-"));
    await fs.rm(resolvedSnapshot, { recursive: true, force: true });
  }
  process.stdout.write(JSON.stringify({ rendered: reports, runtimeSnapshot: snapshotReport }, null, 2) + "\n");
} finally {
  await closeFishingEncounterBrowser();
}
