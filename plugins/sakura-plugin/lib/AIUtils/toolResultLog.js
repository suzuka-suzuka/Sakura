export const TAVILY_SEARCH_LOG_MAX_CHARS = 2000;

function normalizeToolName(toolName) {
    return String(toolName || "").trim().toLowerCase().replace(/-/g, "_");
}

function truncateTavilySearchLog(text) {
    const value = String(text || "");
    if (value.length <= TAVILY_SEARCH_LOG_MAX_CHARS) {
        return value;
    }

    const omittedChars = value.length - TAVILY_SEARCH_LOG_MAX_CHARS;
    return `${value.slice(0, TAVILY_SEARCH_LOG_MAX_CHARS)}\n... [仅日志截断，省略 ${omittedChars} 字符，总长 ${value.length} 字符；完整结果已返回给 AI] ...`;
}

export function buildToolResultLogPart(functionResponsePart) {
    const functionResponse = functionResponsePart?.functionResponse;
    const response = functionResponse?.response;
    if (
        normalizeToolName(functionResponse?.name) !== "tavily_search" ||
        typeof response?.message !== "string" ||
        response.message.length <= TAVILY_SEARCH_LOG_MAX_CHARS
    ) {
        return functionResponsePart;
    }

    return {
        ...functionResponsePart,
        functionResponse: {
            ...functionResponse,
            response: {
                ...response,
                message: truncateTavilySearchLog(response.message),
            },
        },
    };
}
