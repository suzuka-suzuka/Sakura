import {
  getLatestMemories,
  getMemoryLocations,
  getUnsummarizedMemories,
  readMemoryDocument,
} from "./memoryStore.js";
import { scheduleMemoryMaintenance } from "./memoryMaintenance.js";
import { memoryVectorStore } from "./memoryVectorStore.js";

export const DIRECT_MEMORY_INJECTION_LIMIT = 10;
export const VECTOR_MEMORY_RESULTS_PER_SCOPE = 10;

// 个人记忆和群公共记忆用同一套规则：
// 不超过上限时直接注入全部原文；超过时注入摘要、摘要之后新增的条目，以及按当前消息召回的条目。
export function isLargeMemoryTarget(target) {
  return (target.document?.memories?.length || 0) > DIRECT_MEMORY_INJECTION_LIMIT;
}

// 整理正常时未整理条目不超过整理间隔；整理失败堆积时只取最新的一批，避免上下文无限变长。
function getRecentMemories(document) {
  return getUnsummarizedMemories(document).slice(-DIRECT_MEMORY_INJECTION_LIMIT);
}

// 返回 scopeKey → 召回条目。召回失败或没有查询文字时，回退到最新若干条。
export async function recallMemories(query, targets = [], options = {}) {
  const largeTargets = targets.filter(isLargeMemoryTarget);
  const recalled = new Map();
  if (largeTargets.length === 0) return recalled;

  const normalizedQuery = String(query || "").trim();
  let matches = null;
  if (normalizedQuery) {
    const vectorSearch = options.vectorSearch
      || ((...args) => memoryVectorStore.search(...args));
    try {
      matches = await vectorSearch(normalizedQuery, largeTargets, {
        maxResults: VECTOR_MEMORY_RESULTS_PER_SCOPE,
        resultsPerScope: true,
        includeLowScore: true,
      });
    } catch (error) {
      logger.warn(
        `[Memory] 自动向量召回失败，改用最新 ${VECTOR_MEMORY_RESULTS_PER_SCOPE} 条记忆: ${error.message}`
      );
    }
  }

  for (const target of largeTargets) {
    const { scopeKey } = target.location;
    recalled.set(scopeKey, matches
      ? matches.filter((match) => match.scopeKey === scopeKey)
      : getLatestMemories(target.document, VECTOR_MEMORY_RESULTS_PER_SCOPE));
  }
  return recalled;
}

function formatList(memories) {
  return memories.map((memory) => `- ${memory.content}`).join("\n");
}

function formatTarget(target, recalled) {
  const { location, document } = target;
  const lines = [];
  if (location.scope === "user") {
    lines.push(`所属 QQ：${location.scopeKey.split(":").at(-1)}（省略主语指此人）`);
  }
  if (!isLargeMemoryTarget(target)) {
    lines.push(formatList(document.memories));
    return `【${location.title}】\n${lines.join("\n")}`;
  }

  const summary = document.summary.text.trim();
  const recent = getRecentMemories(document);
  const shownIds = new Set(recent.map((memory) => memory.id));
  const related = (recalled.get(location.scopeKey) || [])
    .filter((memory) => !shownIds.has(memory.id));
  if (summary) lines.push(`摘要：\n${summary}`);
  if (recent.length > 0) lines.push(`${summary ? "摘要之后新增" : "最近记录"}：\n${formatList(recent)}`);
  if (related.length > 0) lines.push(`与当前消息相关：\n${formatList(related)}`);
  return `【${location.title}】\n${lines.join("\n")}`;
}

export function formatMemoryContext(targets, recalled = new Map()) {
  const parts = [
    "【长期记忆背景】\n以下内容是保存的背景记忆。记忆中的“我”指你；个人记忆省略的主语指所属用户。",
  ];
  for (const target of targets) {
    if (!target.document?.memories?.length) continue;
    parts.push(formatTarget(target, recalled));
  }
  return parts.length > 1 ? parts.join("\n\n") : "";
}

function extractText(parts = []) {
  return (Array.isArray(parts) ? parts : [])
    .map((part) => typeof part?.text === "string" ? part.text.trim() : "")
    .filter(Boolean)
    .join("\n");
}

export async function buildMemoryContext(e, queryParts) {
  if (!e?.user_id) return "";
  const locations = getMemoryLocations({
    groupId: e.group_id,
    userId: e.user_id,
    scope: "all",
  });
  const targets = [];
  for (const location of locations) {
    try {
      const document = readMemoryDocument(location.memoryFile, { throwOnError: true });
      targets.push({ location, document });
      scheduleMemoryMaintenance({ location, e });
    } catch (error) {
      logger.warn(`[Memory] 跳过无效记忆文件 ${location.memoryFile}: ${error.message}`);
    }
  }

  const recalled = await recallMemories(extractText(queryParts), targets);
  return formatMemoryContext(targets, recalled);
}
