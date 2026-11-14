// 旧版“供应商 + 路由”配置迁移到“供应商 + 模型 + 使用处模型列表”。
// 在框架注册插件配置之前执行（此时旧的 Routes.yaml 还没被当作废弃模块删除），
// 只在发现旧格式时动手，重复执行不会产生变化。
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { DEFAULT_MODEL_TIMEOUT_MS } from "./aiModels.js";

const ACCOUNT_SCOPE_DIR = "_accounts";
const BACKUP_DIR = "_migration-backup";
const ROUTE_FILES = {
  chat: "Routes.yaml",
  image: "ImageRoutes.yaml",
  video: "VideoRoutes.yaml",
};
const CHAT_SETTING_FIELDS = [
  "nativeWebSearch",
  "openaiReasoningEffort",
  "geminiThinkingLevel",
  "stream",
  "temperature",
  "topP",
  "openaiEnableThinking",
  "geminiThinkingBudget",
];
const CHAT_SETTING_DEFAULTS = {
  nativeWebSearch: false,
  openaiReasoningEffort: "default",
  geminiThinkingLevel: "default",
  stream: false,
  temperature: -1,
  topP: -1,
  openaiEnableThinking: false,
  geminiThinkingBudget: -2,
};

function readYaml(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return yaml.load(fs.readFileSync(filePath, "utf8")) || {};
  } catch {
    return null;
  }
}

function writeYaml(filePath, data) {
  fs.writeFileSync(filePath, yaml.dump(data, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    quotingType: "'",
  }), "utf8");
}

function backupFile(directory, fileName, stamp) {
  const source = path.join(directory, fileName);
  if (!fs.existsSync(source)) return;
  const backupDir = path.join(directory, BACKUP_DIR, stamp);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(source, path.join(backupDir, `${fileName}.bak`));
}

function priorityOf(item) {
  const value = Number(item?.priority);
  return Number.isFinite(value) ? value : 0;
}

/** 按优先级从高到低排序，同优先级保持原顺序。 */
function byPriority(items) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => ({ item, index }))
    .sort((a, b) => priorityOf(b.item) - priorityOf(a.item) || a.index - b.index)
    .map(({ item }) => item);
}

function isLegacyProviders(data) {
  return Array.isArray(data?.providers)
    && data.providers.some((provider) => provider && ("id" in provider || "credentials" in provider));
}

export function migrateProviders(data) {
  return {
    providers: (data?.providers || []).map((provider) => {
      if (!provider || !("id" in provider || "credentials" in provider)) return provider;
      const credentials = byPriority(provider.credentials).filter((credential) => credential?.enabled !== false);
      const unique = (values) => [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
      return {
        name: String(provider.name ?? provider.id ?? "").trim(),
        protocol: provider.protocol || "openai",
        baseURL: provider.baseURL || "",
        vertex: provider.vertex === true,
        apiKeys: unique(credentials.map((credential) => credential.apiKey)),
        serviceAccounts: unique(credentials.map((credential) => credential.serviceAccountRef)),
      };
    }),
  };
}

function modelEntryFromTarget(target, kind, route) {
  const entry = {
    provider: String(target.provider || "").trim(),
    model: String(target.model || "").trim(),
    type: kind,
  };
  if (kind === "chat") {
    for (const field of CHAT_SETTING_FIELDS) {
      entry[field] = target[field] ?? CHAT_SETTING_DEFAULTS[field];
    }
  }
  const timeoutMs = Number(route?.timeoutMs);
  entry.timeoutSeconds = Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs !== DEFAULT_MODEL_TIMEOUT_MS[kind]
    ? Math.round(timeoutMs / 1000)
    : 0;
  return entry;
}

function fingerprint(entry) {
  const { name: _name, enabled: _enabled, ...rest } = entry; // 旧配置里可能还带着 enabled，不参与比对
  return JSON.stringify(rest, Object.keys(rest).sort());
}

function describeDifference(entry, base) {
  if (entry.provider !== base.provider) return `@${entry.provider}`;
  if (entry.openaiReasoningEffort && entry.openaiReasoningEffort !== base.openaiReasoningEffort) {
    return `-${entry.openaiReasoningEffort}`;
  }
  if (entry.geminiThinkingLevel && entry.geminiThinkingLevel !== base.geminiThinkingLevel) {
    return `-${entry.geminiThinkingLevel}`;
  }
  if (entry.nativeWebSearch !== base.nativeWebSearch) return entry.nativeWebSearch ? "-联网" : "-不联网";
  if (entry.stream !== base.stream) return entry.stream ? "-流式" : "-非流式";
  if (entry.timeoutSeconds !== base.timeoutSeconds) return `-${entry.timeoutSeconds || "默认超时"}s`;
  return "-2";
}

/**
 * 把三种路由文件合并成模型列表，并返回 路由 ID → 模型名数组 的映射。
 */
export function buildModelsFromRoutes(routeFilesByKind, existingModels = []) {
  const models = Array.isArray(existingModels) ? [...existingModels] : [];
  const keyOf = (entry) => String(entry.name || entry.model || "").trim();
  const usedKeys = new Set(models.map(keyOf));
  const byFingerprint = new Map(models.map((entry) => [fingerprint(entry), entry]));
  const routeMaps = { chat: new Map(), image: new Map(), video: new Map() };

  for (const [kind, data] of Object.entries(routeFilesByKind)) {
    for (const route of data?.routes || []) {
      const routeId = String(route?.id ?? "").trim();
      if (!routeId) continue;
      const names = [];
      for (const target of byPriority(route.targets)) {
        // 旧路由里停用的目标不再迁移：模型没有启用开关，留着也没人引用
        if (!target?.provider || !target?.model || target.enabled === false) continue;
        const candidate = modelEntryFromTarget(target, kind, route);
        let entry = byFingerprint.get(fingerprint(candidate));
        if (!entry) {
          entry = candidate;
          if (usedKeys.has(candidate.model)) {
            const base = models.find((item) => item.model === candidate.model && item.type === kind)
              || models.find((item) => item.model === candidate.model);
            let alias = `${candidate.model}${describeDifference(candidate, base || {})}`;
            for (let counter = 2; usedKeys.has(alias); counter++) {
              alias = `${candidate.model}-${counter}`;
            }
            entry = { name: alias, ...candidate };
          }
          models.push(entry);
          usedKeys.add(keyOf(entry));
          byFingerprint.set(fingerprint(entry), entry);
        }
        if (!names.includes(keyOf(entry))) names.push(keyOf(entry));
      }
      routeMaps[kind].set(routeId, names);
    }
  }

  return { models: models.map(orderModelFields), routeMaps };
}

function orderModelFields(entry) {
  const ordered = {
    provider: entry.provider,
    model: entry.model,
    type: entry.type || "chat",
  };
  if (entry.name) ordered.name = entry.name;
  for (const [key, value] of Object.entries(entry)) {
    if (!(key in ordered) && key !== "name") ordered[key] = value;
  }
  return ordered;
}

function mapReference(routeMap, fallbackMap, reference, warnings, label) {
  if (Array.isArray(reference)) return reference;
  const routeId = String(reference ?? "").trim();
  if (!routeId) return [];
  const names = routeMap.get(routeId) || fallbackMap?.get(routeId);
  if (names) return [...names];
  warnings.push(`${label} 引用的路由“${routeId}”不存在，已清空，请在面板里重新选择模型`);
  return [];
}

/**
 * 迁移单个配置目录（默认目录或某个账号目录）。
 * fallbackRouteMaps 用于账号目录里没有自己的路由文件、却引用了默认路由的情况。
 */
export function migrateScopeDirectory(directory, { fallbackRouteMaps = null, logger = null, stamp = null } = {}) {
  const log = logger || { info() {}, warn() {} };
  const backupStamp = stamp || new Date().toISOString().replace(/[:.]/g, "-");
  const result = { changed: false, routeMaps: null };
  if (!fs.existsSync(directory)) return result;

  const providersPath = path.join(directory, "Providers.yaml");
  const providers = readYaml(providersPath);
  if (isLegacyProviders(providers)) {
    backupFile(directory, "Providers.yaml", backupStamp);
    writeYaml(providersPath, migrateProviders(providers));
    result.changed = true;
    log.info(`[配置迁移] 已把供应商凭据改为 Key 列表：${providersPath}`);
  }

  const routeFiles = {};
  for (const [kind, fileName] of Object.entries(ROUTE_FILES)) {
    const data = readYaml(path.join(directory, fileName));
    if (data) routeFiles[kind] = data;
  }

  const aiPath = path.join(directory, "AI.yaml");
  const mimicPath = path.join(directory, "mimic.yaml");
  const editImagePath = path.join(directory, "EditImage.yaml");
  const ai = readYaml(aiPath);
  const mimic = readYaml(mimicPath);
  const editImage = readYaml(editImagePath);
  const hasLegacyReferences = Boolean(
    (ai && ("utilityRoute" in ai || "geminiRoute" in ai
      || (ai.profiles || []).some((profile) => profile && "route" in profile)))
    || (mimic && ("route" in mimic || (mimic.GroupConfigs || []).some((item) => item && "route" in item)))
    || (editImage && ("imageRoute" in editImage || "gifRoute" in editImage || "videoRoute" in editImage))
  );

  if (Object.keys(routeFiles).length === 0 && !hasLegacyReferences) return result;

  const modelsPath = path.join(directory, "Models.yaml");
  const existingModels = readYaml(modelsPath)?.models || [];
  const { models, routeMaps } = buildModelsFromRoutes(routeFiles, existingModels);
  result.routeMaps = routeMaps;
  const warnings = [];

  if (Object.keys(routeFiles).length > 0) {
    writeYaml(modelsPath, { models });
    log.info(`[配置迁移] 已把 ${Object.keys(routeFiles).length} 个路由文件合并成 ${models.length} 个模型：${modelsPath}`);
  }

  const fallback = fallbackRouteMaps || {};
  if (ai && hasLegacyReferences) {
    backupFile(directory, "AI.yaml", backupStamp);
    const next = { ...ai };
    if ("utilityRoute" in next) {
      next.utilityModels = mapReference(routeMaps.chat, fallback.chat, next.utilityRoute, warnings, "后台辅助模型");
      delete next.utilityRoute;
    }
    if ("geminiRoute" in next) {
      next.geminiModels = mapReference(routeMaps.chat, fallback.chat, next.geminiRoute, warnings, "Gemini 能力模型");
      delete next.geminiRoute;
    }
    next.profiles = (next.profiles || []).map((profile, index) => {
      if (!profile || !("route" in profile)) return profile;
      const { route, ...rest } = profile;
      const label = `触发设定 ${(profile.prefixes || [])[0] || index + 1}`;
      return { ...rest, models: mapReference(routeMaps.chat, fallback.chat, route, warnings, label) };
    });
    writeYaml(aiPath, next);
  }

  if (mimic && ("route" in mimic || (mimic.GroupConfigs || []).some((item) => item && "route" in item))) {
    backupFile(directory, "mimic.yaml", backupStamp);
    const next = { ...mimic };
    if ("route" in next) {
      next.models = mapReference(routeMaps.chat, fallback.chat, next.route, warnings, "伪人");
      delete next.route;
    }
    next.GroupConfigs = (next.GroupConfigs || []).map((item) => {
      if (!item || !("route" in item)) return item;
      const { route, ...rest } = item;
      return { ...rest, models: mapReference(routeMaps.chat, fallback.chat, route, warnings, `伪人群 ${item.group}`) };
    });
    writeYaml(mimicPath, next);
  }

  if (editImage && ("imageRoute" in editImage || "gifRoute" in editImage || "videoRoute" in editImage)) {
    backupFile(directory, "EditImage.yaml", backupStamp);
    const next = { ...editImage };
    const pairs = [
      ["imageRoute", "imageModels", "image", "图片模型"],
      ["gifRoute", "gifModels", "image", "GIF 模型"],
      ["videoRoute", "videoModels", "video", "视频模型"],
    ];
    for (const [oldKey, newKey, kind, label] of pairs) {
      if (!(oldKey in next)) continue;
      next[newKey] = mapReference(routeMaps[kind], fallback[kind], next[oldKey], warnings, label);
      delete next[oldKey];
    }
    writeYaml(editImagePath, next);
  }

  for (const fileName of Object.values(ROUTE_FILES)) {
    const filePath = path.join(directory, fileName);
    if (!fs.existsSync(filePath)) continue;
    backupFile(directory, fileName, backupStamp);
    fs.unlinkSync(filePath);
  }

  for (const warning of warnings) log.warn(`[配置迁移] ${warning}（${directory}）`);
  log.info(`[配置迁移] 旧配置已备份到 ${path.join(directory, BACKUP_DIR, backupStamp)}`);
  result.changed = true;
  return result;
}

/** 迁移插件配置目录：先默认目录，再每个账号目录。 */
export function migrateConfigDirectory(pluginDir, { logger = null } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = migrateScopeDirectory(pluginDir, { logger, stamp });
  const accountsDir = path.join(pluginDir, ACCOUNT_SCOPE_DIR);
  if (!fs.existsSync(accountsDir)) return;
  for (const entry of fs.readdirSync(accountsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    migrateScopeDirectory(path.join(accountsDir, entry.name), {
      fallbackRouteMaps: base.routeMaps,
      logger,
      stamp,
    });
  }
}
