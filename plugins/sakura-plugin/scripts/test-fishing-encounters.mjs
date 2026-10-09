import test from "node:test";
import assert from "node:assert/strict";
import { generateEncounterMaps, solveEncounter, analyzeEncounterChoices, validateEncounterInput, parseEncounterInput, isEncounterAnswerMessage, createEncounterAttempt, submitEncounterAttempt, getEncounterRewardMultiplier, encounterFingerprint, rollFishingEncounter, applyEncounterReward } from "../lib/fishing/encounter.js";
import { buildEncounterHtml } from "../lib/fishing/encounterRenderer.js";

const fixture = { id: "test-map", rows: ["#S###", "#A..#", "###B#", "###.#", "###G#"], limits: { actions: 9 } };
const answer = "A下右右B下下下";

test("中文、zysx、大小写及混合输入判同一条路线", () => {
  for (const input of [answer, "AxYYbXXX", "a下y右Bxx下", " aXyYbXxX "]) {
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

test("移动与 A/B 都计行动，必须恰好等于规定行动数，少用或多用都失败", () => {
  const under = validateEncounterInput({ ...fixture, limits: { actions: 10 } }, answer);
  assert.equal(under.success, false);
  assert.equal(under.reason, "未用完规定行动数");
  assert.equal(under.actions, 9);
  assert.equal(validateEncounterInput(fixture, answer).success, true);
  const over = validateEncounterInput({ ...fixture, limits: { actions: 8 } }, answer);
  assert.equal(over.success, false);
  assert.equal(over.reason, "超过规定行动数");
  assert.equal(over.actions, 9);
});

test("不能回走凑数，也不能再次进入起点", () => {
  const backtrack = validateEncounterInput({ ...fixture, limits: { actions: 10 } }, "AxyyzyBxxx");
  assert.equal(backtrack.reason, "重复经过格子");
  const revisitStart = validateEncounterInput({ ...fixture, limits: { actions: 11 } }, "AxsAxyyBxxx");
  assert.equal(revisitStart.reason, "重复经过格子");
  assert.equal(revisitStart.step, 2);
});

test("恰好用完行动的不同路线都接受，求解不能合并它们", () => {
  const twoRoutes = { id: "two-routes", rows: ["##S##", "#...#", "#.#.#", "#...#", "##G##"], limits: { actions: 6 } };
  for (const input of ["xzxxyx", "xyxxzx"]) assert.equal(validateEncounterInput(twoRoutes, input).success, true);
  assert.equal(solveEncounter(twoRoutes).length, 2);
  const noExactRoute = { ...twoRoutes, limits: { actions: 7 } };
  assert.equal(solveEncounter(noExactRoute).length, 0);
  assert.equal(analyzeEncounterChoices(noExactRoute).underRoutes.length, 2);
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

test("非操作消息忽略，首次操作串错误消耗唯一机会，超时不能成功", () => {
  const attempt = createEncounterAttempt(fixture, 1000);
  for (const input of ["", "乱填", `答案是${answer}`, "Ax yy Bxxx", "A↓→→B↓↓↓", "AxYYbXXX!"]) {
    assert.equal(isEncounterAnswerMessage(input), false);
    assert.equal(submitEncounterAttempt(attempt, input, 2000).accepted, false);
    assert.equal(attempt.submitted, false);
  }
  for (const input of [answer, "AxYYbXXX", "a下y右Bxx下", "abx", "A", " sxzyAB "]) assert.equal(isEncounterAnswerMessage(input), true);
  assert.equal(submitEncounterAttempt(attempt, "abx", 2000).accepted, true);
  assert.equal(attempt.submitted, true);
  assert.equal(submitEncounterAttempt(attempt, answer, 3000).accepted, false);
  const expired = submitEncounterAttempt(createEncounterAttempt(fixture, 1000), answer, 61_000);
  assert.equal(expired.success, false);
  assert.equal(expired.multiplier, 0);
  const success = submitEncounterAttempt(createEncounterAttempt(fixture, 1000), answer, 46_000);
  assert.equal(success.success, true);
  assert.equal(success.multiplier, 1.5);
});

test("到终点但行动不足也消耗唯一机会且没有奖励", () => {
  const attempt = createEncounterAttempt({ ...fixture, limits: { actions: 10 } }, 1000);
  const result = submitEncounterAttempt(attempt, answer, 2000);
  assert.equal(result.accepted, true);
  assert.equal(result.success, false);
  assert.equal(result.reason, "未用完规定行动数");
  assert.equal(result.multiplier, 0);
  assert.equal(submitEncounterAttempt(attempt, answer, 3000).accepted, false);
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
      assert.ok(choices.routes.length >= 3 && choices.actionCounts.length >= 2);
      assert.ok(choices.routes.length <= 4);
      assert.ok(choices.validRoutes.length >= 1 && choices.overRoutes.length >= 1);
      assert.deepEqual(choices.validRoutes, choices.atLimitRoutes);
      assert.ok(choices.validRoutes.length <= 2);
      assert.ok(choices.tradeoffPairs.length >= 1);
      assert.deepEqual(Object.keys(map.limits), ["actions"]);
      assert.equal(map.rows.length, 6);
      assert.ok(map.rows.every(row => row.length === 5));
      assert.ok(map.limits.actions >= 9 && map.limits.actions <= 13);
      for (const route of choices.routes) {
        assert.equal(validateEncounterInput(map, route.sequence).success, choices.validRoutes.includes(route));
      }
      const solutions = solveEncounter(map);
      assert.ok(solutions.length > 0, map.id);
      for (const solution of solutions) assert.equal(validateEncounterInput(map, solution.sequence).success, true);
      for (const solution of solutions) {
        assert.ok(solution.moves >= 6 && solution.moves <= 9);
        assert.equal(solution.actions, map.limits.actions);
        assert.ok(solution.a + solution.b >= 2 && solution.a + solution.b <= 3);
      }
    }
  }
});

test("资源图包含简短按键与双倍奖励提示，不展示解法", () => {
  const html = buildEncounterHtml(fixture);
  assert.ok(html.includes('行动 = <span class="count">9</span>'));
  for (const [direction, key] of [["上", "s"], ["下", "x"], ["左", "z"], ["右", "y"]]) {
    assert.ok(html.includes(`${direction} <kbd>${key}</kbd>`));
  }
  assert.ok(html.includes("<kbd>A</kbd>＋方向：水草（2行动）"));
  assert.ok(html.includes("<kbd>B</kbd>＋方向：漂木（3行动）"));
  assert.ok(html.includes("30秒内通过，双倍奖励"));
  for (const unwanted of ["倒计时", "测试上限", "一条消息", "浅湾脱困", "行动 ≤", " 步", answer]) assert.equal(html.includes(unwanted), false);
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
