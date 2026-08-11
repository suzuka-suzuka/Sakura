import Setting from "../setting.js";
import { getAI } from "./getAI.js";
import { modelSupportsDirectImageInput } from "./providerRouter.js";
import { ensureToolCallIds } from "./toolCallProtocol.js";
import { executeToolCalls, toolGroupHasTool } from "./tools/tools.js";
import {
  hasMessageImageReference,
  MESSAGE_IMAGE_ANALYZER_TOOL_NAME,
  prepareImagePartsForModel,
  shouldExposeMessageImageAnalyzer,
} from "./messageImageToolRouting.js";
import { buildMemoryContext } from "./memoryContext.js";
import { finalizeStoppedConversationTurn } from "./ConversationHistory.js";
import {
  filterNewInlineDataParts,
  stripEphemeralUserParts,
} from "./toolResultProtocol.js";
import {
  checkAndClearStopFlag,
  finishAiTask,
  startAiTask,
} from "./stopFlag.js";

const DEFAULT_MAX_TOOL_CALLS = 20;

export function getAgentMaxToolCalls(e = null) {
  const aiConfig = Setting.getConfig("AI", { selfId: e?.self_id }) || {};
  const value = Number(aiConfig.maxToolCalls);
  return Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : DEFAULT_MAX_TOOL_CALLS;
}

function buildModelResponseParts(response) {
  const textContent = response?.text || "";
  const functionCalls = response?.functionCalls || [];
  const rawParts = response?.rawParts || [];

  if (rawParts.length > 0) {
    return rawParts;
  }

  const parts = [];
  if (textContent) {
    parts.push({ text: textContent });
  }

  for (const functionCall of functionCalls) {
    parts.push({ functionCall });
  }

  return parts;
}

export async function runAgentLoop({
  label = "Agent",
  e,
  route,
  queryParts,
  prompt,
  groupContext,
  toolGroup,
  history = [],
  pluginInstance = null,
  maxToolCalls = getAgentMaxToolCalls(e),
  onIntermediateText = null,
  includeUserHistoryPart = (part) => !part.inlineData,
}) {
  const currentFullHistory = history;
  const turnStartIndex = currentFullHistory.length;
  const taskId = startAiTask(e);
  const hasCurrentImages = hasMessageImageReference(queryParts);
  const hasMessageContentAnalyzer = toolGroupHasTool(
    toolGroup,
    "MessageContentAnalyzer"
  );
  const routingContext = {
    prepareQueryPartsForAttempt: async (parts, config) =>
      prepareImagePartsForModel(
        parts,
        modelSupportsDirectImageInput(config?.model)
      ),
    getAdditionalToolNamesForAttempt: (config) =>
      shouldExposeMessageImageAnalyzer({
        hasCurrentImages,
        supportsImageInput: modelSupportsDirectImageInput(config?.model),
        hasMessageContentAnalyzer,
      })
        ? [MESSAGE_IMAGE_ANALYZER_TOOL_NAME]
        : [],
  };
  let toolCallCount = 0;
  let finalText = "";
  let effectivePrompt = prompt;

  const analyzeImagesWithToolRoute = async (parts) => {
    const toolsRoute = Setting.getConfig("AI", { selfId: e?.self_id })?.toolsRoute;
    if (!toolsRoute) {
      return "未配置用于识图的 toolsRoute。";
    }

    return getAI(
      toolsRoute,
      e,
      parts,
      "",
      false,
      false
    );
  };

  try {
    if (toolGroupHasTool(toolGroup, "Memory")) {
      try {
        const memoryContext = await buildMemoryContext(e, queryParts);
        if (memoryContext) {
          effectivePrompt = [prompt, memoryContext].filter(Boolean).join("\n\n");
        }
      } catch (error) {
        logger.warn(`[${label}] 自动注入长期记忆失败，继续生成回复: ${error.message}`);
      }
    }

    let currentResponse = await getAI(
      route,
      e,
      queryParts,
      effectivePrompt,
      groupContext,
      toolGroup,
      currentFullHistory,
      routingContext
    );

    if (typeof currentResponse === "string") {
      return {
        status: "model_error",
        error: currentResponse,
        history: currentFullHistory,
        finalText,
        toolCallCount,
      };
    }

    const initialRequestParts = Array.isArray(currentResponse.requestQueryParts)
      ? currentResponse.requestQueryParts
      : queryParts;
    if (Array.isArray(initialRequestParts) && initialRequestParts.length > 0) {
      currentFullHistory.push({ role: "user", parts: initialRequestParts });
    }

    while (true) {
      if (checkAndClearStopFlag(taskId)) {
        logger.info(`[${label}] User ${e.user_id} requested stop`);
        finalizeStoppedConversationTurn(
          currentFullHistory,
          turnStartIndex,
          includeUserHistoryPart
        );
        return {
          status: "stopped",
          history: currentFullHistory,
          finalText,
          toolCallCount,
        };
      }

      currentResponse = ensureToolCallIds(currentResponse);
      const textContent = currentResponse.text || "";
      const functionCalls = currentResponse.functionCalls || [];
      const modelResponseParts = buildModelResponseParts(currentResponse);

      if (modelResponseParts.length > 0) {
        const modelHistoryItem = {
          role: "model",
          parts: modelResponseParts,
          sourceProtocol: currentResponse.sourceProtocol,
        };
        if (functionCalls.length > 0) {
          modelHistoryItem.toolCallIds = functionCalls.map((call) => call.id);
        }
        currentFullHistory.push(modelHistoryItem);
      }

      if (functionCalls.length > 0) {
        toolCallCount++;
        if (toolCallCount >= maxToolCalls) {
          logger.warn(
            `[${label}] Tool call limit reached (${maxToolCalls}), ending loop`
          );
          currentFullHistory.pop();
          return {
            status: "tool_limit",
            history: currentFullHistory,
            finalText,
            toolCallCount,
            maxToolCalls,
          };
        }

        if (textContent && onIntermediateText) {
          await onIntermediateText(textContent.replace(/\n+$/, ""));
        }

        const toolCallback = await executeToolCalls(
          e,
          functionCalls,
          pluginInstance,
          {
            supportsImageInput: currentResponse.supportsImageInput === true,
            analyzeImages: analyzeImagesWithToolRoute,
            allowMessageImageAnalyzer: shouldExposeMessageImageAnalyzer({
              hasCurrentImages,
              supportsImageInput: currentResponse.supportsImageInput === true,
              hasMessageContentAnalyzer,
            }),
          }
        );
        currentFullHistory.push(...toolCallback.historyContents);
        const newToolQueryParts = filterNewInlineDataParts(
          toolCallback.queryParts,
          currentFullHistory
        );

        currentResponse = await getAI(
          route,
          e,
          newToolQueryParts,
          effectivePrompt,
          groupContext,
          toolGroup,
          currentFullHistory,
          routingContext
        );

        if (typeof currentResponse === "string") {
          return {
            status: "model_error",
            error: currentResponse,
            history: currentFullHistory,
            finalText,
            toolCallCount,
          };
        }
        if (
          Array.isArray(currentResponse.requestQueryParts) &&
          currentResponse.requestQueryParts.length > 0
        ) {
          currentFullHistory.push({
            role: "user",
            parts: currentResponse.requestQueryParts,
          });
        }
        continue;
      }

      if (textContent) {
        finalText = textContent;
        return {
          status: "completed",
          history: currentFullHistory,
          finalText,
          toolCallCount,
        };
      }

      return {
        status: "empty",
        history: currentFullHistory,
        finalText,
        toolCallCount,
      };
    }
  } finally {
    stripEphemeralUserParts(currentFullHistory, includeUserHistoryPart);
    finishAiTask(e, taskId);
  }
}
