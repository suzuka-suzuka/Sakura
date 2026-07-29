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
  createAnonymousGirlIdMap,
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

const MAX_CONTENT_ATTEMPTS = 3;

function setupGirlIds(count) {
  return Array.from(
    { length: count },
    (_, index) => `girl_${String(index + 1).padStart(3, "0")}`
  );
}

function orderedSetupGirls(parsed, count) {
  if (!Array.isArray(parsed?.girls) || parsed.girls.length !== count) return null;

  const byId = new Map();
  for (const item of parsed.girls) {
    const id = String(item?.id ?? "").trim();
    const name = String(item?.name ?? "").trim();
    if (!id || !name || byId.has(id)) return null;
    byId.set(id, item);
  }

  const ordered = setupGirlIds(count).map((id) => byId.get(id));
  if (ordered.some((item) => !item)) return null;

  const names = new Set(ordered.map((item) => String(item.name).trim()));
  return names.size === count ? ordered : null;
}

function remapCaseGirlReferences(raw, anonymousGirlIds) {
  const internalIdByAnonymousId = new Map(
    [...anonymousGirlIds].map(([internalId, anonymousId]) => [anonymousId, internalId])
  );
  const remap = (value) => {
    const id = String(value ?? "").trim();
    return internalIdByAnonymousId.get(id) || id;
  };

  if (raw?.discovery && typeof raw.discovery === "object") {
    raw.discovery.finder = remap(raw.discovery.finder);
  }
  for (const proposition of Array.isArray(raw?.propositions) ? raw.propositions : []) {
    if (proposition?.conclusion?.type === "accuse") {
      proposition.conclusion.targetId = remap(proposition.conclusion.targetId);
    }
  }
  for (const evidence of Array.isArray(raw?.evidence) ? raw.evidence : []) {
    if (evidence?.via === "ask") {
      evidence.askTarget = remap(evidence.askTarget);
    }
  }
  return raw;
}

function anonymizeValidationProblems(problems, anonymousGirlIds) {
  return problems.map((problem) => {
    let text = String(problem);
    for (const [internalId, anonymousId] of anonymousGirlIds) {
      text = text.split(internalId).join(anonymousId);
    }
    return text;
  });
}

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
  let generatedGirls = null;
  const girlCount = players.length + npcCount;

  for (let attempt = 1; attempt <= MAX_CONTENT_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await onProgress?.(`牢狱第 ${attempt - 1} 稿格式不完整，正在重写…`);
    }

    // API 与传输错误不在这里捕获或重试，统一交给 AI 路由处理。
    const text = await askAI({
      route,
      e,
      system: SETUP_SYSTEM,
      prompt: buildSetupPrompt({ girlCount, theme }),
    });
    parsed = extractJson(text);
    generatedGirls = orderedSetupGirls(parsed, girlCount);
    if (
      parsed?.prison &&
      generatedGirls &&
      Array.isArray(parsed.prison.locations) &&
      parsed.prison.locations.length >= 3
    ) {
      break;
    }

    logger.warn(`[魔女审判] 开局第 ${attempt} 稿格式不完整`);
    parsed = null;
    generatedGirls = null;
  }

  if (!parsed || !generatedGirls) {
    throw new Error(`牢狱连续 ${MAX_CONTENT_ATTEMPTS} 稿格式不合格`);
  }

  const prison = normalizePrison(parsed.prison);
  if (prison.locations.length < 3) {
    throw new Error("牢狱地点少于 3 个，无法开局");
  }

  const girls = {};

  // AI 只生成一份不区分真人/NPC 的少女名单；角色归属在本地按槽位绑定。
  players.forEach((player, index) => {
    const id = toPlayerId(player.userId);
    girls[id] = normalizeGirl(generatedGirls[index], {
      id,
      kind: "player",
      userId: player.userId,
    });
  });

  generatedGirls.slice(players.length).forEach((item, index) => {
    const id = toNpcId(`girl_${index + 1}`);
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
 * 生成一章的案件档案，并在本地做一致性校验。
 *
 * API 与传输失败交给路由层；只有拿到内容后解析或校验不通过，才重写下一稿。
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
  const anonymousGirlIds = createAnonymousGirlIdMap(session.girls);
  let lastProblems = null;

  for (let attempt = 1; attempt <= MAX_CONTENT_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await onProgress?.(
        `案件第 ${attempt - 1} 稿不合格（${lastProblems.slice(0, 2).join("、")}），正在重写…`
      );
    }

    let prompt = buildCasePrompt({
      prison: session.prison,
      girls: session.girls,
      victim,
      culprit,
      chapter,
      history: session.history,
      anonymousGirlIds,
    });
    if (lastProblems) {
      prompt += `\n\n上一版有这些问题，这次必须避免：\n${lastProblems.map((item) => `- ${item}`).join("\n")}`;
    }

    // API 与传输错误不在这里捕获或重试，统一交给 AI 路由处理。
    const text = await askAI({ route, e, system: CASE_SYSTEM, prompt });
    const parsed = extractJson(text);
    if (!parsed) {
      lastProblems = ["输出不是合法 JSON"];
      logger.warn(`[魔女审判] 案件第 ${attempt} 稿不是合法 JSON`);
      continue;
    }

    const caseFile = normalizeCase(
      remapCaseGirlReferences(parsed, anonymousGirlIds),
      { chapter }
    );
    // 死者和凶手是本地掷定的，不采信 AI 写回来的
    caseFile.victimId = victim.id;
    caseFile.culpritId = culprit.id;

    const { ok, problems } = validateCase(caseFile, { girls: session.girls, locationIds });
    if (!ok) {
      lastProblems = anonymizeValidationProblems(problems, anonymousGirlIds);
      logger.warn(`[魔女审判] 案件第 ${attempt} 稿校验未通过：${lastProblems.join("、")}`);
      continue;
    }

    // NPC 凶手的行动排程在这里一次性定死，绝不让 AI 每回合即兴决定毁什么
    if (culprit.kind === "npc") {
      caseFile.witchPlan = planWitchActions(caseFile, { rounds: session.investigateRounds });
    }
    logger.info(
      `[魔女审判] 第 ${chapter} 章案件就位：死者 ${victim.name}，凶手 ${culprit.name}（${culprit.kind}），证据 ${caseFile.evidence.length} 条`
    );
    return caseFile;
  }

  throw new Error(
    `案件连续 ${MAX_CONTENT_ATTEMPTS} 稿内容不合格：${lastProblems?.join("、") || "未知原因"}`
  );
}
