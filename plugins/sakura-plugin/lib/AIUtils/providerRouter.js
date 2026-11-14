import Setting from "../setting.js";
import {
  formatModelList,
  modelKey,
  modelListKey,
  modelTimeoutMs,
  normalizeModelList,
  providerCredentials,
  providerName,
} from "./aiModels.js";

const scheduleCursors = new Map();
export const CREDENTIAL_SCHEDULING_STRATEGY = "priority_weighted";

export function isRequestConfigComplete(config, expectedProtocol) {
  if (!config || config.channelType !== expectedProtocol || !config.model) {
    return false;
  }

  if (expectedProtocol === "gemini" && config.vertex === true) {
    return Boolean(config.serviceAccountRef);
  }

  return Boolean(config.apiKey);
}

export function prioritizeRouteAttempt(plan, preferredAttempt) {
  if (!plan || !Array.isArray(plan.attempts) || !preferredAttempt) {
    return plan;
  }

  const remainingAttempts = plan.attempts.filter((attempt) => attempt !== preferredAttempt);
  return {
    ...plan,
    attempts: [preferredAttempt, ...remainingAttempts],
  };
}

function redactRouterError(error, credential) {
  let message = error?.message || String(error || "未知错误");
  const secrets = [credential?.apiKey].filter(
    (value) => typeof value === "string" && value.length > 0
  );

  for (const secret of secrets) {
    message = message.split(secret).join("[REDACTED]");
  }

  return message
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:key|api_key)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function routerLogValue(value) {
  return JSON.stringify(String(value ?? ""));
}

export function formatRouteAttemptFailure({
  routeId,
  attempt,
  error,
  attemptNumber,
  totalAttempts,
  nextAttempt = null,
  retryDelayMs = 0,
}) {
  const action = nextAttempt ? "回退" : "尝试耗尽";
  const status = error?.status == null ? "unknown" : String(error.status);
  const fields = [
    "[AI Router] 调用失败",
    `route=${routerLogValue(routeId)}`,
    `attempt=${attemptNumber}/${totalAttempts}`,
    `target=${routerLogValue(attempt?.target?.id)}`,
    `provider=${routerLogValue(attempt?.provider?.id)}`,
    `credential=${routerLogValue(attempt?.credential?.id)}`,
    `model=${routerLogValue(attempt?.requestConfig?.model)}`,
    `status=${status}`,
    `action=${action}`,
  ];

  if (nextAttempt) {
    fields.push(
      `nextTarget=${routerLogValue(nextAttempt.target?.id)}`,
      `nextProvider=${routerLogValue(nextAttempt.provider?.id)}`,
      `nextCredential=${routerLogValue(nextAttempt.credential?.id)}`,
      `nextModel=${routerLogValue(nextAttempt.requestConfig?.model)}`,
      `delayMs=${Math.max(0, Number(retryDelayMs) || 0)}`
    );
  }

  fields.push(`error=${routerLogValue(redactRouterError(error, attempt?.credential))}`);
  return fields.join(" ");
}

function positiveInteger(value, fallback = 1) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function priorityOf(item) {
  const priority = Number(item?.priority);
  return Number.isFinite(priority) ? priority : 0;
}

function rotate(items, cursorKey) {
  if (items.length < 2) return [...items];
  const cursor = scheduleCursors.get(cursorKey) || 0;
  const start = cursor % items.length;
  scheduleCursors.set(cursorKey, (start + 1) % items.length);
  return [...items.slice(start), ...items.slice(0, start)];
}

function weightedOrder(items, cursorKey) {
  if (items.length < 2) return [...items];
  const wheel = items.flatMap((item) =>
    Array.from({ length: Math.min(positiveInteger(item.weight), 100) }, () => item)
  );
  const seen = new Set();
  const ordered = [];

  for (const item of rotate(wheel, cursorKey)) {
    if (seen.has(item)) continue;
    seen.add(item);
    ordered.push(item);
  }
  return ordered;
}

export function orderScheduledItems(items, strategy, cursorKey) {
  const enabled = items.filter((item) => item?.enabled !== false);
  if (enabled.length < 2) return enabled;
  if (strategy === "round_robin") return rotate(enabled, cursorKey);
  if (strategy === "weighted_round_robin") return weightedOrder(enabled, cursorKey);

  const groups = new Map();
  for (const item of enabled) {
    const priority = priorityOf(item);
    if (!groups.has(priority)) groups.set(priority, []);
    groups.get(priority).push(item);
  }

  return [...groups.keys()]
    .sort((a, b) => b - a)
    .flatMap((priority) => {
      const group = groups.get(priority);
      return strategy === "priority_weighted"
        ? weightedOrder(group, `${cursorKey}:priority:${priority}`)
        : group;
    });
}

function configuredNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function resolveGenerationSettings(_route, target) {
  const openaiReasoningEffort = target.openaiReasoningEffort && target.openaiReasoningEffort !== "default"
    ? target.openaiReasoningEffort
    : undefined;

  let geminiThinkingLevel;
  let geminiThinkingBudget;
  const explicitBudget = Number(target.geminiThinkingBudget);
  if (Number.isInteger(explicitBudget) && explicitBudget >= -1) {
    geminiThinkingBudget = explicitBudget;
  } else {
    const targetLevel = target.geminiThinkingLevel || "default";
    if (targetLevel === "off") {
      geminiThinkingBudget = 0;
    } else if (targetLevel !== "default") {
      geminiThinkingLevel = targetLevel;
    }
  }

  return {
    temperature: configuredNumber(target.temperature),
    topP: configuredNumber(target.topP),
    openaiEnableThinking: target.openaiEnableThinking === true,
    openaiReasoningEffort,
    stream: target.stream === true,
    geminiThinkingLevel,
    geminiThinkingBudget,
  };
}

const ROUTE_KIND_BY_MODULE = {
  Routes: "chat",
  ImageRoutes: "image",
  VideoRoutes: "video",
};
const MODEL_KIND_LABELS = { chat: "对话", image: "图片", video: "视频" };
const ROUTE_RETRY_DELAY_MS = 1000;
const MAX_ROUTE_ATTEMPTS = 8;

function resolveKind(options = {}) {
  if (options.kind) return options.kind;
  if (options.routeModule) return ROUTE_KIND_BY_MODULE[options.routeModule] || "chat";
  return "chat";
}

function scopeOptions(options) {
  return options.selfId == null ? {} : { selfId: options.selfId };
}

function loadModelConfig(options) {
  const scope = scopeOptions(options);
  const providers = Setting.getConfig("Providers", scope)?.providers || [];
  const models = Setting.getConfig("Models", scope)?.models || [];
  return {
    providerMap: new Map(providers.map((provider) => [providerName(provider), provider])),
    models,
  };
}

function findModelEntry(models, key, kind) {
  return models.find((entry) => modelKey(entry) === key && (entry.type || "chat") === kind)
    || null;
}

function buildRequestConfig(target, provider, credential) {
  return {
    name: target.id,
    channelType: provider.protocol,
    baseURL: provider.baseURL,
    vertex: provider.vertex === true,
    apiKey: credential.apiKey,
    serviceAccountRef: credential.serviceAccountRef,
    model: target.model,
    ...resolveGenerationSettings(null, target),
    nativeWebSearch: target.nativeWebSearch === true,
    providerId: provider.id,
    credentialId: credential.id,
    targetId: target.id,
    timeoutMs: modelTimeoutMs(target),
  };
}

/**
 * 根据有序模型列表生成一次请求的执行计划。
 * reference 是模型名（或别名）数组；兼容只传一个字符串。
 * 按列表顺序逐个尝试，每个模型内部轮流使用供应商的 Key。
 */
export function createRouteExecutionPlan(reference, options = {}) {
  const kind = resolveKind(options);
  const scopeKey = options.selfId == null ? "default" : String(options.selfId);
  const protocol = String(options.protocol || "").trim().toLowerCase();
  const names = normalizeModelList(reference);
  const kindLabel = MODEL_KIND_LABELS[kind] || "";

  if (names.length === 0) {
    const error = new Error(`没有选择${kindLabel}模型`);
    error.code = "ROUTE_NOT_FOUND";
    error.routeId = "";
    throw error;
  }

  const { providerMap, models } = loadModelConfig(options);
  const route = {
    id: formatModelList(names),
    key: modelListKey(names),
    kind,
    models: names,
    retryDelayMs: ROUTE_RETRY_DELAY_MS,
  };

  const missing = [];
  const attempts = [];
  for (const name of names) {
    const entry = findModelEntry(models, name, kind);
    if (!entry) {
      missing.push(name);
      continue;
    }
    const provider = providerMap.get(entry.provider);
    if (!provider) {
      logger.warn(`[AI Router] 模型 ${name} 引用了不存在的供应商 ${entry.provider}`);
      continue;
    }
    const runtimeProvider = { ...provider, id: providerName(provider) };
    if (protocol && runtimeProvider.protocol !== protocol) continue;

    const target = { ...entry, id: name };
    if (options.targetMatches && !options.targetMatches({ route, target, provider: runtimeProvider })) {
      continue;
    }

    const credentials = orderScheduledItems(
      providerCredentials(runtimeProvider),
      "round_robin",
      `scope:${scopeKey}:provider:${runtimeProvider.id}`
    );
    for (const credential of credentials) {
      attempts.push({
        route,
        target,
        provider: runtimeProvider,
        credential,
        requestConfig: buildRequestConfig(target, runtimeProvider, credential),
      });
    }
  }

  if (missing.length > 0) {
    logger.warn(`[AI Router] 未找到${kindLabel}模型：${missing.join("、")}，已跳过`);
  }
  if (missing.length === names.length) {
    const error = new Error(`未找到${kindLabel}模型：${missing.join("、")}`);
    error.code = "ROUTE_NOT_FOUND";
    error.routeId = route.id;
    throw error;
  }

  return { route, attempts: attempts.slice(0, MAX_ROUTE_ATTEMPTS) };
}

/**
 * 解析命令里临时指定的模型：可以是模型名/别名，也可以是 grok、gpt 这类简写
 * （简写会展开成配置里所有匹配的同类模型）。返回模型名数组。
 */
export function resolveRouteReference(routeReference, options = {}) {
  const reference = String(Array.isArray(routeReference) ? "" : routeReference || "").trim();
  if (Array.isArray(routeReference)) return normalizeModelList(routeReference);
  if (!reference) return [];

  const kind = resolveKind(options);
  const { providerMap, models } = loadModelConfig(options);
  const sameKind = models.filter((entry) => (entry.type || "chat") === kind);
  const exact = sameKind.find((entry) => modelKey(entry) === reference)
    || sameKind.find((entry) => modelKey(entry).toLowerCase() === reference.toLowerCase());
  if (exact) return [modelKey(exact)];
  if (typeof options.targetMatches !== "function") return [reference];

  const matched = sameKind.filter((entry) => {
    const provider = providerMap.get(entry.provider);
    if (!provider) return false;
    return options.targetMatches({
      route: null,
      target: { ...entry, id: modelKey(entry) },
      provider: { ...provider, id: providerName(provider) },
    });
  });
  return matched.length > 0 ? matched.map(modelKey) : [reference];
}

export function resolveRouteTarget(reference, options = {}) {
  return createRouteExecutionPlan(reference, options).attempts[0] || null;
}
