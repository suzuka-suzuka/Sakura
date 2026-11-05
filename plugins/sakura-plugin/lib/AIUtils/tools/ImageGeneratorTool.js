import { generateImagesWithProvider } from "../imageProvider.js";
import { AbstractTool } from "./AbstractTool.js";
import { fetchMessageByIdentifier } from "../messageLookup.js";
import Setting from "../../setting.js";

export class ImageGeneratorTool extends AbstractTool {
  name = "ImageGenerator";

  parameters = {
    properties: {
      prompt: {
        type: "string",
        description: "Prompt used to generate or edit an image.",
      },
      outputFormat: {
        type: "string",
        enum: ["png", "gif"],
        description: "输出格式，默认静态图片。gif 用于循环动画，可通过 seq 引用图片生成动图。",
      },
      frameCount: {
        type: "integer",
        minimum: 2,
        maximum: 16,
        description: "GIF 帧数，可省略，省略时使用后台配置值。",
      },
      frameDurationMs: {
        type: "integer",
        minimum: 20,
        maximum: 2000,
        description: "GIF 每帧时长，单位毫秒，必须为 10 的倍数，省略时使用后台配置值。",
      },
      seq: {
        type: "array",
        items: {
          type: "integer",
        },
        description: "Referenced message seq values that contain source images.",
      },
      aspectRatio: {
        type: "string",
        description: "Target aspect ratio.",
        enum: [
          "1:1",
          "2:3",
          "3:2",
          "3:4",
          "4:3",
          "4:5",
          "5:4",
          "9:16",
          "16:9",
          "21:9",
        ],
      },
      imageSize: {
        type: "string",
        description: "Target image quality level.",
        enum: ["1K", "2K", "4K"],
      },
    },
    required: ["prompt"],
  };

  description = "生成或编辑图片，包括重绘、风格转换和修图；也可通过 outputFormat=gif 从文字或参考图片生成循环动图。";

  func = async function (opts, e) {
    let { prompt, seq, aspectRatio, imageSize, outputFormat, frameCount, frameDurationMs } = opts;
    const imageUrls = [];

    if (seq) {
      const seqList = Array.isArray(seq) ? seq : [seq];
      for (const currentSeq of seqList) {
        try {
          const targetMsg = await fetchMessageByIdentifier(e, currentSeq);
          if (!targetMsg?.message) {
            continue;
          }

          const images = targetMsg.message
            .filter((messageItem) => messageItem.type === "image")
            .map((messageItem) => messageItem.data?.url)
            .filter(Boolean);

          if (images.length > 0) {
            imageUrls.push(...images);
            await e.react(128076, targetMsg.message_id ?? currentSeq);
          }
        } catch (error) {
          logger.error(
            `[ImageGeneratorTool] failed to load seq ${currentSeq}:`,
            error
          );
        }
      }
    }

    if (!prompt) {
      return "你必须提供一段用于生成图片的描述。";
    }

    try {
      const imageConfig = Setting.getConfig("EditImage");
      const imageBuffers = await generateImagesWithProvider(
        imageConfig,
        prompt,
        imageUrls,
        {
          aspectRatio,
          imageSize,
          selfId: e?.self_id,
          outputFormat,
          frameCount,
          frameDurationMs,
        }
      );

      if (imageBuffers.length > 0) {
        await e.reply(segment.image(imageBuffers[0]));
        return outputFormat === "gif"
          ? "已成功生成并发送 GIF 动图，禁止回复[图片]"
          : "已成功生成并发送图片，禁止回复[图片]";
      }

      return "未能生成图片，可能被安全策略拦截。";
    } catch (error) {
      logger.error("[ImageGeneratorTool] image generation failed:", error);

      if (
        imageUrls.length > 0 &&
        error.message &&
        error.message.includes("Could not load image")
      ) {
        return `图片生成失败，提供的图片可能无法访问或格式不受支持。${error.message}`;
      }

      return `图片生成失败：${error.message}`;
    }
  };
}
