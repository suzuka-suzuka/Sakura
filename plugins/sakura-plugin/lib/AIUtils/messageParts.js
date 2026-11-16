/**
 * 将内部消息 Part 转成指定模型协议所需的格式。
 */
export function processQueryParts(queryParts, channelType) {
  if (!queryParts || queryParts.length === 0) return queryParts;

  return queryParts.map((part) => {
    if (part.text) {
      return part;
    }
    if (part.inlineData) {
      if (channelType === "gemini") {
        return part;
      }

      const { mimeType, data } = part.inlineData;
      return {
        type: "image_url",
        image_url: {
          url: `data:${mimeType};base64,${data}`,
        },
      };
    }
    return part;
  });
}

export function buildOpenAIUserContent(parts = []) {
  const visibleParts = Array.isArray(parts)
    ? parts.filter((part) => part && part.thought !== true)
    : [];
  const processedParts = processQueryParts(visibleParts, "openai") || [];

  return processedParts
    .map((part) => {
      if (part.text && !part.type) {
        return { type: "text", text: part.text };
      }
      if (part.image_url && !part.type) {
        return { type: "image_url", image_url: part.image_url };
      }
      return part;
    })
    .filter((part) => part?.type === "text" || part?.type === "image_url");
}

/**
 * OpenAI 兼容协议的 tool 消息内容。没有附带图片时仍是 JSON 字符串；
 * 有图片时是 [text, image_url...] 数组（DeepSeek 直连、CPA 的 Codex 渠道已验证可用）。
 */
export function buildOpenAIToolContent(functionResponse = {}) {
  const text = JSON.stringify(functionResponse.response);
  const images = buildOpenAIUserContent(functionResponse.parts)
    .filter((part) => part.type === "image_url");
  if (images.length === 0) return text;
  return [{ type: "text", text }, ...images];
}

export function buildMultimodalQueryParts(text, images = []) {
  return [
    { text: String(text || "") },
    ...(Array.isArray(images) ? images : [])
      .filter((image) => image?.base64 && image?.mimeType)
      .map((image) => ({
        inlineData: {
          mimeType: image.mimeType,
          data: image.base64,
        },
      })),
  ];
}
