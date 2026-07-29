/**
 * 骰子与 COC7 检定规则
 *
 * 所有随机数都在本地生成，不交给 AI 决定成败。
 * KP 只负责「要不要检定、检定什么技能、结果怎么叙事」，
 * 骰点本身对玩家公开可验证。
 */

const DICE_EXPRESSION = /^(\d*)d(\d+)([+-]\d+)?$/i;

export const MAX_DICE_COUNT = 20;
export const MAX_DICE_FACES = 1000;

/** 单次掷骰 */
export function rollDie(faces) {
  return Math.floor(Math.random() * faces) + 1;
}

/**
 * 解析并执行骰子表达式，如 1d100 / 3d6+2 / d20
 * @returns {{ ok: boolean, total?: number, rolls?: number[], modifier?: number, expression?: string, error?: string }}
 */
export function rollExpression(raw) {
  const text = String(raw || "").trim().replace(/\s+/g, "");
  const match = text.match(DICE_EXPRESSION);
  if (!match) {
    return { ok: false, error: "骰子格式不对，试试 1d100、3d6+2 这种写法。" };
  }

  const count = match[1] === "" ? 1 : Number(match[1]);
  const faces = Number(match[2]);
  const modifier = match[3] ? Number(match[3]) : 0;

  if (count < 1 || count > MAX_DICE_COUNT) {
    return { ok: false, error: `骰子个数要在 1~${MAX_DICE_COUNT} 之间。` };
  }
  if (faces < 2 || faces > MAX_DICE_FACES) {
    return { ok: false, error: `骰子面数要在 2~${MAX_DICE_FACES} 之间。` };
  }

  const rolls = Array.from({ length: count }, () => rollDie(faces));
  const total = rolls.reduce((sum, value) => sum + value, 0) + modifier;

  return {
    ok: true,
    total,
    rolls,
    modifier,
    expression: `${count}d${faces}${modifier ? (modifier > 0 ? `+${modifier}` : modifier) : ""}`,
  };
}

/** 检定成功等级，从高到低 */
export const CHECK_LEVELS = {
  CRITICAL: "大成功",
  EXTREME: "极难成功",
  HARD: "困难成功",
  REGULAR: "普通成功",
  FAIL: "失败",
  FUMBLE: "大失败",
};

/** 成功等级的排序权重，数字越大越好，供 KP 提示词和本地逻辑判断严重程度 */
export const CHECK_LEVEL_RANK = {
  [CHECK_LEVELS.CRITICAL]: 5,
  [CHECK_LEVELS.EXTREME]: 4,
  [CHECK_LEVELS.HARD]: 3,
  [CHECK_LEVELS.REGULAR]: 2,
  [CHECK_LEVELS.FAIL]: 1,
  [CHECK_LEVELS.FUMBLE]: 0,
};

/**
 * COC7 成功等级判定
 * @param {number} roll 1~100 的骰点
 * @param {number} skill 技能/属性值
 */
export function judgeCheck(roll, skill) {
  const value = Math.max(0, Math.min(100, Number(skill) || 0));

  if (roll === 1) return CHECK_LEVELS.CRITICAL;
  if (value < 50 ? roll >= 96 : roll === 100) return CHECK_LEVELS.FUMBLE;
  if (roll <= Math.floor(value / 5)) return CHECK_LEVELS.EXTREME;
  if (roll <= Math.floor(value / 2)) return CHECK_LEVELS.HARD;
  if (roll <= value) return CHECK_LEVELS.REGULAR;
  return CHECK_LEVELS.FAIL;
}

export function isSuccess(level) {
  return CHECK_LEVEL_RANK[level] >= CHECK_LEVEL_RANK[CHECK_LEVELS.REGULAR];
}

/**
 * 完整的技能检定
 * @param {number} skill 技能值
 * @param {number} [roll] 指定骰点（用于复用本回合已公示的命运骰）
 */
export function skillCheck(skill, roll = null) {
  const dice = roll == null ? rollDie(100) : Math.max(1, Math.min(100, Number(roll)));
  const level = judgeCheck(dice, skill);
  return {
    roll: dice,
    skill: Number(skill) || 0,
    level,
    success: isSuccess(level),
  };
}

/** 生成一组 COC7 属性 */
export function rollAttributes() {
  const d6 = () => rollDie(6);
  const threeD6x5 = () => (d6() + d6() + d6()) * 5;
  const twoD6plus6x5 = () => (d6() + d6() + 6) * 5;

  return {
    力量: threeD6x5(),
    体质: threeD6x5(),
    敏捷: threeD6x5(),
    外貌: threeD6x5(),
    意志: threeD6x5(),
    智力: twoD6plus6x5(),
    教育: twoD6plus6x5(),
    体型: twoD6plus6x5(),
  };
}

/** 由属性派生 HP / MP / SAN / 移动力 */
export function deriveStats(attrs = {}) {
  const con = Number(attrs.体质) || 50;
  const siz = Number(attrs.体型) || 50;
  const pow = Number(attrs.意志) || 50;
  const str = Number(attrs.力量) || 50;
  const dex = Number(attrs.敏捷) || 50;

  let move = 8;
  if (str < siz && dex < siz) move = 7;
  else if (str > siz && dex > siz) move = 9;

  return {
    maxHp: Math.floor((con + siz) / 10),
    maxMp: Math.floor(pow / 5),
    maxSan: pow,
    move,
    dodge: Math.floor(dex / 2),
  };
}

/** 把检定结果排版成一行，用于群内公示 */
export function formatCheck({ name, skill, skillName, roll, level, note }) {
  const who = name ? `${name} ` : "";
  const what = skillName ? `${skillName}` : "检定";
  const tail = note ? `（${note}）` : "";
  return `🎲 ${who}${what} ${roll}/${skill}${tail} → ${level}`;
}
