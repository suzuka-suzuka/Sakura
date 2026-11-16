// 工具结果可以附带图片。图片挂在对应工具调用的 functionResponse.parts 上：
// Gemini 原样作为 FunctionResponsePart 发送，OpenAI 兼容协议转成 tool 消息里的 image_url。
const TOOL_MEDIA_RESULT = "sakura.tool-media-result.v1";

export function createToolMediaResult(response, mediaParts = []) {
  return {
    kind: TOOL_MEDIA_RESULT,
    response,
    mediaParts,
  };
}

export function splitToolMediaResult(rawResult) {
  if (
    !rawResult ||
    rawResult.kind !== TOOL_MEDIA_RESULT ||
    !Array.isArray(rawResult.mediaParts)
  ) {
    return { response: rawResult, mediaParts: [] };
  }

  return {
    response: rawResult.response,
    mediaParts: rawResult.mediaParts
      .filter((part) => part?.inlineData?.data && part.inlineData.mimeType)
      .map(({ inlineData }) => ({
        inlineData: { mimeType: inlineData.mimeType, data: inlineData.data },
      })),
  };
}

export function buildToolCallbackPayload(executedResults = []) {
  const functionResponseParts = executedResults
    .map((result) => result?.functionResponsePart)
    .filter(Boolean);

  return {
    historyContents: functionResponseParts.length > 0
      ? [{ role: "function", parts: functionResponseParts }]
      : [],
  };
}

function withoutResponseMedia(part) {
  if (!Array.isArray(part?.functionResponse?.parts)) return part;
  const { parts: _media, ...functionResponse } = part.functionResponse;
  return { ...part, functionResponse };
}

/**
 * 本轮结束后去掉只在本轮有效的图片，避免写进对话历史、在后续每轮重复发送：
 * 用户消息里不该保留的部分（由 shouldKeepPart 决定），以及工具结果附带的图片。
 */
export function stripEphemeralParts(
  history = [],
  shouldKeepPart = (part) => !part?.inlineData
) {
  if (!Array.isArray(history)) return history;

  for (let index = history.length - 1; index >= 0; index--) {
    const item = history[index];
    if (!Array.isArray(item?.parts)) continue;

    if (item.role === "function") {
      if (item.parts.some((part) => Array.isArray(part?.functionResponse?.parts))) {
        history[index] = { ...item, parts: item.parts.map(withoutResponseMedia) };
      }
      continue;
    }

    if (item.role !== "user") continue;
    const persistentParts = item.parts.filter(shouldKeepPart);
    if (persistentParts.length === 0) {
      history.splice(index, 1);
    } else if (persistentParts.length !== item.parts.length) {
      history[index] = { ...item, parts: persistentParts };
    }
  }

  return history;
}
