import Setting from "../setting.js";
import { resolveRouteTarget } from "./providerRouter.js";
import { createGeminiClient } from "./vertexAuth.js";

export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-2";
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;
const EMBEDDING_PROTOCOL = "gemini";

export function resolveEmbeddingConfig(selfId = null, purpose = "向量检索") {
  const scope = selfId == null ? {} : { selfId };
  const toolsRoute = Setting.getConfig("AI", scope)?.toolsRoute;
  if (!toolsRoute) {
    throw new Error(`${purpose}需要嵌入模型，但 AI 设定里没有配置工具路由`);
  }

  const resolved = resolveRouteTarget(toolsRoute, {
    ...scope,
    protocol: EMBEDDING_PROTOCOL,
  });
  if (!resolved || resolved.provider.protocol !== EMBEDDING_PROTOCOL) {
    throw new Error(
      `${purpose}需要嵌入模型，目前只支持 Gemini 协议，而工具路由「${toolsRoute}」里没有可用的 Gemini 目标，请在该路由下加一个 Gemini 供应商的目标`
    );
  }
  return resolved.requestConfig;
}

export function createEmbeddingClient(selfId = null, purpose) {
  return createGeminiClient(resolveEmbeddingConfig(selfId, purpose));
}

export async function generateTextEmbedding(text, options = {}) {
  const content = String(text || "").trim();
  if (!content) throw new Error("不能为空文本生成向量");

  const {
    selfId = null,
    taskType = "",
    purpose,
    model = DEFAULT_EMBEDDING_MODEL,
    outputDimensionality = DEFAULT_EMBEDDING_DIMENSIONS,
  } = options;
  const client = createEmbeddingClient(selfId, purpose);
  const config = { outputDimensionality };
  if (taskType) config.taskType = taskType;

  const result = await client.models.embedContent({
    model,
    contents: content,
    config,
  });
  const values = result?.embeddings?.[0]?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("向量模型未返回有效结果");
  }
  return values;
}
