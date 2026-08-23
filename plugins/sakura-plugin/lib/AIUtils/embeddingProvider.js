import { executeGeminiCapability } from "./geminiCapabilityRoute.js";

export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-2";
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;

export async function generateContentEmbedding(contents, options = {}) {
  const {
    selfId = null,
    taskType = "",
    purpose = "向量生成",
    model = DEFAULT_EMBEDDING_MODEL,
    outputDimensionality = DEFAULT_EMBEDDING_DIMENSIONS,
  } = options;
  const config = { outputDimensionality };
  if (taskType) config.taskType = taskType;

  return executeGeminiCapability({
    selfId,
    purpose,
    operation: async ({ client }) => {
      const result = await client.models.embedContent({
        model,
        contents,
        config,
      });
      const values = result?.embeddings?.[0]?.values;
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error("向量模型未返回有效结果");
      }
      return values;
    },
  });
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
  return generateContentEmbedding(content, {
    selfId,
    taskType,
    purpose,
    model,
    outputDimensionality,
  });
}
