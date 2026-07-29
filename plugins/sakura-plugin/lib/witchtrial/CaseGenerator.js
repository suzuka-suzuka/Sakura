/**
 * 牢狱、少女与案件的生成
 *
 * 开局调一次 AI 出牢狱和全体少女；之后每章调一次 AI 出案件档案。
 *
 * 关键：**死者和凶手由本地掷定，不交给 AI**。
 * 因为「凶手是玩家」的概率必须与 NPC 数量脱钩——按人头均分的话，2 玩家配
 * 8 NPC 就变成 80% 是 NPC 干的，玩家会默认「大概率不是我们」，游戏直接
 * 退化成合作推理。掷好之后再让 AI 围绕这个既定事实编手法和证据。
 */

import { getAI } from "../AIUtils/getAI.js";
import { planWitchActions } from "./logic.js";
export { pickVictimAndCulprit } from "./logic.js";
import {
  CASE_SYSTEM,
  SETUP_SYSTEM,
  buildCasePrompt,
  buildSetupPrompt,
} from "./prompts.js";
import {
  assignPrisonerCodes,
  extractJson,
  normalizeCase,
  normalizeGirl,
  normalizePrison,
  toNpcId,
  toPlayerId,
  validateCase,
} from "./schema.js";

const MAX_ATTEMPTS = 3;

async function askAI({ route, e, system, prompt }) {
  const result = await getAI(route, e, [{ text: prompt }], system, false, false, []);

  // getAI 出错时返回字符串，成功时返回对象
  if (typeof result === "string") {
    throw new Error(result);
  }
  const text = result?.text?.trim();
  if (!text) {
    throw new Error("AI 没有返回内容");
  }
  return text;
}

/**
 * 开局：生成牢狱与全体少女
 * @returns {Promise<{prison: object, girls: Record<string, object>}>}
 */
export async function generateSetup({ e, route, players, npcCount, theme, onProgress }) {
  let parsed = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await onProgress?.(`牢狱第 ${attempt - 1} 稿没成，正在重写…`);

    let text;
    try {
      text = await askAI({
        route,
        e,
        system: SETUP_SYSTEM,
        prompt: buildSetupPrompt({ players, npcCount, theme }),
      });
    } catch (error) {
      logger.warn(`[魔女审判] 开局生成第 ${attempt} 次调用失败：${error.message}`);
      if (attempt === MAX_ATTEMPTS) throw error;
      continue;
    }

    parsed = extractJson(text);
    if (
      parsed?.prison &&
      Array.isArray(parsed.playerGirls) &&
      parsed.playerGirls.length >= players.length &&
      Array.isArray(parsed.npcGirls) &&
      parsed.npcGirls.length >= npcCount &&
      Array.isArray(parsed.prison.locations) &&
      parsed.prison.locations.length >= 3
    ) {
      break;
    }

    logger.warn(`[魔女审判] 开局第 ${attempt} 次输出无法解析`);
    parsed = null;
  }

  if (!parsed) throw new Error(`牢狱连续 ${MAX_ATTEMPTS} 次生成失败`);

  const prison = normalizePrison(parsed.prison);
  if (prison.locations.length < 3) {
    throw new Error("牢狱地点少于 3 个，无法开局");
  }

  const girls = {};

  // 玩家少女：AI 可能把 id 写错或顺序打乱，先按 id 精确匹配，匹配不到的按顺序兜底
  const rawPlayers = Array.isArray(parsed.playerGirls) ? parsed.playerGirls : [];
  const byId = new Map();
  for (const item of rawPlayers) {
    const key = String(item?.id ?? "").trim();
    if (key && !byId.has(key)) byId.set(key, item);
  }
  const leftovers = rawPlayers.filter((item) => {
    const key = String(item?.id ?? "").trim();
    return !key || !players.some((player) => toPlayerId(player.userId) === key);
  });

  players.forEach((player, index) => {
    const id = toPlayerId(player.userId);
    const matched = byId.get(id) || leftovers.shift() || rawPlayers[index];
    if (!matched) logger.warn(`[魔女审判] 玩家 ${player.userId} 没分到少女设定，使用本地兜底`);
    girls[id] = normalizeGirl(matched, {
      id,
      kind: "player",
      userId: player.userId,
      nickname: player.nickname,
    });
  });

  // NPC 少女
  const rawNpcs = Array.isArray(parsed.npcGirls) ? parsed.npcGirls : [];
  rawNpcs.slice(0, npcCount).forEach((item, index) => {
    const raw = String(item?.id ?? "").trim();
    const baseId = raw.startsWith("n:") ? raw : toNpcId(`girl_${index + 1}`);
    let id = baseId;
    let suffix = 2;
    while (girls[id]) id = `${baseId}_${suffix++}`;
    girls[id] = normalizeGirl(item, { id, kind: "npc" });
  });

  const npcTotal = Object.values(girls).filter((girl) => girl.kind === "npc").length;
  if (npcTotal < npcCount) {
    throw new Error(`NPC 少女只生成了 ${npcTotal} 位，需要 ${npcCount} 位`);
  }

  assignPrisonerCodes(girls);

  logger.info(
    `[魔女审判] 牢狱《${prison.name}》就位，地点 ${prison.locations.length} 个，少女 ${Object.keys(girls).length} 位`
  );
  return { prison, girls };
}

/**
 * 生成一章的案件档案，带一致性校验重试
 *
 * 我们不需要 AI 写出一个好推理，只需要它随机吐结构，本地筛掉不自洽的。
 * 生成几次总能过一次。
 */
export async function generateCase({
  e,
  route,
  session,
  victim,
  culprit,
  chapter = session.chapter,
  onProgress,
}) {
  const locationIds = session.prison.locations.map((item) => item.id);
  let lastProblems = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const reason = lastProblems?.length ? lastProblems.slice(0, 2).join("、") : "上一次调用失败";
      await onProgress?.(`案件第 ${attempt - 1} 稿逻辑不自洽（${reason}），正在重写…`);
    }

    let prompt = buildCasePrompt({
      prison: session.prison,
      girls: session.girls,
      victim,
      culprit,
      chapter,
      history: session.history,
    });
    if (lastProblems) {
      prompt += `\n\n上一版有这些问题，这次必须避免：\n${lastProblems.map((item) => `- ${item}`).join("\n")}`;
    }

    let text;
    try {
      text = await askAI({ route, e, system: CASE_SYSTEM, prompt });
    } catch (error) {
      logger.warn(`[魔女审判] 案件生成第 ${attempt} 次调用失败：${error.message}`);
      if (attempt === MAX_ATTEMPTS) throw error;
      continue;
    }

    const parsed = extractJson(text);
    if (!parsed) {
      lastProblems = ["输出不是合法 JSON"];
      logger.warn(`[魔女审判] 案件第 ${attempt} 次返回的不是 JSON`);
      continue;
    }

    const caseFile = normalizeCase(parsed, { chapter });
    // 死者和凶手是本地掷定的，不采信 AI 写回来的
    caseFile.victimId = victim.id;
    caseFile.culpritId = culprit.id;

    const { ok, problems } = validateCase(caseFile, { girls: session.girls, locationIds });
    if (ok) {
      // NPC 凶手的行动排程在这里一次性定死，绝不让 AI 每回合即兴决定毁什么
      if (culprit.kind === "npc") {
        caseFile.witchPlan = planWitchActions(caseFile, { rounds: session.investigateRounds });
      }
      logger.info(
        `[魔女审判] 第 ${chapter} 章案件就位：死者 ${victim.name}，凶手 ${culprit.name}（${culprit.kind}），证据 ${caseFile.evidence.length} 条`
      );
      return caseFile;
    }

    lastProblems = problems;
    logger.warn(`[魔女审判] 案件第 ${attempt} 稿校验未通过：${problems.join("、")}`);
  }

  throw new Error(`案件连续 ${MAX_ATTEMPTS} 次生成失败：${lastProblems?.join("、") || "未知原因"}`);
}
