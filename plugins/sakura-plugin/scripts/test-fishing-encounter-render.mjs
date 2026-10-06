// 使用本机 Chrome 验证真实运行时生图路径；不连接 QQ、Redis 或数据库。
// node plugins/sakura-plugin/scripts/test-fishing-encounter-render.mjs
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
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
    assert.ok(solutions.length > 0 && solutions.every(route => validateEncounterInput(map, route.sequence).success));
    assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(image.readUInt32BE(16), 1800);
    assert.ok(images.every(previous => encounterFingerprint(previous.map) !== encounterFingerprint(map) && !previous.image.equals(image)));
    assert.notEqual(map.limits.actions, images.at(-1)?.map.limits.actions);
    reports.push({ actions: map.limits.actions, routes: choices.routes.length, valid: solutions.length, bytes: image.length, elapsedMs: Math.round(performance.now() - started) });
    images.push({ map, image });
  }
  process.stdout.write(JSON.stringify({ rendered: reports }, null, 2) + "\n");
} finally {
  await closeFishingEncounterBrowser();
}
