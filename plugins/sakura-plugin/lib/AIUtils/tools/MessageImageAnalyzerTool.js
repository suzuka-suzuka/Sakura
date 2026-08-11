import { MessageContentAnalyzerTool } from "./MessageContentAnalyzerTool.js";
import { fetchMessageByIdentifier } from "../messageLookup.js";
import { MESSAGE_IMAGE_ANALYZER_TOOL_NAME } from "../messageImageToolRouting.js";

export class MessageImageAnalyzerTool extends MessageContentAnalyzerTool {
  name = MESSAGE_IMAGE_ANALYZER_TOOL_NAME;

  parameters = {
    properties: {
      seq: {
        type: "integer",
        description: "图片占位符 [图片](seq:...) 中的 seq",
      },
      query: {
        type: "string",
        description: "可选。需要针对图片分析的问题，省略时使用通用图片描述",
      },
    },
    required: ["seq"],
  };

  description =
    "根据 QQ 消息中的 seq 读取并分析图片。"
    + "当当前消息含有 [图片](seq:...) 且需要查看图片内容时调用；不要猜测未读取的图片内容。";

  func = async function (opts, e, executionContext = {}) {
    if (
      executionContext.allowMessageImageAnalyzer !== true ||
      executionContext.supportsImageInput !== false
    ) {
      return "当前请求未开放 seq 识图能力。";
    }

    const seq = opts?.seq;
    if (seq == null || String(seq).trim() === "") {
      return "需提供图片占位符中的 seq。";
    }

    const targetMsg = await fetchMessageByIdentifier(e, seq);
    const messageParts = Array.isArray(targetMsg?.message)
      ? targetMsg.message
      : [];
    const imageUrls = messageParts
      .filter((part) => part?.type === "image" && part.data?.url)
      .map((part) => part.data.url);

    if (imageUrls.length === 0) {
      return `未在消息 seq:${seq} 中找到图片。`;
    }

    return this.processImages(imageUrls, opts?.query, executionContext);
  };
}
