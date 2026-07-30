/**
 * 聚合 @google/genai 的 GenerateContentResponse 增量。
 *
 * SDK 的 chunk.text 会过滤 thought，但会在遇到函数调用等非文本 part 时向
 * console 写警告。这里直接读取 parts：既不泄露思考正文，也保留工具调用、
 * thoughtSignature 和后续历史需要的 rawParts。
 */
export async function collectGeminiStream(
  rawStream,
  {
    startedAt = Date.now(),
    now = Date.now,
    onDiagnostic = () => {},
  } = {}
) {
  if (!rawStream || typeof rawStream[Symbol.asyncIterator] !== "function") {
    throw new Error("Gemini 流式请求未返回可迭代的响应");
  }

  let chunkCount = 0;
  let firstChunkMs = null;
  let firstReasoningMs = null;
  let firstTextMs = null;
  let reasoningChars = 0;
  let textChars = 0;
  let finishReason = "";
  let finishMessage = "";
  let usage = null;
  let promptFeedback = null;
  let sawCandidate = false;
  let extractedText = "";
  const rawParts = [];
  const functionCalls = [];

  const currentStats = () => ({
    chunkCount,
    firstChunkMs,
    firstReasoningMs,
    firstTextMs,
    reasoningChars,
    textChars,
    finishReason,
  });

  try {
    for await (const chunk of rawStream) {
      chunkCount += 1;
      const elapsedMs = now() - startedAt;
      if (firstChunkMs == null) {
        firstChunkMs = elapsedMs;
        onDiagnostic("first_chunk", { elapsedMs });
      }
      if (chunk?.usageMetadata) usage = chunk.usageMetadata;
      if (chunk?.promptFeedback) promptFeedback = chunk.promptFeedback;

      const candidate = chunk?.candidates?.[0];
      if (!candidate) continue;
      sawCandidate = true;
      if (candidate.finishReason) finishReason = String(candidate.finishReason);
      if (candidate.finishMessage) finishMessage = String(candidate.finishMessage);

      const parts = Array.isArray(candidate.content?.parts)
        ? candidate.content.parts
        : [];
      rawParts.push(...parts);
      for (const part of parts) {
        if (part?.functionCall) functionCalls.push(part.functionCall);
        if (typeof part?.text !== "string" || !part.text) continue;

        if (part.thought === true) {
          reasoningChars += part.text.length;
          if (firstReasoningMs == null) {
            firstReasoningMs = elapsedMs;
            onDiagnostic("first_reasoning", { elapsedMs });
          }
        } else {
          extractedText += part.text;
          textChars += part.text.length;
          if (firstTextMs == null) {
            firstTextMs = elapsedMs;
            onDiagnostic("first_text", { elapsedMs });
          }
        }
      }
    }
  } catch (error) {
    const streamError =
      error instanceof Error ? error : new Error(String(error || "流式响应中断"));
    streamError.geminiStreamStats = currentStats();
    throw streamError;
  }

  return {
    ...currentStats(),
    finishMessage,
    usage,
    promptFeedback,
    sawCandidate,
    extractedText,
    functionCalls,
    rawParts,
  };
}

