import { ThinkingLevel } from "@google/genai";
import OpenAI from "openai";
import { buildGroupPrompt } from "./GroupContext.js";
import { getToolsSchema } from "./tools/tools.js";
import { mcpManager } from "./MCPManager.js";
import {
  createRouteExecutionPlan,
  createRouteFailure,
  executeRoutePlan,
  isRequestConfigComplete,
  prioritizeRouteAttempt,
  ROUTE_FAILURE_ACTIONS,
  upstreamRetryDelayMs,
} from "./providerRouter.js";
import { formatModelList, modelListKey } from "./aiModels.js";
import { createGeminiClient } from "./vertexAuth.js";
import { prepareHistoryForGemini } from "./toolCallProtocol.js";
import { buildGeminiToolConfig } from "./geminiToolConfig.js";
import {
  buildOpenAIToolContent,
  buildOpenAIUserContent,
  processQueryParts,
} from "./messageParts.js";
import { buildOpenAICompatibleWebSearchTool } from "./openAIWebSearchTool.js";
import { collectGeminiStream } from "./geminiStream.js";
import { buildCurrentTimeLine } from "./currentTime.js";

const OPENAI_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const GEMINI_THINKING_LEVELS = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};
// Gemini 因这些原因中止时，同一模型换 Key 也会被拦，直接换下一个模型。
const GEMINI_CONTENT_FINISH_REASONS = new Set([
  "SAFETY",
  "PROHIBITED_CONTENT",
  "BLOCKLIST",
  "SPII",
  "RECITATION",
  "IMAGE_SAFETY",
]);

/**
 * 系统提示词 = 人设 + 群聊上下文（开启时）+ 当前时间（要求时）。
 * 当前时间只在调用方要求时加（routingContext.includeCurrentTime === true），多数后台任务用不到；
 * 它每分钟都变，放在末尾，不影响前面人设部分的提示词缓存。
 */
async function buildSystemInstruction(e, presetPrompt, enableGroupContext, { includeCurrentTime = false } = {}) {
  const sections = [];
  if (presetPrompt && presetPrompt.trim()) {
    sections.push(presetPrompt.trim());
  }

  const contextOptions =
    typeof enableGroupContext === "object" && enableGroupContext !== null ? enableGroupContext : null;
  if ((contextOptions || enableGroupContext === true) && e?.group_id) {
    const groupContextOptions = {};
    if (!contextOptions?.noHeader && e?.sender) {
      groupContextOptions.sender = e.sender;
    }
    const systemPromptWithContext = await buildGroupPrompt(e.group_id, groupContextOptions);
    if (systemPromptWithContext.trim()) {
      sections.push(systemPromptWithContext.trim());
    }
  }

  if (includeCurrentTime) {
    sections.push(buildCurrentTimeLine());
  }
  return sections.join("\n");
}

/**
 * 协议实现内的失败：记日志后以 Error 对象返回（不抛出），由路由按动作决定怎么回退。
 */
// 失败原因由路由统一记一行（见 formatRouteAttemptFailure），这里只补记路由日志里没有的原始响应。
function requestFailure(message, action = ROUTE_FAILURE_ACTIONS.NEXT, { detail } = {}) {
  if (detail !== undefined) logger.warn(`[AI Router] ${message} 原始响应：`, detail);
  return createRouteFailure(message, action, { isAIRequestError: true, status: null });
}

// 上游/网络错误的消息已经在路由日志里；堆栈只对排查代码问题有用，放 debug 级别。
function logRequestErrorStack(error) {
  if (error?.stack) logger.debug(`[AI Router] 请求异常堆栈：${error.stack}`);
}

function geminiFinishReasonAction(finishReason) {
  return GEMINI_CONTENT_FINISH_REASONS.has(String(finishReason))
    ? ROUTE_FAILURE_ACTIONS.NEXT_MODEL
    : ROUTE_FAILURE_ACTIONS.NEXT;
}

function normalizeRequestError(error, { timedOut = false } = {}) {
  if (error?.isAIRequestError) {
    if (timedOut) error.timedOut = true;
    return error;
  }
  const status = Number(error?.status || error?.response?.status) || null;
  const wrapped = new Error(error?.message || String(error));
  wrapped.status = status;
  wrapped.isAIRequestError = true;
  // 保留路由判断超时/网络错误需要的信息。
  wrapped.originalName = error?.name;
  wrapped.code = error?.code ?? error?.cause?.code;
  wrapped.timedOut = timedOut || error?.timedOut === true;
  // 包装后响应头和错误体就丢了，先把上游要求的等待时间取出来留给路由冷却用。
  wrapped.retryAfterMs = upstreamRetryDelayMs(error);
  return wrapped;
}

function normalizeOpenAIReasoningEffort(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  return OPENAI_REASONING_EFFORTS.has(normalized) ? normalized : "";
}

function sanitizeFunctionSchema(schema, toUpper = false) {
  const visit = (node) => {
    if (Array.isArray(node)) {
      return node.map(visit);
    }

    if (!node || typeof node !== "object") {
      return node;
    }

    const sanitized = {};

    if (
      Object.prototype.hasOwnProperty.call(node, "const") &&
      !Object.prototype.hasOwnProperty.call(node, "enum")
    ) {
      sanitized.enum = [visit(node.const)];
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "exclusiveMaximum" || key === "exclusiveMinimum" || key === "const") {
        continue;
      }

      if (key === "type" && typeof value === "string") {
        sanitized[key] = toUpper ? value.toUpperCase() : value.toLowerCase();
      } else {
        sanitized[key] = visit(value);
      }
    }

    return sanitized;
  };

  return visit(schema);
}

function adjustSchemaCase(schema, toUpper = false) {
  const copied = JSON.parse(JSON.stringify(schema));
  return copied.map((tool) => ({
    ...tool,
    parameters: sanitizeFunctionSchema(tool.parameters, toUpper),
  }));
}

function extractTextFromParts(parts = []) {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text.trim() : ""))
    .filter(Boolean)
    .join("\n");
}

function parseOpenAICompletionIfNeeded(rawCompletion) {
  if (!rawCompletion) return rawCompletion;

  if (typeof rawCompletion === "string") {
    try {
      return JSON.parse(rawCompletion);
    } catch {
      return rawCompletion;
    }
  }

  if (
    typeof rawCompletion === "object" &&
    rawCompletion !== null &&
    typeof rawCompletion.data === "string"
  ) {
    try {
      return JSON.parse(rawCompletion.data);
    } catch {
      return rawCompletion;
    }
  }

  return rawCompletion;
}

function normalizeOpenAIMessageContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" && typeof part?.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("");
}

function openAIStreamReasoningDelta(delta = {}) {
  return [
    delta.reasoning_content,
    delta.reasoningContent,
    delta.reasoning,
  ]
    .map(normalizeOpenAIMessageContent)
    .filter(Boolean)
    .join("");
}

/**
 * 收集回答引用的网页来源，按 URL 去重并保持出现顺序。
 * OpenAI 格式：message/delta 上的 annotations（url_citation），以及 xAI 等接口顶层的 citations。
 * Gemini：candidate.groundingMetadata.groundingChunks[].web。
 */
function createCitationCollector() {
  const byUrl = new Map();
  const add = (url, title = "") => {
    const normalizedUrl = String(url || "").trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) return;
    const normalizedTitle = String(title || "").replace(/\s+/g, " ").trim();
    const existing = byUrl.get(normalizedUrl);
    if (!existing) {
      byUrl.set(normalizedUrl, { url: normalizedUrl, title: normalizedTitle });
    } else if (!existing.title && normalizedTitle) {
      existing.title = normalizedTitle;
    }
  };

  return {
    addOpenAIAnnotations(annotations) {
      if (!Array.isArray(annotations)) return;
      for (const annotation of annotations) {
        const citation = annotation?.url_citation || annotation;
        if (annotation?.type && annotation.type !== "url_citation") continue;
        add(citation?.url, citation?.title);
      }
    },
    addOpenAICitations(citations) {
      if (!Array.isArray(citations)) return;
      for (const citation of citations) {
        if (typeof citation === "string") add(citation);
        else add(citation?.url, citation?.title);
      }
    },
    addGeminiGrounding(groundingMetadata) {
      const chunks = groundingMetadata?.groundingChunks;
      if (!Array.isArray(chunks)) return;
      for (const chunk of chunks) {
        add(chunk?.web?.uri, chunk?.web?.title);
      }
    },
    list() {
      return [...byUrl.values()];
    },
  };
}

function withCitations(result, collector) {
  const citations = collector.list();
  return citations.length > 0 ? { ...result, citations } : result;
}

function streamUsageText(usage) {
  if (!usage || typeof usage !== "object") return "";
  const prompt = Number(usage.prompt_tokens ?? usage.promptTokenCount);
  const completion = Number(
    usage.completion_tokens ?? usage.candidatesTokenCount
  );
  const total = Number(usage.total_tokens ?? usage.totalTokenCount);
  const thoughts = Number(usage.thoughtsTokenCount);
  const cached = Number(usage.cachedContentTokenCount);
  const fields = [];
  if (Number.isFinite(prompt)) fields.push(`prompt=${prompt}`);
  if (Number.isFinite(completion)) fields.push(`completion=${completion}`);
  if (Number.isFinite(thoughts)) fields.push(`thoughts=${thoughts}`);
  if (Number.isFinite(cached)) fields.push(`cached=${cached}`);
  if (Number.isFinite(total)) fields.push(`total=${total}`);
  return fields.join(",");
}

function streamDiagnostic(channel, event, details = {}) {
  const name = String(channel?.name || channel?.model || "unknown");
  const detailText = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  logger.info(`[AI Stream] ${event} channel=${name}${detailText ? ` ${detailText}` : ""}`);
}

function appendStreamToolCalls(target, fragments = []) {
  for (const fragment of fragments) {
    const index = Number.isInteger(fragment?.index) ? fragment.index : target.size;
    const current = target.get(index) || {
      id: "",
      type: "function",
      function: { name: "", arguments: "" },
    };
    if (fragment?.id) current.id = fragment.id;
    if (fragment?.type) current.type = fragment.type;
    if (fragment?.function?.name) current.function.name = fragment.function.name;
    if (typeof fragment?.function?.arguments === "string") {
      current.function.arguments += fragment.function.arguments;
    }
    target.set(index, current);
  }
}

function parseOpenAIToolCalls(toolCallsArr = []) {
  return toolCallsArr
    .map((tc) => {
      try {
        return {
          id: tc.id,
          name: tc.function.name,
          args:
            typeof tc.function.arguments === "string"
              ? JSON.parse(tc.function.arguments)
              : tc.function.arguments || {},
        };
      } catch (err) {
        logger.error(
          `解析工具调用参数失败: ${err.message}`,
          tc.function.arguments
        );
        return null;
      }
    })
    .filter(Boolean);
}

export function getCurrentAndPreviousUserText(queryParts = [], historyContents = []) {
  const currentInput = extractTextFromParts(queryParts);
  let previousInput = "";

  for (let i = historyContents.length - 1; i >= 0; i--) {
    const item = historyContents[i];
    if (item?.role === "user") {
      previousInput = extractTextFromParts(item.parts || []);
      if (previousInput) break;
    }
  }

  return { currentInput, previousInput };
}

// DeepSeek、Kimi 等 OpenAI 兼容接口在思考模式下，要求把工具调用轮的 reasoning_content 原样回传；
// 官方 OpenAI 等接口则不认识这个字段。所以按目标在运行时学习：收到“必须回传”的 400 后记住该目标，
// 补齐后立即重试；之后发往它的请求都会带上。重启后重新学习。
const reasoningPassbackTargets = new Set();

function reasoningPassbackKey(channel) {
  return `${String(channel?.baseURL || "").trim()}\u0000${channel?.model || ""}`;
}

function isReasoningPassbackError(error) {
  return (
    Number(error?.status) === 400 &&
    /reasoning_content/i.test(String(error?.message || ""))
  );
}

export function resetReasoningPassbackTargets() {
  reasoningPassbackTargets.clear();
}

async function _getOpenAIResponse(
  channel,
  e,
  queryParts,
  presetPrompt,
  enableGroupContext,
  enableTools,
  historyContents = [],
  promptOptions = {}
) {
  if (!isRequestConfigComplete(channel, "openai")) {
    return requestFailure("无效或不完整的渠道配置");
  }

  const passbackKey = reasoningPassbackKey(channel);
  const passReasoning = reasoningPassbackTargets.has(passbackKey);

  const timeoutMs = Number(channel.timeoutMs);
  const openai = new OpenAI({
    apiKey: channel.apiKey,
    ...(channel.baseURL?.trim() && { baseURL: channel.baseURL.trim() }),
    maxRetries: 0,
    ...(Number.isFinite(timeoutMs) && timeoutMs > 0 && { timeout: Math.trunc(timeoutMs) }),
  });

  try {
    let messages = [];

    const fullSystemInstructionText = await buildSystemInstruction(e, presetPrompt, enableGroupContext, promptOptions);
    if (fullSystemInstructionText) {
      messages.push({ role: "system", content: fullSystemInstructionText });
    }

    if (historyContents.length > 0) {
      for (let historyIndex = 0; historyIndex < historyContents.length; historyIndex++) {
        const item = historyContents[historyIndex];
        if (item.role === "user" || item.role === "model") {
          const role = item.role === "model" ? "assistant" : "user";
          const textParts = item.parts
            .filter((part) => part.text && part.thought !== true)
            .map((part) => part.text);
          const content = item.role === "user"
            ? buildOpenAIUserContent(item.parts)
            : textParts.join("");
          const tool_calls = item.parts
            .filter((part) => part.functionCall)
            .map((part, functionCallIndex) => ({
              id:
                part.functionCall.id ||
                item.toolCallIds?.[functionCallIndex] ||
                `call_history_${historyIndex}_${functionCallIndex}`,
              type: "function",
              function: {
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args),
              },
            }));
          let message = { role };
          if (Array.isArray(content) ? content.length > 0 : content) {
            message.content = content;
          }
          if (tool_calls.length > 0) message.tool_calls = tool_calls;
          if (role === "assistant" && passReasoning) {
            // 其他模型产生的工具调用没有推理内容，回传空串满足字段要求。
            message.reasoning_content =
              typeof item.reasoningContent === "string" ? item.reasoningContent : "";
          }
          if (
            message.content ||
            (message.tool_calls && message.tool_calls.length > 0)
          ) {
            messages.push(message);
          }
        } else if (item.role === "function") {
          for (const part of item.parts) {
            if (part.functionResponse && part.functionResponse.id) {
              messages.push({
                role: "tool",
                tool_call_id: part.functionResponse.id,
                name: part.functionResponse.name,
                content: buildOpenAIToolContent(part.functionResponse),
              });
            }
          }
        }
      }
    }

    if (queryParts && queryParts.length > 0) {
      const openAICompatibleParts = buildOpenAIUserContent(queryParts);

      messages.push({ role: "user", content: openAICompatibleParts });
    }

    if (
      messages.length === 0 ||
      (messages[messages.length - 1].role !== "user" &&
        messages[messages.length - 1].role !== "tool")
    ) {
      // 完全没有可发送的内容时换谁都一样，直接终止；只是结尾不是用户消息时，Gemini 协议的模型仍可能接受。
      const nothingToSend = !(queryParts?.length > 0) && historyContents.length === 0;
      return requestFailure(
        "无有效查询或历史内容，无法发起请求。",
        nothingToSend ? ROUTE_FAILURE_ACTIONS.ABORT : ROUTE_FAILURE_ACTIONS.NEXT_MODEL
      );
    }

    const requestPayload = {
      model: channel.model,
      messages: messages,
      stream: channel.stream === true,
    };

    if (channel.openaiEnableThinking === true) {
      requestPayload.enable_thinking = true;
    }

    if (Number.isFinite(channel.temperature)) {
      requestPayload.temperature = channel.temperature;
    }
    if (Number.isFinite(channel.topP)) {
      requestPayload.top_p = channel.topP;
    }

    const reasoningEffort = normalizeOpenAIReasoningEffort(channel.openaiReasoningEffort);
    if (reasoningEffort) {
      requestPayload.reasoning_effort = reasoningEffort;
    } else if (typeof channel.openaiReasoningEffort === "string" && channel.openaiReasoningEffort.trim()) {
      logger.warn(`OpenAI target [${channel.name}] ignored invalid reasoning effort: ${channel.openaiReasoningEffort}`);
    }

    // 本地工具和 MCP 工具独立匹配，任一有结果就注入
    let allOpenAITools = [];
    if (channel.nativeWebSearch === true) {
      allOpenAITools.push(buildOpenAICompatibleWebSearchTool(channel));
    }
    if (enableTools) {
      const { localTools: toolsSchema, allowedMcpServerIds } = await getToolsSchema(e, enableTools, {
        nativeWebSearch: channel.nativeWebSearch === true,
        history: historyContents,
      });
      if (toolsSchema && toolsSchema.length > 0) {
        const adjustedSchema = adjustSchemaCase(toolsSchema, false);
        allOpenAITools.push(...adjustedSchema.map((tool) => ({
          type: "function",
          function: tool,
        })));
      }

      if (allowedMcpServerIds && allowedMcpServerIds.length > 0) {
        try {
          const mcpTools = await mcpManager.getOpenAITools(Boolean(e?.isMaster), allowedMcpServerIds);
          if (mcpTools && mcpTools.length > 0) {
            allOpenAITools.push(...mcpTools);
          }
        } catch (mcpErr) {
          logger.warn(`[MCP] 注入 MCP 工具失败，跳过: ${mcpErr.message}`);
        }
      }
    }

    if (allOpenAITools.length > 0) {
      requestPayload.tools = allOpenAITools;
      requestPayload.tool_choice = "auto";
    }

    if (channel.stream === true) {
      const startedAt = Date.now();
      const streamController = new AbortController();
      const configuredTimeoutMs = Number(channel.timeoutMs);
      let deadlineExceeded = false;
      const streamDeadline = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
        ? setTimeout(() => {
          deadlineExceeded = true;
          streamDiagnostic(channel, "deadline", { elapsedMs: Date.now() - startedAt });
          streamController.abort();
        }, Math.trunc(configuredTimeoutMs))
        : null;

      try {
        const rawStream = await openai.chat.completions.create(requestPayload, {
          signal: streamController.signal,
        });
        if (!rawStream || typeof rawStream[Symbol.asyncIterator] !== "function") {
          throw new Error("流式请求未返回可迭代的 SSE 响应");
        }

        let chunkCount = 0;
        let firstChunkMs = null;
        let firstReasoningMs = null;
        let firstTextMs = null;
        let reasoningChars = 0;
        let textChars = 0;
        let finishReason = "";
        let usage = null;
        let extractedText = "";
        let reasoningText = "";
        const toolCalls = new Map();
        const citations = createCitationCollector();

        try {
          for await (const rawChunk of rawStream) {
            const chunk = parseOpenAICompletionIfNeeded(rawChunk);
            chunkCount += 1;
            const elapsedMs = Date.now() - startedAt;
            if (firstChunkMs == null) {
              firstChunkMs = elapsedMs;
              streamDiagnostic(channel, "first_chunk", { elapsedMs });
            }
            if (chunk?.usage) usage = chunk.usage;
            citations.addOpenAICitations(chunk?.citations);

            const choice = chunk?.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finishReason = String(choice.finish_reason);
            const delta = choice.delta || choice.message || {};

            const reasoning = openAIStreamReasoningDelta(delta);
            if (reasoning) {
              reasoningText += reasoning;
              reasoningChars += reasoning.length;
              if (firstReasoningMs == null) {
                firstReasoningMs = elapsedMs;
                streamDiagnostic(channel, "first_reasoning", { elapsedMs });
              }
            }

            const text = normalizeOpenAIMessageContent(delta.content);
            if (text) {
              extractedText += text;
              textChars += text.length;
              if (firstTextMs == null) {
                firstTextMs = elapsedMs;
                streamDiagnostic(channel, "first_text", { elapsedMs });
              }
            }

            appendStreamToolCalls(toolCalls, delta.tool_calls || []);
            citations.addOpenAIAnnotations(delta.annotations);
          }
        } catch (streamError) {
          streamDiagnostic(channel, "interrupted", {
            elapsedMs: Date.now() - startedAt,
            deadlineExceeded,
            chunks: chunkCount,
            firstChunkMs,
            firstReasoningMs,
            firstTextMs,
            reasoningChars,
            textChars,
            finishReason,
          });
          throw streamError;
        }

        const toolCallsArr = [...toolCalls.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, call]) => call);
        streamDiagnostic(channel, "completed", {
          elapsedMs: Date.now() - startedAt,
          chunks: chunkCount,
          firstChunkMs,
          firstReasoningMs,
          firstTextMs,
          reasoningChars,
          textChars,
          finishReason,
          usage: streamUsageText(usage),
        });

        if (!extractedText && toolCallsArr.length === 0) {
          return requestFailure("API 未返回任何内容。");
        }

        return withCitations({
          text: extractedText,
          functionCalls: parseOpenAIToolCalls(toolCallsArr),
          ...(reasoningText && { reasoningContent: reasoningText }),
        }, citations);
      } catch (streamBranchError) {
        throw deadlineExceeded
          ? normalizeRequestError(streamBranchError, { timedOut: true })
          : streamBranchError;
      } finally {
        if (streamDeadline) clearTimeout(streamDeadline);
      }
    }

    const rawCompletion = await openai.chat.completions.create(requestPayload);
    const completion = parseOpenAICompletionIfNeeded(rawCompletion);
    
    if (!completion || !completion.choices || !Array.isArray(completion.choices)) {
      return requestFailure(
        `API 节点返回了异常格式(${typeof completion})`,
        ROUTE_FAILURE_ACTIONS.NEXT,
        { detail: JSON.stringify(completion) }
      );
    }

    const message = completion.choices[0]?.message;
    const reasoningContent = openAIStreamReasoningDelta(message || {});
    const citations = createCitationCollector();
    citations.addOpenAIAnnotations(message?.annotations);
    citations.addOpenAICitations(completion.citations);
    const extractedText = normalizeOpenAIMessageContent(message?.content);
    const toolCallsArr = message?.tool_calls || [];

    if (!extractedText && toolCallsArr.length === 0) {
      return requestFailure("API 未返回任何内容。");
    }

    const functionCalls = parseOpenAIToolCalls(toolCallsArr);

    return withCitations({
      text: extractedText,
      functionCalls,
      ...(reasoningContent && { reasoningContent }),
    }, citations);
  } catch (error) {
    if (isReasoningPassbackError(error)) {
      if (!passReasoning) {
        reasoningPassbackTargets.add(passbackKey);
        logger.info(
          `[AI Router] 模型 ${channel.name || channel.model} 要求回传 reasoning_content，已补齐后重试`
        );
        return _getOpenAIResponse(
          channel,
          e,
          queryParts,
          presetPrompt,
          enableGroupContext,
          enableTools,
          historyContents,
          promptOptions
        );
      }
      // 带上之后反而因为这个字段被拒，说明判断错了，撤销学习结果。
      reasoningPassbackTargets.delete(passbackKey);
    }
    logRequestErrorStack(error);
    throw normalizeRequestError(error);
  }
}

async function _getGeminiResponse(
  channel,
  e,
  queryParts,
  presetPrompt,
  enableGroupContext,
  enableTools,
  historyContents = [],
  promptOptions = {}
) {
  if (!isRequestConfigComplete(channel, "gemini")) {
    return requestFailure("无效或不完整的渠道配置。");
  }

  const { model: GEMINI_MODEL } = channel;

  let finalContentsForGemini = [];
  let fullSystemInstructionText = "";
  // 本次请求使用的超时信号；请求失败时据此判断是不是超时。
  let timeoutSignal = null;

  try {
    const ai = createGeminiClient(channel);
    fullSystemInstructionText = await buildSystemInstruction(e, presetPrompt, enableGroupContext, promptOptions);

    if (historyContents.length > 0) {
      finalContentsForGemini.push(...prepareHistoryForGemini(historyContents));
    }

    if (queryParts && queryParts.length > 0) {
      const processedParts = processQueryParts(queryParts, "gemini");
      finalContentsForGemini.push({
        role: "user",
        parts: processedParts,
      });
    } else if (finalContentsForGemini.length === 0) {
      return requestFailure("无查询或历史内容，无法请求。", ROUTE_FAILURE_ACTIONS.ABORT);
    }

    const requestOptions = {
      contents: finalContentsForGemini,
    };

    const requestConfig = {};
    const timeoutMs = Number(channel.timeoutMs);
    if (
      channel.stream !== true &&
      Number.isFinite(timeoutMs) &&
      timeoutMs > 0
    ) {
      timeoutSignal = AbortSignal.timeout(Math.trunc(timeoutMs));
      requestConfig.abortSignal = timeoutSignal;
    }

    if (Number.isFinite(channel.temperature)) {
      requestConfig.temperature = channel.temperature;
    }
    if (Number.isFinite(channel.topP)) {
      requestConfig.topP = channel.topP;
    }

    if (Number.isInteger(channel.geminiThinkingBudget) && channel.geminiThinkingBudget >= -1) {
      requestConfig.thinkingConfig = {
        thinkingBudget: channel.geminiThinkingBudget,
      };
    } else if (GEMINI_THINKING_LEVELS[channel.geminiThinkingLevel]) {
      requestConfig.thinkingConfig = {
        thinkingLevel: GEMINI_THINKING_LEVELS[channel.geminiThinkingLevel],
      };
    }

    if (fullSystemInstructionText.trim()) {
      requestConfig.systemInstruction = fullSystemInstructionText.trim();
    }

    requestConfig.safetySettings = [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
    ];

    // 本地工具和 MCP 工具独立匹配，任一有结果就注入
    let allDeclarations = [];
    if (enableTools) {
      const { localTools: toolsSchema, allowedMcpServerIds } = await getToolsSchema(e, enableTools, {
        nativeWebSearch: channel.nativeWebSearch === true,
        history: historyContents,
      });
      if (toolsSchema && toolsSchema.length > 0) {
        const adjustedSchema = adjustSchemaCase(toolsSchema, true);
        allDeclarations.push(...adjustedSchema);
      }

      if (allowedMcpServerIds && allowedMcpServerIds.length > 0) {
        try {
          const mcpTools = await mcpManager.listTools(Boolean(e?.isMaster), allowedMcpServerIds);
          if (mcpTools && mcpTools.length > 0) {
            const mcpDeclarations = mcpTools.map(tool => {
              return {
                name: tool.name,
                description: tool.description || "",
                parameters: sanitizeFunctionSchema(
                  tool.inputSchema || { type: "object", properties: {} },
                  true
                ),
              };
            });
            allDeclarations.push(...mcpDeclarations);
          }
        } catch (mcpErr) {
          logger.warn(`[MCP] 注入 MCP 工具失败，跳过: ${mcpErr.message}`);
        }
      }
    }

    Object.assign(requestConfig, buildGeminiToolConfig({
      functionDeclarations: allDeclarations,
      nativeWebSearch: channel.nativeWebSearch,
      vertex: channel.vertex,
    }));

    const geminiRequestBody = {
      model: GEMINI_MODEL,
      ...requestOptions,
      config: requestConfig,
    };

    if (channel.stream === true) {
      const startedAt = Date.now();
      const streamController = new AbortController();
      let deadlineExceeded = false;
      requestConfig.abortSignal = streamController.signal;
      timeoutSignal = streamController.signal;
      const streamDeadline =
        Number.isFinite(timeoutMs) && timeoutMs > 0
          ? setTimeout(() => {
              deadlineExceeded = true;
              streamDiagnostic(channel, "deadline", {
                elapsedMs: Date.now() - startedAt,
              });
              streamController.abort();
            }, Math.trunc(timeoutMs))
          : null;

      try {
        let collected;
        try {
          const rawStream = await ai.models.generateContentStream(
            geminiRequestBody
          );
          collected = await collectGeminiStream(rawStream, {
            startedAt,
            onDiagnostic: (event, details) =>
              streamDiagnostic(channel, event, details),
          });
        } catch (streamError) {
          const stats = streamError?.geminiStreamStats || {};
          streamDiagnostic(channel, "interrupted", {
            elapsedMs: Date.now() - startedAt,
            deadlineExceeded,
            chunks: stats.chunkCount,
            firstChunkMs: stats.firstChunkMs,
            firstReasoningMs: stats.firstReasoningMs,
            firstTextMs: stats.firstTextMs,
            reasoningChars: stats.reasoningChars,
            textChars: stats.textChars,
            finishReason: stats.finishReason,
          });
          throw streamError;
        }

        streamDiagnostic(channel, "completed", {
          elapsedMs: Date.now() - startedAt,
          chunks: collected.chunkCount,
          firstChunkMs: collected.firstChunkMs,
          firstReasoningMs: collected.firstReasoningMs,
          firstTextMs: collected.firstTextMs,
          reasoningChars: collected.reasoningChars,
          textChars: collected.textChars,
          finishReason: collected.finishReason,
          usage: streamUsageText(collected.usage),
        });

        if (collected.promptFeedback?.blockReason) {
          return requestFailure(
            `响应被拦截，原因: ${collected.promptFeedback.blockReason}`,
            ROUTE_FAILURE_ACTIONS.NEXT_MODEL
          );
        }
        if (!collected.sawCandidate) {
          return requestFailure("响应中未包含候选内容。");
        }
        if (
          collected.finishReason &&
          !["STOP", "MAX_TOKENS"].includes(collected.finishReason)
        ) {
          const suffix = collected.finishMessage
            ? `：${collected.finishMessage}`
            : "";
          return requestFailure(
            `生成因 ${collected.finishReason} 而中止${suffix}。`,
            geminiFinishReasonAction(collected.finishReason)
          );
        }
        if (
          !collected.extractedText &&
          collected.functionCalls.length === 0
        ) {
          return requestFailure("返回内容为空。");
        }

        const citations = createCitationCollector();
        citations.addGeminiGrounding(collected.groundingMetadata);
        return withCitations({
          text: collected.extractedText,
          functionCalls: collected.functionCalls,
          rawParts: collected.rawParts,
        }, citations);
      } finally {
        if (streamDeadline) clearTimeout(streamDeadline);
      }
    }

    const response = await ai.models.generateContent(geminiRequestBody);

    if (!response) {
      return requestFailure("API 未返回有效的响应。");
    }

    if (response.promptFeedback?.blockReason) {
      return requestFailure(
        `响应被拦截，原因: ${response.promptFeedback.blockReason}`,
        ROUTE_FAILURE_ACTIONS.NEXT_MODEL
      );
    }

    if (!response.candidates || response.candidates.length === 0) {
      return requestFailure("响应中未包含候选内容。", ROUTE_FAILURE_ACTIONS.NEXT, {
        detail: JSON.stringify(response, null, 2),
      });
    }

    const candidate = response.candidates[0];

    if (
      candidate.finishReason &&
      !["STOP", "MAX_TOKENS"].includes(candidate.finishReason)
    ) {
      return requestFailure(
        `生成因 ${candidate.finishReason} 而中止。`,
        geminiFinishReasonAction(candidate.finishReason),
        { detail: JSON.stringify(candidate, null, 2) }
      );
    }

    if (!candidate.content || !candidate.content.parts) {
      return requestFailure("候选内容为空。", ROUTE_FAILURE_ACTIONS.NEXT, {
        detail: JSON.stringify(candidate, null, 2),
      });
    }

    const responseParts = candidate.content.parts;
    const visibleParts = responseParts.filter(
      (part) => part?.thought !== true
    );

    const extractedText = visibleParts
      .filter((part) => part.text)
      .map((part) => part.text)
      .join("");

    const extractedFunctionCalls = responseParts
      .filter((part) => part.functionCall)
      .map((part) => part.functionCall);

    if (!extractedText && extractedFunctionCalls.length === 0) {
      return requestFailure("返回内容为空。");
    }

    const citations = createCitationCollector();
    citations.addGeminiGrounding(candidate.groundingMetadata);
    return withCitations({
      text: extractedText,
      functionCalls: extractedFunctionCalls,
      rawParts: responseParts,
    }, citations);
  } catch (error) {
    logRequestErrorStack(error);
    throw normalizeRequestError(error, { timedOut: timeoutSignal?.aborted === true });
  }
}

export async function getAI(
  models,
  e,
  queryParts,
  presetPrompt,
  enableGroupContext,
  enableTools,
  historyContents = [],
  routingContext = null
) {
  const routeId = formatModelList(models);
  let plan;
  try {
    const cachedPlan = routingContext?.plan;
    plan = cachedPlan?.route?.key === modelListKey(models)
      ? cachedPlan
      : createRouteExecutionPlan(models, { selfId: e?.self_id });
    if (routingContext && typeof routingContext === "object") {
      routingContext.plan = plan;
    }
  } catch (error) {
    return `模型配置错误：${error.message}`;
  }

  if (plan.attempts.length === 0) {
    return `模型“${routeId}”没有可用的供应商或 Key。`;
  }

  const outcome = await executeRoutePlan({
    plan,
    routeId,
    run: async (attempt) => {
      const config = routingContext?.disableNativeWebSearch === true
        ? { ...attempt.requestConfig, nativeWebSearch: false }
        : attempt.requestConfig;
      logger.info(
        `[AI Router] model=${attempt.target.id} provider=${attempt.provider.id} key=${attempt.credential.id}`
      );

      const args = [
        config,
        e,
        queryParts,
        presetPrompt,
        enableGroupContext,
        enableTools,
        historyContents,
        { includeCurrentTime: routingContext?.includeCurrentTime === true },
      ];
      let result;
      try {
        result = config.channelType === "gemini"
          ? await _getGeminiResponse(...args)
          : await _getOpenAIResponse(...args);
      } catch (error) {
        throw normalizeRequestError(error);
      }
      if (result instanceof Error) throw result;
      return { ...result, sourceProtocol: config.channelType };
    },
  });

  if (outcome.ok) {
    if (routingContext && typeof routingContext === "object") {
      routingContext.plan = prioritizeRouteAttempt(plan, outcome.attempt);
    }
    return outcome.value;
  }

  // 具体原因上面每次尝试的路由日志里都有，这里只记结论。
  logger.error(`[AI Router] ${routeId} 请求失败`);
  return `模型“${routeId}”请求失败：${outcome.error?.message || "未知错误"}`;
}
