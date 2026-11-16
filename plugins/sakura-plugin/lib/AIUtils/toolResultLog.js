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

// 日志里只记附带图片的类型和大小，不打印 base64。
function summarizeMediaParts(parts) {
    return parts.map((part) => {
        const data = part?.inlineData?.data;
        const size = typeof data === "string" ? Math.floor((data.length * 3) / 4) : 0;
        return `[${part?.inlineData?.mimeType || "未知类型"}，约 ${size} 字节]`;
    });
}

export function buildToolResultLogPart(functionResponsePart) {
    let functionResponse = functionResponsePart?.functionResponse;
    if (!functionResponse) return functionResponsePart;

    if (Array.isArray(functionResponse.parts)) {
        functionResponse = { ...functionResponse, parts: summarizeMediaParts(functionResponse.parts) };
    }

    const response = functionResponse.response;
    if (
        normalizeToolName(functionResponse.name) === "tavily_search" &&
        typeof response?.message === "string" &&
        response.message.length > TAVILY_SEARCH_LOG_MAX_CHARS
    ) {
        functionResponse = {
            ...functionResponse,
            response: {
                ...response,
                message: truncateTavilySearchLog(response.message),
            },
        };
    }

    return functionResponse === functionResponsePart.functionResponse
        ? functionResponsePart
        : { ...functionResponsePart, functionResponse };
}
