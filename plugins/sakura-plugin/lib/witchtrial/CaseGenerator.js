/**
 * 牢狱、少女与案件的生成
 *
 * 开局调一次 AI 出牢狱和全体少女；之后每章先生成故事蓝图，再为本地证据图填文。
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
  SETUP_SYSTEM,
  buildSetupPrompt,
  createAnonymousGirlIdMap,
} from "./prompts.js";
import {
  CASE_BLUEPRINT_SYSTEM,
  CASE_TEXT_SYSTEM,
  buildCaseBlueprintPrompt,
  buildCaseTextPrompt,
} from "./CasePrompts.js";
import {
  buildCaseDraft,
  createCaseTopology,
  mergeCaseText,
  normalizeCaseBlueprint,
  validateCaseText,
} from "./CaseGraph.js";
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

function girlIdResolver(anonymousGirlIds) {
  const internalIdByAnonymousId = new Map(
    [...anonymousGirlIds].map(([internalId, anonymousId]) => [anonymousId, internalId])
  );
  return (value) => {
    const id = String(value ?? "").trim();
    return internalIdByAnonymousId.get(id) || id;
  };
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
 * 生成一章的案件档案。
 *
 * 1. 本地先锁定候选结论与证据图；
 * 2. AI 生成不含证据关系的故事蓝图；
 * 3. AI 只给锁定的槽位填写可读文本；
 * 4. 原有 validateCase 对合并结果做最终独立校验。
 *
 * API 与传输失败仍交给路由层；这里只重试已经收到内容后的 JSON 或内容校验失败。
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
  const resolveGirlId = girlIdResolver(anonymousGirlIds);
  const topology = createCaseTopology({
    prison: session.prison,
    girls: session.girls,
    victim,
    culprit,
    chapter,
  });
  let blueprint = null;
  let draft = null;
  let lastBlueprintProblems = null;

  for (let attempt = 1; attempt <= MAX_CONTENT_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await onProgress?.(`案件蓝图第 ${attempt - 1} 稿格式不完整，正在重写…`);
    }

    let prompt = buildCaseBlueprintPrompt({
      prison: session.prison,
      girls: session.girls,
      victim,
      culprit,
      topology,
      chapter,
      history: session.history,
      anonymousGirlIds,
    });
    if (lastBlueprintProblems) {
      prompt += `\n\n上一版有这些问题，这次必须修正：\n${lastBlueprintProblems.map((item) => `- ${item}`).join("\n")}`;
    }

    // API 与传输错误不在这里捕获或重试，统一交给 AI 路由处理。
    const text = await askAI({
      route,
      e,
      system: CASE_BLUEPRINT_SYSTEM,
      prompt,
    });
    const parsed = extractJson(text);
    if (!parsed) {
      lastBlueprintProblems = ["输出不是合法 JSON"];
      logger.warn(`[魔女审判] 案件蓝图第 ${attempt} 稿不是合法 JSON`);
      continue;
    }

    const normalized = normalizeCaseBlueprint(parsed, {
      topology,
      resolveGirlId,
    });
    if (!normalized.ok) {
      lastBlueprintProblems = anonymizeValidationProblems(
        normalized.problems,
        anonymousGirlIds
      );
      logger.warn(
        `[魔女审判] 案件蓝图第 ${attempt} 稿校验未通过（${lastBlueprintProblems.length} 项）`
      );
      continue;
    }

    const candidateDraft = buildCaseDraft({
      topology,
      blueprint: normalized.blueprint,
    });
    const structuralCase = normalizeCase(candidateDraft, { chapter });
    const structuralResult = validateCase(structuralCase, {
      girls: session.girls,
      locationIds,
    });
    if (!structuralResult.ok) {
      lastBlueprintProblems = anonymizeValidationProblems(
        structuralResult.problems,
        anonymousGirlIds
      );
      logger.warn(
        `[魔女审判] 案件蓝图第 ${attempt} 稿与本地证据图不相容（${lastBlueprintProblems.length} 项）`
      );
      continue;
    }

    blueprint = normalized.blueprint;
    draft = candidateDraft;
    break;
  }

  if (!blueprint || !draft) {
    logger.error(
      `[魔女审判] 案件蓝图连续 ${MAX_CONTENT_ATTEMPTS} 稿未通过检查`
    );
    throw new Error(`案件蓝图连续 ${MAX_CONTENT_ATTEMPTS} 稿未通过检查`);
  }

  let lastTextProblems = null;
  for (let attempt = 1; attempt <= MAX_CONTENT_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await onProgress?.(`案件文本第 ${attempt - 1} 稿未通过一致性检查，正在修订…`);
    }

    let prompt = buildCaseTextPrompt({
      prison: session.prison,
      girls: session.girls,
      victim,
      culprit,
      topology,
      draft,
    });
    if (lastTextProblems) {
      prompt += `\n\n上一版有这些问题，这次必须修正：\n${lastTextProblems.map((item) => `- ${item}`).join("\n")}`;
    }

    const text = await askAI({
      route,
      e,
      system: CASE_TEXT_SYSTEM,
      prompt,
    });
    const parsed = extractJson(text);
    if (!parsed) {
      lastTextProblems = ["输出不是合法 JSON"];
      logger.warn(`[魔女审判] 案件文本第 ${attempt} 稿不是合法 JSON`);
      continue;
    }

    const textResult = validateCaseText(parsed, topology);
    if (!textResult.ok) {
      lastTextProblems = textResult.problems;
      logger.warn(
        `[魔女审判] 案件文本第 ${attempt} 稿不完整（${lastTextProblems.length} 项）`
      );
      continue;
    }

    const caseFile = normalizeCase(mergeCaseText(draft, parsed), { chapter });
    // 身份和结构都来自本地拓扑，不采信文本阶段可能夹带的任何额外字段。
    caseFile.victimId = victim.id;
    caseFile.culpritId = culprit.id;
    caseFile.truthId = topology.truthId;

    const finalResult = validateCase(caseFile, {
      girls: session.girls,
      locationIds,
    });
    if (!finalResult.ok) {
      lastTextProblems = anonymizeValidationProblems(
        finalResult.problems,
        anonymousGirlIds
      );
      logger.warn(
        `[魔女审判] 案件文本第 ${attempt} 稿最终校验未通过（${lastTextProblems.length} 项）`
      );
      continue;
    }

    // NPC 凶手的行动排程在这里一次性定死，绝不让 AI 每回合即兴决定毁什么。
    if (culprit.kind === "npc") {
      caseFile.witchPlan = planWitchActions(caseFile, {
        rounds: session.investigateRounds,
      });
    }
    logger.info(
      `[魔女审判] 第 ${chapter} 章案件就位：死者 ${victim.name}，凶手 ${culprit.name}（${culprit.kind}），证据 ${caseFile.evidence.length} 条`
    );
    return caseFile;
  }

  logger.error(
    `[魔女审判] 案件文本连续 ${MAX_CONTENT_ATTEMPTS} 稿未通过一致性检查`
  );
  throw new Error(`案件文本连续 ${MAX_CONTENT_ATTEMPTS} 稿未通过一致性检查`);
}
