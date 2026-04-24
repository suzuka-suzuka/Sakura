export function parseLogEntries(content = "") {
  const rawLines = String(content).split(/\r?\n/);
  const timeRegex = /^\[\d{2}:\d{2}:\d{2}\]/;
  const entries = [];
  let current = "";

  for (const line of rawLines) {
    if (!line.trim()) continue;
    if (timeRegex.test(line)) {
      if (current) entries.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }

  if (current) entries.push(current);
  return entries;
}

const ANSI_REGEX = /\u001b\[[0-9;]*m/g;

const GROUP_MESSAGE_HINTS = [
  "群聊",
  "send_group",
  "set_group",
  "get_group",
  "forward_group",
  "group_",
  "加群",
  "群成员",
  "群禁言",
  "群撤回",
  "群文件",
  "群管理员",
  "群名片",
  "群精华",
  "表情回应",
  "群名变更",
  "群头衔变更",
  "输入状态",
  "通知",
  "戳一戳",
];

const PRIVATE_MESSAGE_HINTS = [
  "私聊",
  "send_private",
  "set_friend",
  "get_friend",
  "friend_",
  "好友",
  "陌生人",
  "好友请求",
  "好友添加",
  "私聊撤回",
];

const GROUP_ID_PATTERNS = [
  /^(?:群成员增加|群成员减少|群禁言|群撤回|群文件上传|群管理员变动|群名片变更|群精华|表情回应|加群请求|群名变更|群头衔变更|通知)\s+(\d+)/,
  /^戳一戳\s+(\d+)\s+\d+/,
  /^输入状态\s+(\d+)\s+\d+/,
];

const PRIVATE_ID_PATTERNS = [
  /^(?:私聊撤回|好友添加|好友请求)\s+(\d+)/,
  /^戳一戳\s+私聊\s+(\d+)/,
  /^输入状态\s+私聊\s+(\d+)/,
];

const FALLBACK_GROUP_ID_PATTERNS = [
  /^(?:群成员增加|群成员减少|群禁言|群撤回|群文件上传|群管理员变动|群名片变更|群精华|表情回应|加群请求|群名变更|群头衔变更|通知)\s+(\d+)/,
  /^戳一戳\s+(\d+)\s+\d+/,
  /^输入状态\s+(\d+)\s+\d+/,
  /^发送\s*->\s*群聊\s+(\d+)/,
  /^发送\s*->\s*转发\s+群聊\s+(\d+)/,
];

const FALLBACK_PRIVATE_ID_PATTERNS = [
  /^(?:私聊撤回|好友添加|好友请求)\s+(\d+)/,
  /^戳一戳\s+私聊\s+(\d+)/,
  /^输入状态\s+私聊\s+(\d+)/,
  /^发送\s*->\s*私聊\s+(\d+)/,
  /^发送\s*->\s*转发\s+私聊\s+(\d+)/,
];

function stripAnsi(text = "") {
  return String(text).replace(ANSI_REGEX, "");
}

function normalizeOptionalNumericId(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function extractTrailingNumericId(token = "") {
  const text = stripAnsi(token).trim();
  if (!text) return null;

  const explicitGroupMatch = text.match(/^群[:：]?\s*(\d+)$/);
  if (explicitGroupMatch) {
    return Number(explicitGroupMatch[1]);
  }

  const parenMatch = text.match(/\((\d+)\)$/);
  if (parenMatch) {
    return Number(parenMatch[1]);
  }

  const digitMatch = text.match(/(\d+)$/);
  return digitMatch ? Number(digitMatch[1]) : null;
}

function extractScopedContextId(token = "") {
  const text = stripAnsi(token).trim();
  if (!text) return null;

  const explicitGroupMatch = text.match(/^群[:：]?\s*(\d+)$/);
  if (explicitGroupMatch) {
    return Number(explicitGroupMatch[1]);
  }

  const explicitPrivateMatch = text.match(/^私聊[:：]?\s*(\d+)$/);
  if (explicitPrivateMatch) {
    return Number(explicitPrivateMatch[1]);
  }

  const parenMatch = text.match(/\((\d+)\)$/);
  return parenMatch ? Number(parenMatch[1]) : null;
}

function hasMessageHint(message = "", hints = []) {
  const text = stripAnsi(message).toLowerCase();
  return hints.some((hint) => text.includes(hint.toLowerCase()));
}

function isExplicitGroupToken(token = "") {
  return /^群[:：]?\s*\d+$/.test(stripAnsi(token).trim());
}

function extractIdFromMessage(message = "", patterns = []) {
  const text = stripAnsi(message).trim();
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return Number(match[1]);
    }
  }
  return null;
}

export function getLogEntryMeta(entry = "") {
  const text = String(entry);
  const baseMatch = text.match(/^\[(\d{2}:\d{2}:\d{2})\] \[([A-Z]+)\]\s*/);
  const level = baseMatch?.[2] || null;
  let remaining = baseMatch ? text.slice(baseMatch[0].length) : text;
  const bracketTokens = [];

  while (remaining.startsWith("[")) {
    const tokenMatch = remaining.match(/^\[([^\]]+)\]\s*/);
    if (!tokenMatch) break;
    bracketTokens.push(tokenMatch[1]);
    remaining = remaining.slice(tokenMatch[0].length);
  }

  let selfId = null;
  if (bracketTokens[0] && /^\d+$/.test(stripAnsi(bracketTokens[0]).trim())) {
    selfId = Number(stripAnsi(bracketTokens[0]).trim());
  }

  const contextTokens = selfId == null ? bracketTokens : bracketTokens.slice(1);
  const firstToken = contextTokens[0] || null;
  const secondToken = contextTokens[1] || null;
  const contextId = extractScopedContextId(firstToken);
  const secondContextId = extractScopedContextId(secondToken);
  const firstId = contextId ?? extractTrailingNumericId(firstToken);
  const secondId = secondContextId ?? extractTrailingNumericId(secondToken);
  const hasGroupHint = hasMessageHint(remaining, GROUP_MESSAGE_HINTS);
  const hasPrivateHint = hasMessageHint(remaining, PRIVATE_MESSAGE_HINTS);

  let groupId = null;
  let userId = null;

  if (firstId != null) {
    if (isExplicitGroupToken(firstToken) || contextTokens.length >= 2) {
      groupId = firstId;
      userId = secondId;
    } else if (hasPrivateHint && !hasGroupHint) {
      userId = firstId;
    } else if (hasGroupHint && !hasPrivateHint) {
      groupId = firstId;
    }
  }

  if (groupId == null) {
    groupId =
      extractIdFromMessage(remaining, GROUP_ID_PATTERNS) ??
      extractIdFromMessage(remaining, FALLBACK_GROUP_ID_PATTERNS);
  }

  if (userId == null) {
    userId =
      extractIdFromMessage(remaining, PRIVATE_ID_PATTERNS) ??
      extractIdFromMessage(remaining, FALLBACK_PRIVATE_ID_PATTERNS);
  }

  return {
    level,
    selfId,
    groupId,
    userId,
    contextId,
    secondContextId,
    bracketTokens,
    contextTokens,
    message: remaining,
  };
}

export function filterLogEntriesByLevel(entries, level = "ALL") {
  if (!Array.isArray(entries)) return [];
  if (level === "ERROR") {
    return entries.filter((entry) => entry.includes("[ERROR]"));
  }
  if (level === "WARN") {
    return entries.filter((entry) => entry.includes("[ERROR]") || entry.includes("[WARN]"));
  }
  if (level === "INFO") {
    return entries.filter(
      (entry) => entry.includes("[ERROR]") || entry.includes("[WARN]") || entry.includes("[INFO]")
    );
  }
  return [...entries];
}

export function groupLogEntriesBySelfId(entries) {
  const common = [];
  const bySelfId = new Map();

  for (const entry of entries || []) {
    const { selfId } = getLogEntryMeta(entry);
    if (selfId == null) {
      common.push(entry);
      continue;
    }

    if (!bySelfId.has(selfId)) {
      bySelfId.set(selfId, []);
    }
    bySelfId.get(selfId).push(entry);
  }

  return { common, bySelfId };
}

export function filterLogEntriesByScope(entries, options = {}) {
  const {
    targetSelfId = null,
    groupId = null,
    allGroups = false,
    includeCommon = true,
  } = options;

  const normalizedTargetSelfId = normalizeOptionalNumericId(targetSelfId);
  const normalizedGroupId = normalizeOptionalNumericId(groupId);

  return (entries || []).filter((entry) => {
    const meta = getLogEntryMeta(entry);
    const hasScopedContext = meta.contextId != null;
    const isCommonEntry = meta.groupId == null && meta.userId == null && !hasScopedContext;

    if (
      normalizedTargetSelfId != null &&
      meta.selfId != null &&
      meta.selfId !== normalizedTargetSelfId
    ) {
      return false;
    }

    if (normalizedGroupId != null) {
      if (meta.groupId != null) {
        return meta.groupId === normalizedGroupId;
      }
      if (meta.contextId != null) {
        return meta.contextId === normalizedGroupId;
      }
      return includeCommon && isCommonEntry;
    }

    if (allGroups) {
      if (meta.groupId != null) {
        return true;
      }
      if (meta.userId != null || hasScopedContext) {
        return false;
      }
      return includeCommon && isCommonEntry;
    }

    return true;
  });
}

export function takeLatestLogEntries(entries, limit = 50) {
  const normalizedLimit = Math.max(1, Number(limit) || 50);
  return (Array.isArray(entries) ? entries : []).slice(-normalizedLimit).reverse();
}

export function buildLogSections(entries, options = {}) {
  const {
    limit = 50,
    includeCommon = true,
    targetSelfId = null,
    groupBySelfId = false,
  } = options;
  const normalizedLimit = Math.max(1, Number(limit) || 50);
  const { common, bySelfId } = groupLogEntriesBySelfId(entries);
  const sections = [];

  if (groupBySelfId) {
    if (includeCommon && common.length > 0) {
      sections.push({
        key: "common",
        title: "公共系统日志",
        total: common.length,
        entries: takeLatestLogEntries(common, normalizedLimit),
      });
    }

    const sortedSelfIds = [...bySelfId.keys()].sort((a, b) => a - b);
    for (const selfId of sortedSelfIds) {
      const scopedEntries = bySelfId.get(selfId) || [];
      if (scopedEntries.length === 0) continue;
      sections.push({
        key: `bot:${selfId}`,
        title: `账号 ${selfId}`,
        total: scopedEntries.length,
        entries: takeLatestLogEntries(scopedEntries, normalizedLimit),
      });
    }

    return sections;
  }

  if (targetSelfId != null) {
    if (includeCommon && common.length > 0) {
      sections.push({
        key: "common",
        title: "公共系统日志",
        total: common.length,
        entries: takeLatestLogEntries(common, normalizedLimit),
      });
    }

    const scopedEntries = bySelfId.get(Number(targetSelfId)) || [];
    if (scopedEntries.length > 0) {
      sections.push({
        key: `bot:${targetSelfId}`,
        title: `账号 ${targetSelfId}`,
        total: scopedEntries.length,
        entries: takeLatestLogEntries(scopedEntries, normalizedLimit),
      });
    }
    return sections;
  }

  const flatEntries = Array.isArray(entries) ? entries : [];
  if (flatEntries.length > 0) {
    sections.push({
      key: "all",
      title: "日志",
      total: flatEntries.length,
      entries: takeLatestLogEntries(flatEntries, normalizedLimit),
    });
  }

  return sections;
}

export function formatLogSections(sections) {
  return (sections || [])
    .filter((section) => Array.isArray(section.entries) && section.entries.length > 0)
    .map((section) => {
      const header = `【${section.title}】\n共 ${section.total} 条，显示最近 ${section.entries.length} 条`;
      return `${header}\n${section.entries.join("\n")}`;
    })
    .join("\n\n");
}
