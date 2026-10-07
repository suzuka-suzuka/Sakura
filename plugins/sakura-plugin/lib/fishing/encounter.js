// 遭遇规则与关卡工具。重量判定通过后、困难度判定前抽取；护符与首领不触发。
export const ENCOUNTER_TIME_LIMIT_MS = 60_000;
export const ENCOUNTER_FULL_REWARD_MS = 30_000;
export const ENCOUNTER_RULE_VERSION = 3;
export const ENCOUNTER_DEFAULT_CHANCE = 0.1;
export const ENCOUNTER_ABILITY_COSTS = Object.freeze({ A: 1, B: 2 });

export function rollFishingEncounter(state, chance = ENCOUNTER_DEFAULT_CHANCE, random = Math.random) {
  if (!state || state.encounterChecked || state.hasLucky || state.fish?.isTorpedo || state.fish?.is_boss === true) return false;
  state.encounterChecked = true;
  const probability = Number.isFinite(chance) ? Math.max(0, Math.min(1, chance)) : ENCOUNTER_DEFAULT_CHANCE;
  return probability > 0 && (probability === 1 || random() < probability);
}

export function applyEncounterReward(value, multiplier = 1) {
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(multiplier) || multiplier < 1 || multiplier > 2) throw new TypeError("遭遇奖励数值无效");
  return Math.round(value * multiplier);
}

const DIRECTIONS = Object.freeze({
  上: [0, -1], 下: [0, 1], 左: [-1, 0], 右: [1, 0],
});
const ALIASES = Object.freeze({
  z: "左", y: "右", s: "上", x: "下",
});
const TILES = new Set(["#", ".", "S", "G", "A", "B"]);

export function assertEncounterMap(map) {
  if (!map || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(map.id || "")) throw new TypeError("遭遇关卡编号无效");
  const rows = map.rows;
  if (!Array.isArray(rows) || rows.length < 5 || rows.length > 10) throw new TypeError("遭遇地图行数无效");
  const width = rows[0]?.length;
  if (!Number.isInteger(width) || width < 5 || width > 10) throw new TypeError("遭遇地图列数无效");
  const starts = [], goals = [];
  rows.forEach((row, y) => {
    if (typeof row !== "string" || row.length !== width) throw new TypeError("遭遇地图各行宽度必须相同");
    [...row].forEach((tile, x) => {
      if (!TILES.has(tile)) throw new TypeError("遭遇地图包含未知地形");
      if (tile === "S") starts.push([x, y]);
      if (tile === "G") goals.push([x, y]);
    });
  });
  if (starts.length !== 1 || goals.length !== 1 || starts[0][1] !== 0 || goals[0][1] !== rows.length - 1) {
    throw new TypeError("鱼必须位于地图上方，唯一收鱼点必须位于地图下方");
  }
  const { actions } = map.limits || {};
  if (!Number.isInteger(actions) || actions < 1 || actions > 96) throw new TypeError("指定行动数必须在 1 至 96 之间");
  return { width, height: rows.length, start: starts[0], goal: goals[0] };
}

// 只将整条由操作字符组成的消息视为答案，不从聊天内容中提取方向。
// 字符合法与动作语法分开判断：例如 abx 会进入判题并消耗唯一作答机会。
export function isEncounterAnswerMessage(input) {
  return typeof input === "string" && /^[上下左右zysxab]+$/iu.test(input.trim());
}

export function parseEncounterInput(input) {
  if (!isEncounterAnswerMessage(input)) return null;
  const normalized = input.trim().toLowerCase()
    .replace(/[zysx]/gu, value => ALIASES[value]);
  if (!normalized || normalized.length > 96) return null;
  const tokens = normalized.match(/[ab]?[上下左右]/gu) || [];
  if (tokens.join("") !== normalized) return null;
  return tokens.map(token => ({ direction: token.at(-1), ability: token.slice(0, -1).toUpperCase() }));
}

export function validateEncounterInput(map, input) {
  const { width, start } = assertEncounterMap(map);
  const tokens = parseEncounterInput(input);
  if (!tokens) return { success: false, reason: "操作格式错误" };
  let [x, y] = start;
  let usedA = 0, usedB = 0, actions = 0;
  const visited = new Set([y * width + x]);
  for (let index = 0; index < tokens.length; index++) {
    const { direction, ability } = tokens[index];
    const [dx, dy] = DIRECTIONS[direction];
    const tile = map.rows[y + dy]?.[x + dx];
    if (!tile || tile === "#") return { success: false, reason: "进入岸壁或离开地图", step: index + 1 };
    const required = tile === "A" || tile === "B" ? tile : "";
    if (ability !== required) return { success: false, reason: "地形与动作不匹配", step: index + 1 };
    x += dx; y += dy;
    const cell = y * width + x;
    if (visited.has(cell)) return { success: false, reason: "重复经过格子", step: index + 1 };
    visited.add(cell);
    usedA += ability === "A" ? 1 : 0;
    usedB += ability === "B" ? 1 : 0;
    actions += 1 + (ENCOUNTER_ABILITY_COSTS[ability] || 0);
    if (actions > map.limits.actions) return { success: false, reason: "超过指定行动数", step: index + 1, actions, moves: index + 1, usedA, usedB };
    if (tile === "G" && index !== tokens.length - 1) return { success: false, reason: "到达收鱼点后仍有操作", step: index + 1 };
  }
  const reachedGoal = map.rows[y][x] === "G";
  const success = reachedGoal && actions === map.limits.actions;
  const reason = !reachedGoal ? "未到收鱼点" : success ? "正确" : "少于指定行动数";
  return { success, reason, actions, moves: tokens.length, usedA, usedB };
}

export function getEncounterRewardMultiplier(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= ENCOUNTER_TIME_LIMIT_MS) return 0;
  if (elapsedMs <= ENCOUNTER_FULL_REWARD_MS) return 2;
  return 2 - (elapsedMs - ENCOUNTER_FULL_REWARD_MS) / (ENCOUNTER_TIME_LIMIT_MS - ENCOUNTER_FULL_REWARD_MS);
}

export function createEncounterAttempt(map, startedAt) {
  assertEncounterMap(map);
  if (!Number.isFinite(startedAt)) throw new TypeError("遭遇开始时间无效");
  return { map, startedAt, submitted: false };
}

export function submitEncounterAttempt(attempt, input, receivedAt) {
  if (attempt.submitted) return { accepted: false, success: false, reason: "本次已经提交" };
  if (!isEncounterAnswerMessage(input)) return { accepted: false, success: false, reason: "非操作消息，已忽略" };
  // 首次操作串先锁定，动作语法错误、错误路线和超时都不能获得第二次机会。
  attempt.submitted = true;
  const elapsedMs = receivedAt - attempt.startedAt;
  const multiplier = getEncounterRewardMultiplier(elapsedMs);
  if (!multiplier) return { accepted: true, success: false, reason: "遭遇超时或时间无效", elapsedMs, multiplier: 0 };
  const result = validateEncounterInput(attempt.map, input);
  return { ...result, accepted: true, elapsedMs, multiplier: result.success ? multiplier : 0 };
}

// 精确行动数与不重复格子需要保留完整路径，不能按位置和成本合并状态。
export function solveEncounter(map) {
  const analysis = analyzeEncounterChoices(map);
  if (analysis.truncated) throw new Error("关卡路线搜索超出预算，不能确定完整解集");
  return [...analysis.validRoutes].sort((left, right) => left.moves - right.moves || left.sequence.localeCompare(right.sequence));
}

function routeDifference(left, right) {
  const leftCells = new Set(left.cells), rightCells = new Set(right.cells);
  return left.cells.filter(cell => !rightCells.has(cell)).length + right.cells.filter(cell => !leftCells.has(cell)).length;
}

function summarizeChoices(routes, limits, truncated = false) {
  const validRoutes = routes.filter(route => route.actions === limits.actions);
  const underRoutes = routes.filter(route => route.actions < limits.actions);
  const overRoutes = routes.filter(route => route.actions > limits.actions);
  const tradeoffPairs = [];
  for (const shorter of routes) {
    for (const longer of routes) {
      // 至少有一组短路障碍多、长路障碍少的完整路线，且走法明显不同。
      if (shorter.moves < longer.moves && shorter.a + shorter.b * 2 > longer.a + longer.b * 2 && routeDifference(shorter, longer) >= 4) tradeoffPairs.push({ shorter, longer });
    }
  }
  const hasDifferentUnderRoute = validRoutes.some(valid => underRoutes.some(under => routeDifference(valid, under) >= 4));
  const hasDifferentOverRoute = validRoutes.some(valid => overRoutes.some(over => routeDifference(valid, over) >= 4));
  return {
    routes, validRoutes, underRoutes, overRoutes, tradeoffPairs, truncated,
    actionCounts: [...new Set(routes.map(route => route.actions))].sort((left, right) => left - right),
    hasMeaningfulChoice: !truncated && routes.length >= 3 && tradeoffPairs.length > 0 && hasDifferentUnderRoute && hasDifferentOverRoute,
  };
}

// 枚举不重复经过格子的到岸路径；往返和绕圈不会伪装成额外路线。
// 统计移动与 A/B 的总行动数，并检查短路与少障碍路线之间的取舍。
export function analyzeEncounterChoices(map, { maxPaths = 256, maxSearchNodes = 50_000 } = {}) {
  const { width, height, start } = assertEncounterMap(map);
  const seen = new Uint8Array(width * height);
  const startCell = start[1] * width + start[0];
  const routes = [];
  let searched = 0, truncated = false;
  seen[startCell] = 1;
  function visit(x, y, a, b, moves, sequence, cells) {
    if (truncated) return;
    if (++searched > maxSearchNodes) { truncated = true; return; }
    if (map.rows[y][x] === "G") {
      if (routes.length >= maxPaths) { truncated = true; return; }
      routes.push({ a, b, moves, actions: moves + a + b * 2, sequence, cells: [...cells] });
      return;
    }
    for (const [direction, [dx, dy]] of Object.entries(DIRECTIONS)) {
      const nx = x + dx, ny = y + dy, tile = map.rows[ny]?.[nx];
      if (!tile || tile === "#") continue;
      const cell = ny * width + nx;
      if (seen[cell]) continue;
      seen[cell] = 1;
      cells.push(cell);
      const ability = tile === "A" || tile === "B" ? tile : "";
      visit(nx, ny, a + (tile === "A" ? 1 : 0), b + (tile === "B" ? 1 : 0), moves + 1, sequence + ability + direction, cells);
      cells.pop();
      seen[cell] = 0;
      if (truncated) return;
    }
  }
  visit(start[0], start[1], 0, 0, 0, "", [startCell]);
  return summarizeChoices(routes, map.limits, truncated);
}

export function encounterFingerprint(map) {
  assertEncounterMap(map);
  // 按水路连接去重，单纯换障碍、换次数或做左右镜像仍视为同一布局。
  const rows = map.rows.map(row => row.replace(/[AB]/gu, "."));
  const original = rows.join("/");
  const mirrored = rows.map(row => [...row].reverse().join("")).join("/");
  return [original, mirrored].sort()[0];
}

export function createEncounterRandom(seed) {
  let state = 2166136261;
  for (const char of String(seed)) { state ^= char.codePointAt(0); state = Math.imul(state, 16777619); }
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

export function generateEncounterMaps({ count = 5, seed = "sakura", excluded = [] } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new RangeError("生成数量必须在 1 至 100 之间");
  const random = createEncounterRandom(seed);
  const fingerprints = new Set(excluded.map(encounterFingerprint));
  const limitsSeen = new Set();
  const maps = [];
  for (let attempt = 0; attempt < count * 500 && maps.length < count; attempt++) {
    const cells = Array.from({ length: 7 }, () => Array(8).fill("#"));
    const visited = new Set();
    function carve(x, y) {
      cells[y][x] = ".";
      visited.add(`${x},${y}`);
      for (const [dx, dy] of shuffle([[2, 0], [-2, 0], [0, 2], [0, -2]], random)) {
        const nx = x + dx, ny = y + dy;
        if (nx < 1 || nx > 5 || ny < 1 || ny > 5 || visited.has(`${nx},${ny}`)) continue;
        cells[y + dy / 2][x + dx / 2] = ".";
        carve(nx, ny);
      }
    }
    carve(1 + 2 * Math.floor(random() * 3), 1);
    // 给迷宫补足连接，再用真实到岸路径分析排除单通道与假分支。
    const connectors = [[2, 1], [4, 1], [1, 2], [3, 2], [5, 2], [2, 3], [4, 3], [1, 4], [3, 4], [5, 4], [2, 5], [4, 5]];
    const closed = connectors.filter(([x, y]) => cells[y][x] === "#");
    for (const [x, y] of shuffle(closed, random).slice(0, 3 + Math.floor(random() * 2))) cells[y][x] = ".";
    const startX = 1 + 2 * Math.floor(random() * 3), goalX = 1 + 2 * Math.floor(random() * 3);
    cells[0][startX] = "S"; cells[6][goalX] = "G";
    const map = { id: `random-${String(maps.length + 1).padStart(2, "0")}`, name: "随机浅湾", rows: cells.map(row => row.join("")), limits: { actions: 16 } };
    const waterRoutes = analyzeEncounterChoices(map);
    if (waterRoutes.truncated) continue;
    const witness = [...waterRoutes.routes].sort((left, right) => left.moves - right.moves)[0];
    if (!witness || witness.moves < 8 || witness.moves > 14) continue;
    const path = [];
    let x = startX, y = 0;
    for (const token of parseEncounterInput(witness.sequence)) {
      const [dx, dy] = DIRECTIONS[token.direction]; x += dx; y += dy;
      if (cells[y][x] === ".") path.push([x, y]);
    }
    const obstacleCells = shuffle(path, random).slice(0, 2 + Math.floor(random() * 3));
    obstacleCells.forEach(([px, py], index) => {
      const type = index === 0 ? "A" : index === 1 ? "B" : random() < 0.5 ? "A" : "B";
      cells[py][px] = type;
    });
    const pathSet = new Set(path.map(([px, py]) => `${px},${py}`));
    const branches = [];
    cells.forEach((row, py) => row.forEach((type, px) => { if (type === "." && !pathSet.has(`${px},${py}`)) branches.push([px, py]); }));
    for (const [px, py] of shuffle(branches, random).slice(0, 3 + Math.floor(random() * 3))) cells[py][px] = random() < 0.5 ? "A" : "B";
    map.rows = cells.map(row => row.join(""));
    const analysis = analyzeEncounterChoices(map);
    if (analysis.truncated || analysis.routes.length < 3 || !analysis.tradeoffPairs.length) continue;
    // 指定中间的行动数，地图必须同时存在行动不足、恰好满足和超出要求的路线。
    const candidates = new Map();
    for (const actions of analysis.actionCounts) {
      const limits = { actions };
      const choices = summarizeChoices(analysis.routes, limits);
      if (!choices.hasMeaningfulChoice || choices.validRoutes.some(route => route.moves < 8 || route.moves > 16 || route.a + route.b < 1)) continue;
      candidates.set(actions, limits);
    }
    if (!candidates.size) continue;
    const validLimits = [...candidates.values()];
    map.limits = validLimits[Math.floor(random() * validLimits.length)];
    const fingerprint = encounterFingerprint(map);
    if (fingerprints.has(fingerprint)) continue;
    const limitsKey = map.limits.actions;
    // 运行时每次生成一张，第一张行动数也不能与上一场相同。
    if (!maps.length && limitsKey === excluded.at(-1)?.limits.actions) continue;
    // 五张以内的行动数各不相同；大批次至少避免连续重复行动数。
    if (count <= 5 ? limitsSeen.has(limitsKey) : maps.length && limitsKey === maps.at(-1).limits.actions) continue;
    fingerprints.add(fingerprint);
    limitsSeen.add(limitsKey);
    maps.push(map);
  }
  if (maps.length !== count) throw new Error("未能在生成预算内找到足够的有效地图，请更换种子");
  return maps;
}
