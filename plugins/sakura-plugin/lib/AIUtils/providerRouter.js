import { createHash } from "node:crypto";
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

const FAILURE_ACTION_LABELS = {
  next: "回退",
  next_model: "跳过该模型其余 Key",
  next_provider: "跳过该供应商",
  abort: "终止",
};

export function formatRouteAttemptFailure({
  routeId,
  attempt,
  error,
  attemptNumber,
  totalAttempts,
  nextAttempt = null,
  retryDelayMs = 0,
  failure = null,
}) {
  const action = failure?.action === "abort"
    ? FAILURE_ACTION_LABELS.abort
    : nextAttempt
      ? FAILURE_ACTION_LABELS[failure?.action] || FAILURE_ACTION_LABELS.next
      : "尝试耗尽";
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

  if (failure?.reason) fields.push(`reason=${routerLogValue(failure.reason)}`);
  if (failure?.cooldown) {
    fields.push(
      `cooldown=${failure.cooldown.scope}:${Math.round(failure.cooldown.ms / 1000)}s`
    );
  }

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
// 单次请求的尝试预算：保证列表里每个模型至少轮到一次，剩余名额按列表顺序分给前面模型的其他 Key。
const MAX_ROUTE_ATTEMPTS = 8;

// ---- 失败分类与冷却 ----
// next：换下一个尝试；next_model：同一模型的其余 Key 不再试（请求本身有问题，换 Key 也一样）；
// next_provider：同一供应商的其余尝试都跳过（超时，再试只会继续干等）；abort：确定性错误，直接结束。
export const ROUTE_FAILURE_ACTIONS = Object.freeze({
  NEXT: "next",
  NEXT_MODEL: "next_model",
  NEXT_PROVIDER: "next_provider",
  ABORT: "abort",
});

const CREDENTIAL_COOLDOWN_MS = 10 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;
const PROVIDER_COOLDOWN_MS = 2 * 60 * 1000;
const COOLDOWN_MAX_ENTRIES = 500;

// 进程内的短期状态：重启即清空，不需要持久化。
const routeCooldowns = new Map();

const CREDENTIAL_ERROR_PATTERN =
  /api[\s_-]?key|unauthori[sz]ed|invalid[\s_-]?(?:token|credential|authentication)|authentication|permission[\s_-]?denied|insufficient[\s_-]?(?:quota|balance)|billing|余额|额度|令牌/i;
const QUOTA_ERROR_PATTERN =
  /insufficient[\s_-]?(?:quota|balance)|quota|billing|余额|额度|exceeded your current/i;
const TIMEOUT_ERROR_NAMES = new Set(["TimeoutError", "APIConnectionTimeoutError"]);
const TIMEOUT_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** 给确定性的失败打上回退动作，供各协议实现返回或抛出。 */
export function createRouteFailure(message, action = ROUTE_FAILURE_ACTIONS.NEXT, extra = {}) {
  const error = new Error(message);
  error.routeAction = action;
  return Object.assign(error, extra);
}

function isTimeoutFailure(error, status) {
  if (error?.timedOut === true) return true;
  if (status === 408 || status === 504 || status === 524) return true;
  const name = error?.originalName || error?.name;
  if (TIMEOUT_ERROR_NAMES.has(name)) return true;
  const code = error?.code || error?.cause?.code;
  if (TIMEOUT_ERROR_CODES.has(code)) return true;
  // 4xx 的报错正文里出现 timeout 多半是参数名，不当作超时。
  if (status != null && status < 500) return false;
  return /timed?[\s_-]?out|超时/i.test(String(error?.message || ""));
}

/** 根据错误判断下一步怎么回退、要不要让 Key 或供应商冷却一段时间。 */
export function classifyRouteFailure(error) {
  if (error?.routeAction) {
    return { action: error.routeAction, reason: error.routeReason || "", cooldown: null };
  }

  const status = Number(error?.status) || null;
  const message = String(error?.message || "");

  if (isTimeoutFailure(error, status)) {
    return {
      action: ROUTE_FAILURE_ACTIONS.NEXT_PROVIDER,
      reason: "超时",
      cooldown: { scope: "provider", ms: PROVIDER_COOLDOWN_MS },
    };
  }

  if (status === 429) {
    const quota = QUOTA_ERROR_PATTERN.test(message);
    return {
      action: ROUTE_FAILURE_ACTIONS.NEXT,
      reason: quota ? "额度耗尽" : "限流",
      cooldown: {
        scope: "credential",
        ms: quota ? CREDENTIAL_COOLDOWN_MS : RATE_LIMIT_COOLDOWN_MS,
      },
    };
  }

  // Gemini 的无效 Key 是 400，部分中转站也会用 400 报鉴权或余额问题。
  if (
    status === 401 ||
    status === 402 ||
    status === 403 ||
    (status === 400 && CREDENTIAL_ERROR_PATTERN.test(message))
  ) {
    return {
      action: ROUTE_FAILURE_ACTIONS.NEXT,
      reason: "Key 不可用",
      cooldown: { scope: "credential", ms: CREDENTIAL_COOLDOWN_MS },
    };
  }

  if (status === 400 || status === 413 || status === 422) {
    return { action: ROUTE_FAILURE_ACTIONS.NEXT_MODEL, reason: "请求被拒绝", cooldown: null };
  }

  return { action: ROUTE_FAILURE_ACTIONS.NEXT, reason: "", cooldown: null };
}

function secretFingerprint(value) {
  const text = String(value || "");
  return text ? createHash("sha256").update(text).digest("hex").slice(0, 16) : "none";
}

function providerCooldownKey(attempt) {
  const provider = attempt?.provider || {};
  return `provider:${provider.id || ""}:${provider.baseURL || ""}`;
}

function credentialCooldownKey(attempt) {
  const credential = attempt?.credential || {};
  return `${providerCooldownKey(attempt)}:credential:${secretFingerprint(
    credential.apiKey || credential.serviceAccountRef
  )}`;
}

function remainingCooldown(key, now) {
  const entry = routeCooldowns.get(key);
  if (!entry) return 0;
  if (entry.until <= now) {
    routeCooldowns.delete(key);
    return 0;
  }
  return entry.until - now;
}

/** 该尝试还要冷却多久（毫秒），0 表示可用。 */
export function routeAttemptCooldownMs(attempt, now = Date.now()) {
  return Math.max(
    remainingCooldown(credentialCooldownKey(attempt), now),
    remainingCooldown(providerCooldownKey(attempt), now)
  );
}

function setCooldown(key, ms, now) {
  if (!(ms > 0)) return;
  if (routeCooldowns.size >= COOLDOWN_MAX_ENTRIES && !routeCooldowns.has(key)) {
    for (const [existingKey, entry] of routeCooldowns) {
      if (entry.until <= now) routeCooldowns.delete(existingKey);
    }
    if (routeCooldowns.size >= COOLDOWN_MAX_ENTRIES) {
      routeCooldowns.delete(routeCooldowns.keys().next().value);
    }
  }
  const current = routeCooldowns.get(key);
  const until = now + ms;
  if (!current || current.until < until) routeCooldowns.set(key, { until });
}

export function recordRouteFailure(attempt, failure, now = Date.now()) {
  const cooldown = failure?.cooldown;
  if (!cooldown) return;
  const key = cooldown.scope === "provider"
    ? providerCooldownKey(attempt)
    : credentialCooldownKey(attempt);
  setCooldown(key, cooldown.ms, now);
}

export function recordRouteSuccess(attempt) {
  routeCooldowns.delete(credentialCooldownKey(attempt));
  routeCooldowns.delete(providerCooldownKey(attempt));
}

export function resetRouteCooldowns() {
  routeCooldowns.clear();
}

/** 稳定地把冷却中的尝试挪到末尾：都在冷却时仍会按原顺序尝试，不会直接报错。 */
export function orderAttemptsByCooldown(attempts = [], now = Date.now()) {
  const ready = [];
  const cooling = [];
  for (const attempt of attempts) {
    (routeAttemptCooldownMs(attempt, now) > 0 ? cooling : ready).push(attempt);
  }
  return cooling.length > 0 ? [...ready, ...cooling] : [...attempts];
}

function attemptTargetKey(attempt) {
  return `${attempt?.provider?.id || ""}\u0000${attempt?.target?.id || ""}`;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 按计划逐个尝试，统一处理失败分类、冷却和日志。
 * run(attempt) 成功时返回结果，失败时抛错。
 * 返回 { ok: true, value, attempt } 或 { ok: false, error, attempt }。
 */
export async function executeRoutePlan({
  plan,
  routeId = plan?.route?.id,
  run,
  sleep = defaultSleep,
  log = (message) => logger.warn(message),
}) {
  const now = Date.now();
  const attempts = orderAttemptsByCooldown(plan?.attempts || [], now);
  const cooling = attempts.filter((attempt) => routeAttemptCooldownMs(attempt, now) > 0);
  if (cooling.length > 0 && cooling.length < attempts.length) {
    logger.info(
      `[AI Router] route=${routerLogValue(routeId)} 冷却中的尝试已后移：${cooling
        .map((attempt) => `${attempt.target?.id}/${attempt.credential?.id}(${Math.ceil(
          routeAttemptCooldownMs(attempt, now) / 1000
        )}s)`)
        .join("、")}`
    );
  }

  const skippedTargets = new Set();
  const skippedProviders = new Set();
  const isSkipped = (attempt) =>
    skippedTargets.has(attemptTargetKey(attempt)) ||
    skippedProviders.has(attempt?.provider?.id);
  const retryDelayMs = Math.max(0, Number(plan?.route?.retryDelayMs) || 0);

  let lastError = null;
  let lastAttempt = null;
  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index];
    if (isSkipped(attempt)) continue;

    try {
      const value = await run(attempt);
      recordRouteSuccess(attempt);
      return { ok: true, value, attempt };
    } catch (error) {
      lastError = error;
      lastAttempt = attempt;
    }

    const failure = classifyRouteFailure(lastError);
    recordRouteFailure(attempt, failure);
    if (failure.action === ROUTE_FAILURE_ACTIONS.NEXT_MODEL) {
      skippedTargets.add(attemptTargetKey(attempt));
    } else if (failure.action === ROUTE_FAILURE_ACTIONS.NEXT_PROVIDER) {
      skippedProviders.add(attempt.provider?.id);
    }

    const nextAttempt = failure.action === ROUTE_FAILURE_ACTIONS.ABORT
      ? null
      : attempts.slice(index + 1).find((candidate) => !isSkipped(candidate)) || null;
    log(formatRouteAttemptFailure({
      routeId,
      attempt,
      error: lastError,
      attemptNumber: index + 1,
      totalAttempts: attempts.length,
      nextAttempt,
      retryDelayMs,
      failure,
    }));

    if (!nextAttempt) break;
    // 换到别的供应商时没必要等待；同一供应商换 Key 才稍等一下，给限流留点余地。
    if (retryDelayMs > 0 && nextAttempt.provider?.id === attempt.provider?.id) {
      await sleep(retryDelayMs);
    }
  }

  return { ok: false, error: lastError, attempt: lastAttempt };
}

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
  const candidates = [];
  const now = Date.now();
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
    const modelAttempts = credentials.map((credential) => ({
      route,
      target,
      provider: runtimeProvider,
      credential,
      requestConfig: buildRequestConfig(target, runtimeProvider, credential),
    }));
    if (modelAttempts.length > 0) {
      // 冷却中的 Key 排到该模型的末尾，预算不够时优先用掉的是可用的 Key。
      candidates.push(orderAttemptsByCooldown(modelAttempts, now));
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

  return { route, attempts: allocateRouteAttempts(candidates) };
}

/**
 * 在尝试预算内分配名额：每个模型先保底一次，剩余名额按列表顺序补给前面模型的其他 Key。
 * 输出仍按模型顺序排列（同一模型的 Key 连在一起）。
 */
function allocateRouteAttempts(candidates, budget = MAX_ROUTE_ATTEMPTS) {
  const total = Math.max(budget, candidates.length);
  const counts = candidates.map((modelAttempts) => Math.min(1, modelAttempts.length));
  let remaining = total - counts.reduce((sum, count) => sum + count, 0);

  for (let index = 0; index < candidates.length && remaining > 0; index++) {
    const extra = Math.min(remaining, candidates[index].length - counts[index]);
    counts[index] += extra;
    remaining -= extra;
  }

  return candidates.flatMap((modelAttempts, index) => modelAttempts.slice(0, counts[index]));
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
