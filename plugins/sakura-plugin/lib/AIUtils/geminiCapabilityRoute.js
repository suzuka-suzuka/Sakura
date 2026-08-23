import Setting from "../setting.js";
import { logger } from "../../../../src/utils/logger.js";
import {
  createRouteExecutionPlan,
  formatRouteAttemptFailure,
} from "./providerRouter.js";
import { createGeminiClient } from "./vertexAuth.js";

function routeScope(selfId) {
  return selfId == null ? {} : { selfId };
}

export function resolveGeminiCapabilityPlan(
  selfId = null,
  purpose = "Gemini 能力"
) {
  const scope = routeScope(selfId);
  const aiConfig = Setting.getConfig("AI", scope) || {};
  const routeId = String(aiConfig.geminiRoute || "").trim();
  if (!routeId) {
    throw new Error(`${purpose}需要 Gemini 能力路由，但 AI 设定中没有配置 geminiRoute。`);
  }

  let plan;
  try {
    plan = createRouteExecutionPlan(routeId, {
      ...scope,
      protocol: "gemini",
    });
  } catch (error) {
    throw new Error(
      `${purpose}无法使用 Gemini 能力路由「${routeId}」：${error.message}`
    );
  }
  if (plan.attempts.length === 0) {
    throw new Error(
      `${purpose}需要 Gemini 协议，但 Gemini 能力路由「${routeId}」中没有可用的 Gemini 或 Vertex 目标。`
    );
  }

  return { aiConfig, routeId, plan };
}

export async function executeGeminiCapability({
  selfId = null,
  purpose = "Gemini 能力",
  context = null,
  clientFactory = createGeminiClient,
  operation,
}) {
  if (typeof operation !== "function") {
    throw new TypeError("executeGeminiCapability 需要 operation 回调。");
  }
  if (typeof clientFactory !== "function") {
    throw new TypeError("executeGeminiCapability 需要有效的 clientFactory。");
  }

  const resolved = context || resolveGeminiCapabilityPlan(selfId, purpose);
  const { routeId, plan } = resolved;
  let lastError = null;

  for (let index = 0; index < plan.attempts.length; index++) {
    const attempt = plan.attempts[index];
    const nextAttempt = plan.attempts[index + 1] || null;

    try {
      const client = clientFactory(attempt.requestConfig);
      return await operation({
        client,
        config: attempt.requestConfig,
        attempt,
        aiConfig: resolved.aiConfig,
      });
    } catch (error) {
      lastError = error;
      logger.warn(formatRouteAttemptFailure({
        routeId,
        attempt,
        error,
        attemptNumber: index + 1,
        totalAttempts: plan.attempts.length,
        nextAttempt,
        retryDelayMs: plan.route.retryDelayMs,
      }));
    }

    if (nextAttempt && plan.route.retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, plan.route.retryDelayMs));
    }
  }

  throw new Error(
    `${purpose}通过 Gemini 能力路由「${routeId}」请求失败：${lastError?.message || "未知错误"}`
  );
}
