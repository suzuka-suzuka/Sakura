/**
 * KP 回合引擎
 *
 * 一个回合只调一次 AI。做法是：
 * 1. 本地为每个行动玩家预掷一枚 d100「命运骰」
 * 2. 把这枚骰点对该角色每项技能的判定结果预先算好，一并发给 KP
 * 3. KP 挑一项贴切的技能读结果并叙事，不做任何算术，也无法篡改成败
 * 4. KP 回来后，本地按存下的骰点重新判定一次作为权威结果对外公示
 *
 * 剧情记忆走「滚动摘要 + 最近几回合」，长度固定，不随回合数增长。
 */

import { getAI } from "../AIUtils/getAI.js";
import { judgeCheck, rollDie } from "./dice.js";
import { KP_SYSTEM, buildFinalePrompt, buildTurnPrompt, describePacing } from "./prompts.js";
import {
  collectFlagVocabulary,
  evaluateEndings,
  extractJson,
  getSkillValue,
  normalizeStringArray,
  pendingEndingFlags,
  safeInt,
  safeString,
  settleGoals,
} from "./schema.js";

/** 摘要最多保留多少条，超了就丢最早的 */
const MAX_SUMMARY_LINES = 14;
/** 提示词里带几个回合的原文 */
const RECENT_LOG_SIZE = 3;
/** 预判定表里放多少项技能 */
const CHECK_TABLE_SIZE = 12;
/** 力竭状态下技能值打几折 */
const EXHAUSTED_SKILL_RATIO = 0.5;

export const EXHAUSTED_STATUS = "力竭";

export function isExhausted(character) {
  return Array.isArray(character?.status) && character.status.includes(EXHAUSTED_STATUS);
}

/**
 * 力竭状态下的有效技能值
 * 回合结算和手动 #检定 共用这一套折算，免得两边算出不同的数
 */
export function effectiveSkillValue(value, exhausted) {
  const base = Number(value) || 0;
  return exhausted ? Math.max(1, Math.floor(base * EXHAUSTED_SKILL_RATIO)) : base;
}

/**
 * 为一个角色构建本回合的「骰点 × 技能」预判定表
 * KP 只需在这张表里挑一行，不需要自己算成败
 * 力竭的角色技能值先打折再判定，惩罚落在本地，KP 无从干预
 */
function buildCheckTable(character, roll, exhausted) {
  const adjust = (value) => effectiveSkillValue(value, exhausted);

  const entries = Object.entries(character.skills || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, CHECK_TABLE_SIZE);

  const table = {};
  for (const [skill, value] of entries) {
    table[skill] = judgeCheck(roll, adjust(value));
  }
  // 属性直骰也可能被点名，补几项常用的
  for (const attr of ["力量", "敏捷", "意志", "智力"]) {
    const value = character.attrs?.[attr];
    if (Number.isFinite(value)) table[attr] = judgeCheck(roll, adjust(value));
  }
  return table;
}

/** 把玩家宣言整理成 KP 能读的行动列表，顺便掷好骰 */
export function prepareActions(session, characters) {
  const actions = [];

  for (const [userId, text] of Object.entries(session.pendingActions || {})) {
    const character = characters.find((item) => item.userId === String(userId));
    if (!character || !character.alive) continue;

    const roll = rollDie(100);
    const exhausted = isExhausted(character);
    actions.push({
      userId: String(userId),
      name: character.name,
      text: safeString(text, 300),
      roll,
      exhausted,
      checkTable: buildCheckTable(character, roll, exhausted),
    });
  }

  return actions;
}

/** 归一化 KP 返回的结构 */
function normalizeTurnResult(raw, vocabulary = []) {
  const source = raw && typeof raw === "object" ? raw : {};

  const numberMap = (value, { min = -99, max = 99 } = {}) => {
    const result = {};
    if (!value || typeof value !== "object") return result;
    for (const [qq, delta] of Object.entries(value)) {
      const num = safeInt(delta, { min, max, fallback: 0 });
      if (num !== 0) result[String(qq)] = num;
    }
    return result;
  };

  const items = {};
  if (source.items && typeof source.items === "object") {
    for (const [qq, change] of Object.entries(source.items)) {
      items[String(qq)] = {
        add: normalizeStringArray(change?.add, { limit: 4, maxLength: 30 }),
        remove: normalizeStringArray(change?.remove, { limit: 4, maxLength: 30 }),
      };
    }
  }

  const status = {};
  if (source.status && typeof source.status === "object") {
    for (const [qq, list] of Object.entries(source.status)) {
      status[String(qq)] = normalizeStringArray(list, { limit: 4, maxLength: 20 });
    }
  }

  // 标记只认词表内的名字。KP 自己编的一律丢弃，否则结局条件永远对不上，
  // 本地判定也就失去意义了。
  const allowed = new Set(vocabulary);
  const rawFlags = Array.isArray(source.flags)
    ? source.flags
    : source.flags && typeof source.flags === "object"
      ? Object.entries(source.flags).filter(([, value]) => value === true || value === "true").map(([key]) => key)
      : [];

  const flags = {};
  const rejectedFlags = [];
  for (const item of rawFlags.slice(0, 12)) {
    const name = safeString(item, 30);
    if (!name) continue;
    if (allowed.has(name)) flags[name] = true;
    else rejectedFlags.push(name);
  }

  const options = (Array.isArray(source.options) ? source.options : [])
    .slice(0, 4)
    .map((item) => ({
      text: safeString(typeof item === "string" ? item : item?.text, 60),
      hint: safeString(item?.hint, 24),
    }))
    .filter((item) => item.text);

  return {
    narration: safeString(source.narration, 2000),
    checks: (Array.isArray(source.checks) ? source.checks : []).slice(0, 10).map((check) => ({
      qq: String(check?.qq ?? "").trim(),
      skill: safeString(check?.skill, 20),
      reason: safeString(check?.reason, 60),
    })),
    scene: safeString(source.scene, 40),
    hp: numberMap(source.hp),
    san: numberMap(source.san),
    items,
    status,
    flags,
    rejectedFlags,
    options,
    summary: safeString(source.summary, 200),
  };
}

/**
 * 把 KP 声明的检定用本地存下的骰点重新判定一次
 * 这一步是权威结果：AI 说什么不算数，骰子说了算
 */
function resolveChecks(turnResult, actions, characters) {
  const rollByUser = new Map(actions.map((action) => [action.userId, action.roll]));

  return turnResult.checks
    .map((check) => {
      const character = characters.find((item) => item.userId === check.qq);
      const roll = rollByUser.get(check.qq);
      if (!character || roll == null || !check.skill) return null;

      const skillValue = getSkillValue(character, check.skill);
      return {
        userId: check.qq,
        name: character.name,
        skill: check.skill,
        reason: check.reason,
        value: skillValue,
        roll,
        level: judgeCheck(roll, skillValue),
      };
    })
    .filter(Boolean);
}

/** 把 KP 的状态变更落到角色卡上，返回本回合的伤亡播报 */
function applyUpdates(turnResult, characters) {
  const events = [];

  for (const character of characters) {
    if (!character.alive) continue;
    const qq = character.userId;

    const hpDelta = turnResult.hp[qq] || 0;
    if (hpDelta) {
      character.hp = Math.max(0, Math.min(character.maxHp, character.hp + hpDelta));
      events.push(`${character.name} HP ${hpDelta > 0 ? "+" : ""}${hpDelta} → ${character.hp}/${character.maxHp}`);
    }

    const sanDelta = turnResult.san[qq] || 0;
    if (sanDelta) {
      character.san = Math.max(0, Math.min(character.maxSan, character.san + sanDelta));
      events.push(`${character.name} SAN ${sanDelta > 0 ? "+" : ""}${sanDelta} → ${character.san}/${character.maxSan}`);
    }

    const itemChange = turnResult.items[qq];
    if (itemChange) {
      for (const item of itemChange.add) {
        if (!character.inventory.includes(item) && character.inventory.length < 20) {
          character.inventory.push(item);
          events.push(`${character.name} 获得【${item}】`);
        }
      }
      for (const item of itemChange.remove) {
        const index = character.inventory.indexOf(item);
        if (index !== -1) {
          character.inventory.splice(index, 1);
          events.push(`${character.name} 失去【${item}】`);
        }
      }
    }

    const newStatus = turnResult.status[qq];
    if (newStatus?.length) {
      for (const item of newStatus) {
        if (!character.status.includes(item) && character.status.length < 8) {
          character.status.push(item);
          events.push(`${character.name} 陷入【${item}】`);
        }
      }
    }

    if (character.san === 0 && !character.status.includes("永久疯狂")) {
      character.status.push("永久疯狂");
      character.alive = false;
      events.push(`💀 ${character.name} 理智归零，永久疯狂，退出调查`);
    }

    if (character.hp === 0) {
      character.alive = false;
      events.push(`💀 ${character.name} 倒下了`);
    }
  }

  return events;
}

/**
 * 推进一个回合
 * @returns {Promise<{ narration, checks, events, options, ending, newFlags, summary }>}
 */
export async function runTurn({ e, route, session, characters, actions, maxRounds = 0 }) {
  const vocabulary = collectFlagVocabulary(session.module, characters);
  const pacing = describePacing(session.round, maxRounds);
  const sessionView = {
    round: session.round,
    currentScene: session.currentScene,
    flags: session.flags,
    summary: (session.summaryLines || []).join(" → "),
    recentLog: session.recentLog || [],
  };

  const prompt = buildTurnPrompt({
    module: session.module,
    characters,
    session: sessionView,
    actions,
    flagVocabulary: vocabulary,
    pendingFlags: pendingEndingFlags(session.module, session.flags),
    pacing,
  });

  const result = await getAI(route, e, [{ text: prompt }], KP_SYSTEM, false, false, []);
  if (typeof result === "string") {
    throw new Error(result);
  }
  const parsed = extractJson(result?.text);
  if (!parsed) {
    throw new Error("KP 返回的内容无法解析，本回合未推进");
  }

  const turnResult = normalizeTurnResult(parsed, vocabulary);
  if (!turnResult.narration) {
    throw new Error("KP 没有产出叙事，本回合未推进");
  }
  if (turnResult.rejectedFlags.length) {
    logger.warn(`[跑团] KP 试图设置词表外的标记，已忽略：${turnResult.rejectedFlags.join("、")}`);
  }

  const checks = resolveChecks(turnResult, actions, characters);
  const events = applyUpdates(turnResult, characters);

  // 场景推进：只接受模组里真实存在的场景 id
  if (turnResult.scene && session.module.scenes.some((scene) => scene.id === turnResult.scene)) {
    session.currentScene = turnResult.scene;
  }

  const newFlags = Object.keys(turnResult.flags).filter((name) => session.flags?.[name] !== true);
  session.flags = { ...session.flags, ...turnResult.flags };
  session.round += 1;
  session.pendingActions = {};
  session.currentOptions = turnResult.options;

  if (turnResult.summary) {
    session.summaryLines = [...(session.summaryLines || []), turnResult.summary].slice(-MAX_SUMMARY_LINES);
  }
  session.recentLog = [
    ...(session.recentLog || []),
    { round: session.round, text: turnResult.narration.slice(0, 220) },
  ].slice(-RECENT_LOG_SIZE);

  // 收场与否由本地对标记求值决定，KP 无权宣布
  const ending = evaluateEndings(session.module, session.flags);

  return {
    narration: turnResult.narration,
    checks,
    events,
    options: turnResult.options,
    newFlags,
    ending,
    // 播报用的是打完这一回合之后的节奏，所以重新算一次
    pacing: describePacing(session.round, maxRounds),
    summary: turnResult.summary,
  };
}

/**
 * 达成结局时写终章
 * 多花一次调用，换一段贴合本局实际经历的收尾；失败就回落到模组预写的结局文本
 */
export async function writeFinale({ e, route, session, characters, ending }) {
  const goalResults = settleGoals(characters, session.flags);

  try {
    const prompt = buildFinalePrompt({
      module: session.module,
      ending,
      session,
      characters,
      goalResults,
    });
    const result = await getAI(route, e, [{ text: prompt }], null, false, false, []);
    const text = typeof result === "string" ? "" : safeString(result?.text, 2000);
    if (text) return { text, goalResults };
  } catch (error) {
    logger.warn(`[跑团] 终章生成失败，回落到预写结局：${error.message}`);
  }

  return { text: ending.description, goalResults };
}
