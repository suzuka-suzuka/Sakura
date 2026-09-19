import { executeGeminiCapability } from "./geminiCapabilityRoute.js";

export const GEMINI_EMBEDDING_MODEL = "gemini-embedding-2";
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;
export const DEFAULT_EMBEDDING_VERSION = "gemini-embedding-2-768-instructions-v1";

function applyTaskInstruction(contents, taskType) {
  if (!taskType) return contents;
  if (typeof contents !== "string") {
    throw new TypeError("gemini-embedding-2 的任务指令只能用于文本向量");
  }

  switch (String(taskType).trim().toUpperCase()) {
    case "RETRIEVAL_QUERY":
      return `task: search result | query: ${contents}`;
    case "RETRIEVAL_DOCUMENT":
      return `title: none | text: ${contents}`;
    default:
      throw new Error(`gemini-embedding-2 不支持任务类型「${taskType}」`);
  }
}

export function prepareEmbeddingRequest(contents, options = {}) {
  const {
    taskType = "",
    outputDimensionality = DEFAULT_EMBEDDING_DIMENSIONS,
  } = options;
  const config = { outputDimensionality };

  return {
    contents: applyTaskInstruction(contents, taskType),
    config,
  };
}

export async function generateContentEmbedding(contents, options = {}) {
  const {
    selfId = null,
    taskType = "",
    purpose = "向量生成",
    outputDimensionality = DEFAULT_EMBEDDING_DIMENSIONS,
  } = options;
  const request = prepareEmbeddingRequest(contents, {
    taskType,
    outputDimensionality,
  });

  return executeGeminiCapability({
    selfId,
    purpose,
    operation: async ({ client }) => {
      const result = await client.models.embedContent({
        model: GEMINI_EMBEDDING_MODEL,
        contents: request.contents,
        config: request.config,
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
    outputDimensionality = DEFAULT_EMBEDDING_DIMENSIONS,
  } = options;
  return generateContentEmbedding(content, {
    selfId,
    taskType,
    purpose,
    outputDimensionality,
  });
}
