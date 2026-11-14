import Setting from "../setting.js";
import { logger } from "../../../../src/utils/logger.js";
import {
  createRouteExecutionPlan,
  executeRoutePlan,
} from "./providerRouter.js";
import { formatModelList, normalizeModelList } from "./aiModels.js";
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
  const models = normalizeModelList(aiConfig.geminiModels);
  if (models.length === 0) {
    throw new Error(`${purpose}需要 Gemini 模型，但 AI 设定中没有选择“Gemini 能力模型”。`);
  }
  const routeId = formatModelList(models);

  let plan;
  try {
    plan = createRouteExecutionPlan(models, {
      ...scope,
      protocol: "gemini",
    });
  } catch (error) {
    throw new Error(
      `${purpose}无法使用 Gemini 能力模型「${routeId}」：${error.message}`
    );
  }
  if (plan.attempts.length === 0) {
    throw new Error(
      `${purpose}需要 Gemini 协议，但「${routeId}」中没有可用的 Gemini 或 Vertex 模型。`
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

  const outcome = await executeRoutePlan({
    plan,
    routeId,
    log: (message) => logger.warn(message),
    run: (attempt) => {
      const client = clientFactory(attempt.requestConfig);
      return operation({
        client,
        config: attempt.requestConfig,
        attempt,
        aiConfig: resolved.aiConfig,
      });
    },
  });
  if (outcome.ok) return outcome.value;

  throw new Error(
    `${purpose}通过 Gemini 能力模型「${routeId}」请求失败：${outcome.error?.message || "未知错误"}`
  );
}
