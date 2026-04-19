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
  if (bracketTokens[0] && /^\d+$/.test(bracketTokens[0])) {
    selfId = Number(bracketTokens[0]);
  }

  return {
    level,
    selfId,
    bracketTokens,
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
        entries: common.slice(-normalizedLimit),
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
        entries: scopedEntries.slice(-normalizedLimit),
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
        entries: common.slice(-normalizedLimit),
      });
    }

    const scopedEntries = bySelfId.get(Number(targetSelfId)) || [];
    if (scopedEntries.length > 0) {
      sections.push({
        key: `bot:${targetSelfId}`,
        title: `账号 ${targetSelfId}`,
        total: scopedEntries.length,
        entries: scopedEntries.slice(-normalizedLimit),
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
      entries: flatEntries.slice(-normalizedLimit),
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
