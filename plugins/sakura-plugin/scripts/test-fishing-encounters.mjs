import test from "node:test";
import assert from "node:assert/strict";
import { generateEncounterMaps, solveEncounter, analyzeEncounterChoices, validateEncounterInput, parseEncounterInput, createEncounterAttempt, submitEncounterAttempt, getEncounterRewardMultiplier, encounterFingerprint, rollFishingEncounter, applyEncounterReward } from "../lib/fishing/encounter.js";
import { buildEncounterHtml } from "../lib/fishing/encounterRenderer.js";

const fixture = { id: "test-map", rows: ["#S###", "#A..#", "###B#", "###.#", "###G#"], limits: { actions: 9 } };
const answer = "A下右右B下下下";

test("中文、zysx、大小写及混合输入判同一条路线", () => {
  for (const input of [answer, "AxYYbXXX", "a下y右Bxx下", " aX yY bX xX ", "A↓→→B↓↓↓"]) {
    const result = validateEncounterInput(fixture, input);
    assert.equal(result.success, true, input);
    assert.deepEqual([result.moves, result.usedA, result.usedB, result.actions], [6, 1, 1, 9]);
  }
  for (const input of ["", "帮我解题", "abx", "a", "xx!"]) assert.equal(parseEncounterInput(input), null);
});

test("必须匹配地形和收鱼点，A/B 不能乱按凑数", () => {
  assert.equal(validateEncounterInput(fixture, "下右右下下下").success, false);
  assert.equal(validateEncounterInput(fixture, "B下右右A下下下").success, false);
  assert.equal(validateEncounterInput(fixture, "上").success, false);
  assert.equal(validateEncounterInput(fixture, "A下右右B下下").success, false);
  assert.equal(validateEncounterInput(fixture, answer + "上").success, false);
  assert.equal(validateEncounterInput({ ...fixture, limits: { actions: 9 } }, "AxAyyBxxx").reason, "地形与动作不匹配");
});

test("移动与 A/B 都计行动，达到终点时多一次或少一次都失败", () => {
  const under = validateEncounterInput({ ...fixture, limits: { actions: 10 } }, answer);
  assert.equal(under.success, false);
  assert.equal(under.reason, "少于指定行动数");
  assert.equal(under.actions, 9);
  const over = validateEncounterInput({ ...fixture, limits: { actions: 8 } }, answer);
  assert.equal(over.success, false);
  assert.equal(over.reason, "超过指定行动数");
  assert.equal(over.actions, 9);
});

test("不能回走凑数，也不能再次进入起点", () => {
  const backtrack = validateEncounterInput({ ...fixture, limits: { actions: 10 } }, "AxyyzyBxxx");
  assert.equal(backtrack.reason, "重复经过格子");
  const revisitStart = validateEncounterInput({ ...fixture, limits: { actions: 11 } }, "AxsAxyyBxxx");
  assert.equal(revisitStart.reason, "重复经过格子");
  assert.equal(revisitStart.step, 2);
});

test("精确行动数相同的不同路线都接受，求解不能合并它们", () => {
  const twoRoutes = { id: "two-routes", rows: ["##S##", "#...#", "#.#.#", "#...#", "##G##"], limits: { actions: 6 } };
  for (const input of ["xz xxyx", "xyxxzx"]) assert.equal(validateEncounterInput(twoRoutes, input).success, true);
  assert.equal(solveEncounter(twoRoutes).length, 2);
  const limitedSearch = analyzeEncounterChoices(twoRoutes, { maxPaths: 1 });
  assert.equal(limitedSearch.truncated, true);
  assert.equal(limitedSearch.hasMeaningfulChoice, false);
});

test("30 秒内两倍，之后线性下降，60 秒整失败", () => {
  for (const elapsedMs of [0, 29_999, 30_000]) assert.equal(getEncounterRewardMultiplier(elapsedMs), 2);
  assert.equal(getEncounterRewardMultiplier(45_000), 1.5);
  assert.ok(getEncounterRewardMultiplier(59_999) > 1 && getEncounterRewardMultiplier(59_999) < 1.001);
  for (const elapsedMs of [-1, NaN, Infinity, 60_000, 60_001]) assert.equal(getEncounterRewardMultiplier(elapsedMs), 0);
});

test("首次错误也消耗唯一作答机会，超时不能成功", () => {
  const attempt = createEncounterAttempt(fixture, 1000);
  assert.equal(submitEncounterAttempt(attempt, "乱填", 2000).success, false);
  assert.equal(submitEncounterAttempt(attempt, answer, 3000).accepted, false);
  const expired = submitEncounterAttempt(createEncounterAttempt(fixture, 1000), answer, 61_000);
  assert.equal(expired.success, false);
  assert.equal(expired.multiplier, 0);
  const success = submitEncounterAttempt(createEncounterAttempt(fixture, 1000), answer, 46_000);
  assert.equal(success.success, true);
  assert.equal(success.multiplier, 1.5);
});

test("单通道的往返绕圈不算路线取舍", () => {
  const padded = { ...fixture, limits: { actions: 14 } };
  assert.equal(solveEncounter(padded).length, 0);
  const analysis = analyzeEncounterChoices(padded);
  assert.equal(analysis.routes.length, 1);
  assert.equal(analysis.hasMeaningfulChoice, false);
  assert.equal(analysis.truncated, false);
});

test("种子可重现，1250 张随机地图都有路线取舍，布局和小批次限制不重复", () => {
  assert.deepEqual(generateEncounterMaps({ seed: "固定种子" }), generateEncounterMaps({ seed: "固定种子" }));
  for (let seed = 0; seed < 250; seed++) {
    const maps = generateEncounterMaps({ count: 5, seed: `校验-${seed}` });
    assert.equal(new Set(maps.map(encounterFingerprint)).size, maps.length);
    assert.equal(new Set(maps.map(map => JSON.stringify(map.limits))).size, maps.length);
    for (const map of maps) {
      const choices = analyzeEncounterChoices(map);
      assert.equal(choices.truncated, false);
      assert.equal(choices.hasMeaningfulChoice, true);
      assert.ok(choices.routes.length >= 3 && choices.actionCounts.length >= 3);
      assert.ok(choices.validRoutes.length >= 1 && choices.underRoutes.length >= 1 && choices.overRoutes.length >= 1);
      assert.ok(choices.tradeoffPairs.length >= 1);
      assert.deepEqual(Object.keys(map.limits), ["actions"]);
      for (const route of choices.routes) {
        assert.equal(validateEncounterInput(map, route.sequence).success, choices.validRoutes.includes(route));
      }
      const solutions = solveEncounter(map);
      assert.ok(solutions.length > 0, map.id);
      for (const solution of solutions) assert.equal(validateEncounterInput(map, solution.sequence).success, true);
      const shortest = solutions[0];
      assert.ok(shortest.moves >= 8 && shortest.moves <= 16);
      assert.equal(shortest.actions, map.limits.actions);
      assert.ok(shortest.a + shortest.b >= 1);
    }
  }
});

test("资源图没有标题、时限、奖励、输入教学或解法", () => {
  const html = buildEncounterHtml(fixture);
  assert.ok(html.includes('行动 = <span class="count">9</span>'));
  for (const unwanted of ["倒计时", "奖励", "测试上限", "A＋方向", "一条消息", "浅湾脱困", "≤", " 步", "×", 'class="key"', answer]) assert.equal(html.includes(unwanted), false);
});

test("逐场生成排除近期布局，并避免行动数连续相同", () => {
  const recent = [];
  for (let index = 0; index < 80; index++) {
    const [map] = generateEncounterMaps({ count: 1, seed: `运行时-${index}`, excluded: recent });
    assert.ok(!recent.some(previous => encounterFingerprint(previous) === encounterFingerprint(map)));
    assert.notEqual(map.limits.actions, recent.at(-1)?.limits.actions);
    recent.push(map);
    if (recent.length > 32) recent.shift();
  }
});

test("普通、宝藏与噩梦都只抽取一次遭遇，首领与鱼雷不触发", () => {
  for (const fish of [{id:'fish'}, {id:'treasure',isTreasure:true}, {id:'nightmare',rarity:'噩梦'}]) {
    const state = { fish }; let draws = 0;
    assert.equal(rollFishingEncounter(state, 0.2, () => { draws++; return 0.1; }), true);
    assert.equal(rollFishingEncounter(state, 0.2, () => { draws++; return 0.1; }), false);
    assert.equal(draws, 1);
  }
  assert.equal(rollFishingEncounter({fish:{isTorpedo:true}}, 1), false);
  assert.equal(rollFishingEncounter({fish:{id:'fish'},hasLucky:true}, 1, () => assert.fail('好运护符不抽签')), false);
  assert.equal(rollFishingEncounter({fish:{is_boss:true}}, 1, () => assert.fail('首领不抽签')), false);
  assert.equal(rollFishingEncounter({fish:{id:'fish'}}, 0, () => assert.fail('关闭时不抽签')), false);
  assert.equal(rollFishingEncounter({fish:{id:'fish'}}, 1, () => assert.fail('必触发时不抽签')), true);
});

test("遭遇倍率只缩放正向整数奖励，保持 0 与取整", () => {
  assert.equal(applyEncounterReward(100, 1.5), 150);
  assert.equal(applyEncounterReward(1, 1.5), 2);
  assert.equal(applyEncounterReward(0, 2), 0);
  for (const multiplier of [0, -1, 2.1, NaN]) assert.throws(() => applyEncounterReward(100, multiplier));
});
