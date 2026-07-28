/**
 * 模组与角色卡生成
 *
 * 开局只调两次 AI：一次出模组，一次出全部角色卡。
 * 之后整局游戏的剧情「不变量」就固定下来了，KP 每回合只在这个框架内即兴。
 */

import { getAI } from "../AIUtils/getAI.js";
import {
  CHARACTER_SYSTEM,
  MODULE_SYSTEM,
  buildCharacterPrompt,
  buildModulePrompt,
} from "./prompts.js";
import { extractJson, normalizeCharacter, normalizeModule, validateModule } from "./schema.js";

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
 * 生成模组，带校验重试
 * @returns {Promise<object>} 归一化后的模组
 */
export async function generateModule({ e, route, playerCount, theme, tone, onProgress }) {
  let lastProblems = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      // lastProblems 为空说明上一轮是调用本身失败，不是稿子不合格
      const reason = lastProblems?.length ? lastProblems.join("、") : "上一次调用失败";
      await onProgress?.(`模组第 ${attempt - 1} 稿没成（${reason}），正在重写…`);
    }

    let prompt = buildModulePrompt({ playerCount, theme, tone });
    if (lastProblems) {
      prompt += `\n\n注意：上一版存在这些问题，这次必须避免：${lastProblems.join("；")}。`;
    }

    let text;
    try {
      text = await askAI({ route, e, system: MODULE_SYSTEM, prompt });
    } catch (error) {
      logger.warn(`[跑团] 模组生成第 ${attempt} 次调用失败：${error.message}`);
      if (attempt === MAX_ATTEMPTS) throw error;
      continue;
    }

    const parsed = extractJson(text);
    if (!parsed) {
      lastProblems = ["输出不是合法 JSON"];
      logger.warn(`[跑团] 模组生成第 ${attempt} 次返回的不是 JSON`);
      continue;
    }

    const module = normalizeModule(parsed);
    const { ok, problems } = validateModule(module);
    if (ok) {
      logger.info(`[跑团] 模组《${module.title}》生成成功，场景 ${module.scenes.length} 个，NPC ${module.npcs.length} 个`);
      return module;
    }

    lastProblems = problems;
    logger.warn(`[跑团] 模组第 ${attempt} 稿校验未通过：${problems.join("、")}`);
  }

  throw new Error(`模组连续 ${MAX_ATTEMPTS} 次生成失败：${lastProblems?.join("、") || "未知原因"}`);
}

/**
 * 为全部玩家生成角色卡
 * AI 漏人或对不上号时，用本地兜底补齐，保证每个玩家都有卡
 * @returns {Promise<object[]>} 与 players 顺序一致的角色卡数组
 */
export async function generateCharacters({ e, route, module, players }) {
  const prompt = buildCharacterPrompt({ module, players });

  let parsed = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let text;
    try {
      text = await askAI({ route, e, system: CHARACTER_SYSTEM, prompt });
    } catch (error) {
      logger.warn(`[跑团] 角色卡生成第 ${attempt} 次调用失败：${error.message}`);
      if (attempt === MAX_ATTEMPTS) throw error;
      continue;
    }

    parsed = extractJson(text);
    if (Array.isArray(parsed?.characters) && parsed.characters.length) break;

    logger.warn(`[跑团] 角色卡第 ${attempt} 次输出无法解析`);
    parsed = null;
  }

  const rawList = Array.isArray(parsed?.characters) ? parsed.characters : [];

  // AI 可能把 userId 写错或顺序打乱，先按 QQ 精确匹配，匹配不到的再按顺序兜底
  const byUserId = new Map();
  for (const item of rawList) {
    const key = String(item?.userId ?? "").trim();
    if (key && !byUserId.has(key)) byUserId.set(key, item);
  }

  const leftovers = rawList.filter((item) => {
    const key = String(item?.userId ?? "").trim();
    return !key || !players.some((player) => String(player.userId) === key);
  });

  return players.map((player, index) => {
    const matched = byUserId.get(String(player.userId)) || leftovers.shift() || rawList[index];
    if (!matched) {
      logger.warn(`[跑团] 玩家 ${player.userId} 没分到 AI 角色卡，使用本地兜底`);
    }
    return normalizeCharacter(matched, {
      userId: player.userId,
      nickname: player.nickname,
    });
  });
}
