import fs from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import Setting from "../setting.js";
import { plugindata } from "../path.js";
import {
  downloadMedia,
  generateGrokVideoAndWait,
} from "./cliProxyMediaClient.js";
import { tagMediaError } from "./mediaErrorMessages.js";
import { generateOpenAIVideoAndWait } from "./openaiVideoClient.js";
import {
  createRouteExecutionPlan,
  executeRoutePlan,
  resolveRouteReference,
} from "./providerRouter.js";
import { formatModelList, normalizeModelList } from "./aiModels.js";
import {
  clampInteger,
  GROK_CPA_ASPECT_RATIOS,
  GROK_CPA_MAX_VIDEO_RESOLUTION,
  GROK_CPA_VIDEO_RESOLUTIONS,
  nearestSupportedAspectRatio,
} from "./mediaParameterCompatibility.js";
import {
  buildGeminiClientOptions,
  DEFAULT_VERTEX_LOCATION,
} from "./vertexAuth.js";
import { VIDEO_GENERATION_TIMEOUT_MS } from "./videoGenerationConstants.js";

const GEMINI_OMNI_MODEL = "gemini-omni-flash-preview";
const GEMINI_ASPECT_RATIOS = new Set(["16:9", "9:16"]);
const VIDEO_REFERENCE_LIMITS = {
  grok: 7,
  gemini: 10,
};
// OpenAI Videos 中转站按模型名后缀区分任务：i2v 只收首帧 + 尾帧，multi 最多 9 张。
// 没有后缀的模型（如 minimax-h3-comfyui-*）各有规则，不在本地限制，交给上游校验。
const OPENAI_VIDEO_REFERENCE_LIMITS = { t2v: 0, i2v: 2, multi: 9 };

function resolveVideoSelection(requestedRoute = null, selfId = null) {
  const scope = selfId == null ? {} : { selfId };
  const featureConfig = Setting.getConfig("EditImage", scope);
  const requested = String(requestedRoute || "").trim();
  const configuredModels = normalizeModelList(featureConfig.videoModels);
  if (!requested && configuredModels.length === 0) {
    throw new Error("未配置视频模型，请在面板的“图片与视频生成”里选择默认视频模型。");
  }

  const alias = requested.toLowerCase();
  const aliasMatchers = {
    grok: ({ target, provider }) =>
      provider.protocol === "openai" && /grok/i.test(target.model),
    gemini: ({ provider }) => provider.protocol === "gemini",
  };
  const models = requested
    ? resolveRouteReference(requested, {
      selfId,
      kind: "video",
      targetMatches: aliasMatchers[alias],
    })
    : configuredModels;
  const routeId = formatModelList(models);

  const plan = createRouteExecutionPlan(models, {
    selfId,
    kind: "video",
  });
  if (plan.attempts.length === 0) {
    throw new Error(`视频模型 ${routeId} 没有可用的供应商或 Key。`);
  }
  return { routeId, plan };
}

function videoConfigFromRouteAttempt(attempt) {
  const config = attempt.requestConfig;
  return {
    name: config.name,
    provider: config.channelType === "gemini"
      ? "gemini"
      : config.videoApiFormat === "openai" ? "openai" : "grok",
    vertex: config.vertex === true,
    model: config.model,
    baseURL: config.baseURL,
    api: config.apiKey,
    apiKey: config.apiKey,
    serviceAccountRef: config.serviceAccountRef,
    timeoutMs: config.timeoutMs,
    routeTarget: true,
  };
}

function dataUrlParts(value) {
  const matched = `${value || ""}`.match(/^data:([^;]+);base64,(.+)$/is);
  if (!matched) return null;
  return { mimeType: matched[1], data: matched[2] };
}

async function normalizeImageInput(input) {
  if (!input) return null;
  if (Buffer.isBuffer(input)) {
    return { type: "image", data: input.toString("base64"), mime_type: "image/png" };
  }
  if (typeof input === "string") {
    const inline = dataUrlParts(input);
    if (inline) {
      return { type: "image", data: inline.data, mime_type: inline.mimeType };
    }
    const response = await fetch(input);
    if (!response.ok) {
      throw new Error(`参考图下载失败：HTTP ${response.status}`);
    }
    return {
      type: "image",
      data: Buffer.from(await response.arrayBuffer()).toString("base64"),
      mime_type: response.headers.get("content-type") || "image/jpeg",
    };
  }
  if (input.base64) {
    const inline = dataUrlParts(input.base64);
    return {
      type: "image",
      data: inline?.data || `${input.base64}`,
      mime_type: input.mimeType || inline?.mimeType || "image/jpeg",
    };
  }
  if (input.inlineData?.data) {
    return {
      type: "image",
      data: input.inlineData.data,
      mime_type: input.inlineData.mimeType || "image/jpeg",
    };
  }
  if (input.buffer) {
    const buffer = Buffer.isBuffer(input.buffer)
      ? input.buffer
      : Buffer.from(input.buffer);
    return {
      type: "image",
      data: buffer.toString("base64"),
      mime_type: input.mimeType || "image/png",
    };
  }
  if (input.url) return normalizeImageInput(input.url);
  return null;
}

async function buildGeminiInput(prompt, images = []) {
  const normalizedImages = (
    await Promise.all(images.slice(0, 10).map(normalizeImageInput))
  ).filter(Boolean);
  const promptText = `${prompt || ""}`.trim() ||
    "Animate the provided image into a natural, coherent video.";

  if (normalizedImages.length === 0) {
    return { input: promptText, imageCount: 0 };
  }

  return {
    input: [...normalizedImages, { type: "text", text: promptText }],
    imageCount: normalizedImages.length,
  };
}

function videoTaskSuffix(model) {
  return `${model || ""}`.match(/-(t2v|i2v|multi)$/i)?.[1]?.toLowerCase() || null;
}

function normalizeOpenAIVideoOptions(options, imageCount, modelName) {
  // 同一站点下各模型的比例、分辨率、时长范围差别很大（Seedance 默认 720p，MiniMax H3 只认
  // 480p/608p… 和 16:9/9:16），本地猜不准。只传用户明确写了的参数，其余用模型默认值，
  // 不合法时由上游返回具体原因。没有 explicit 标记的调用方视为全部显式。
  const explicit = options.explicit;
  const pick = (key) => {
    const value = options[key];
    if (value == null || value === "auto") return null;
    return !explicit || explicit[key] === true ? value : null;
  };
  const normalized = {
    aspectRatio: pick("aspectRatio"),
    duration: pick("duration"),
    resolution: pick("resolution"),
  };
  const warnings = [];
  let model = `${modelName || ""}`;
  const suffix = videoTaskSuffix(model);

  // 后缀决定任务类型：有图却选了文生模型、没图却选了图生模型时，换成同系列的对应模型。
  if (suffix === "t2v" && imageCount > 0) {
    const swapped = model.replace(/-t2v$/i, "-i2v");
    warnings.push(`${model} 是文生视频模型，带了参考图，已改用 ${swapped}`);
    model = swapped;
  } else if ((suffix === "i2v" || suffix === "multi") && imageCount === 0) {
    const swapped = model.replace(/-(i2v|multi)$/i, "-t2v");
    warnings.push(`${model} 需要参考图，没有图片，已改用 ${swapped}`);
    model = swapped;
  }

  const finalSuffix = videoTaskSuffix(model);
  const imageLimit = finalSuffix ? OPENAI_VIDEO_REFERENCE_LIMITS[finalSuffix] : imageCount;
  if (imageCount > imageLimit) {
    warnings.push(
      `${model} 最多支持 ${imageLimit} 张参考图，已忽略其余 ${imageCount - imageLimit} 张`
    );
  }
  if (finalSuffix === "i2v" && Math.min(imageCount, imageLimit) === 2) {
    warnings.push("图生视频模型会把第 2 张图当作尾帧");
  }

  return { options: normalized, imageLimit, warnings, model };
}

export function normalizeVideoGenerationOptions(
  provider,
  options = {},
  imageCount = 0,
  modelName = ""
) {
  if (provider === "openai") {
    return normalizeOpenAIVideoOptions(options, imageCount, modelName);
  }

  const normalized = { ...options };
  const warnings = [];
  const referenceLimit = VIDEO_REFERENCE_LIMITS[provider];
  let imageLimit = referenceLimit || imageCount;

  if (referenceLimit && imageCount > referenceLimit) {
    warnings.push(
      `${provider === "gemini" ? "Gemini Omni" : "Grok"} 最多支持 ${referenceLimit} 张参考图，已忽略其余 ${imageCount - referenceLimit} 张`
    );
  }

  if (provider === "gemini") {
    if (normalized.aspectRatio === "auto") {
      normalized.aspectRatio = null;
    } else if (
      normalized.aspectRatio &&
      !GEMINI_ASPECT_RATIOS.has(normalized.aspectRatio)
    ) {
      const compatibleRatio = nearestSupportedAspectRatio(
        normalized.aspectRatio,
        GEMINI_ASPECT_RATIOS
      );
      warnings.push(
        `Gemini Omni 不支持 ${normalized.aspectRatio} 比例，已调整为同方向最接近的 ${compatibleRatio}`
      );
      normalized.aspectRatio = compatibleRatio;
    }

    if (normalized.resolution && normalized.resolution !== "720p") {
      warnings.push(
        `Gemini Omni 固定使用 720p，已将 ${normalized.resolution} 调整为 720p`
      );
      normalized.resolution = "720p";
    }

    const duration = Number.parseInt(normalized.duration, 10);
    if (Number.isFinite(duration) && (duration < 3 || duration > 10)) {
      const compatibleDuration = clampInteger(duration, 3, 10);
      warnings.push(
        `Gemini Omni 支持 3–10 秒时长，已将 ${duration} 秒调整为 ${compatibleDuration} 秒`
      );
      normalized.duration = compatibleDuration;
    }
  }

  if (provider === "grok") {
    if (normalized.aspectRatio === "auto") {
      normalized.aspectRatio = null;
    } else if (normalized.aspectRatio) {
      const compatibleRatio = nearestSupportedAspectRatio(
        normalized.aspectRatio,
        GROK_CPA_ASPECT_RATIOS
      );
      if (compatibleRatio !== normalized.aspectRatio) {
        warnings.push(
          `Grok 视频不支持 ${normalized.aspectRatio} 比例，已调整为同方向最接近的 ${compatibleRatio}`
        );
        normalized.aspectRatio = compatibleRatio;
      }
    }

    const usesMultipleReferences = Math.min(imageCount, imageLimit) > 1;
    const requestedDuration = Number.parseInt(normalized.duration, 10);
    const maximumDuration = usesMultipleReferences ? 10 : 15;
    if (
      Number.isFinite(requestedDuration) &&
      (requestedDuration < 1 || requestedDuration > maximumDuration)
    ) {
      const compatibleDuration = clampInteger(
        requestedDuration,
        1,
        maximumDuration
      );
      warnings.push(
        `Grok ${usesMultipleReferences ? "多参考图模式" : "视频"}支持 1–${maximumDuration} 秒时长，已将 ${requestedDuration} 秒调整为 ${compatibleDuration} 秒`
      );
      normalized.duration = compatibleDuration;
    }

    if (
      normalized.resolution &&
      !GROK_CPA_VIDEO_RESOLUTIONS.has(normalized.resolution)
    ) {
      const requestedResolution = normalized.resolution;
      normalized.resolution = GROK_CPA_MAX_VIDEO_RESOLUTION;
      warnings.push(
        `Grok 经 CPA 最高支持 ${GROK_CPA_MAX_VIDEO_RESOLUTION}，已将 ${requestedResolution} 降为 ${GROK_CPA_MAX_VIDEO_RESOLUTION}`
      );
    }
  }

  return {
    options: normalized,
    imageLimit,
    warnings,
  };
}

async function notifyParameterWarnings(callback, warnings) {
  if (warnings.length > 0 && typeof callback === "function") {
    await callback(warnings);
  }
}

function extractVideoOutput(interaction) {
  if (interaction?.output_video) return interaction.output_video;

  for (let index = (interaction?.steps || []).length - 1; index >= 0; index--) {
    const step = interaction.steps[index];
    const video = step?.content?.find((item) => item?.type === "video");
    if (video) return video;
  }
  return null;
}

export async function generateGeminiOmniVideo(
  { prompt, images = [], options = {} },
  channelConfig = {}
) {
  const usesVertex = channelConfig.vertex === true;
  if (usesVertex && !channelConfig.serviceAccountRef) {
    throw new Error("Gemini Omni Vertex 视频目标未选择服务账号凭证。");
  }
  if (!usesVertex && !(channelConfig.apiKey || channelConfig.api)) {
    throw new Error("Gemini Omni 视频目标未配置 API Key。");
  }

  const { input, imageCount } = await buildGeminiInput(prompt, images);
  const ai = new GoogleGenAI(
    buildGeminiClientOptions({
      ...channelConfig,
      apiKey: channelConfig.apiKey || channelConfig.api,
      vertex: usesVertex,
      ...(usesVertex && { location: DEFAULT_VERTEX_LOCATION }),
    })
  );

  let interaction;
  try {
    interaction = await ai.interactions.create(
      {
        model: channelConfig.model || GEMINI_OMNI_MODEL,
        input,
        response_format: {
          type: "video",
          delivery: "inline",
          ...(options.aspectRatio && {
            aspect_ratio: options.aspectRatio,
          }),
          ...(options.duration && {
            duration: `${options.duration}s`,
          }),
        },
        generation_config: {
          video_config: {
            task: imageCount === 0
              ? "text_to_video"
              : imageCount === 1
                ? "image_to_video"
                : "reference_to_video",
          },
        },
        background: false,
        store: false,
        stream: false,
      },
      {
        timeout: Number.isFinite(channelConfig.timeoutMs)
          ? channelConfig.timeoutMs
          : VIDEO_GENERATION_TIMEOUT_MS,
        maxRetries: 0,
      }
    );
  } catch (error) {
    throw tagMediaError(error, "gemini", "video");
  }

  const videoOutput = extractVideoOutput(interaction);
  if (!videoOutput?.data) {
    const status = interaction?.status ? `，状态：${interaction.status}` : "";
    const uriHint = videoOutput?.uri ? "，接口返回了 URI 而非内联视频" : "";
    throw new Error(`Gemini Omni 没有返回视频数据${status}${uriHint}。`);
  }

  return {
    buffer: Buffer.from(videoOutput.data, "base64"),
    mimeType: videoOutput.mime_type || "video/mp4",
    interaction,
  };
}

function extensionFromMimeType(mimeType = "video/mp4") {
  if (mimeType === "video/quicktime") return "mov";
  if (mimeType === "video/webm") return "webm";
  return "mp4";
}

function extensionFromURL(url) {
  const dataMatch = `${url}`.match(/^data:video\/([^;]+)/i);
  if (dataMatch?.[1]) return extensionFromMimeType(`video/${dataMatch[1]}`);
  const urlMatch = `${url}`.match(/\.([a-z0-9]+)(?:[?#].*)?$/i);
  if (["mp4", "webm", "mov"].includes(urlMatch?.[1]?.toLowerCase())) {
    return urlMatch[1].toLowerCase();
  }
  return "mp4";
}

async function saveVideoBuffer(buffer, provider, extension = "mp4") {
  const targetPath = path.join(
    plugindata,
    provider,
    "videos",
    `video_${Date.now()}.${extension}`
  );
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, buffer);
  return targetPath;
}

async function generateWithGrok(channel, prompt, images, options) {
  const result = await generateGrokVideoAndWait(
    {
      prompt,
      imageUrls: images,
      duration: options.duration,
      aspectRatio: options.aspectRatio,
      resolution: options.resolution,
      model: channel.model,
    },
    channel
  );

  const targetPath = path.join(
    plugindata,
    "grok",
    "videos",
    `video_${Date.now()}.${extensionFromURL(result.videoURL)}`
  );
  try {
    return await downloadMedia(result.videoURL, targetPath, {}, channel.timeoutMs);
  } catch (error) {
    logger.warn(`[VideoProvider] Grok 视频下载失败，返回原始链接：${error.message}`);
    return result.videoURL;
  }
}

async function generateVideoOnce(channel, prompt, images, options) {
  const normalized = normalizeVideoGenerationOptions(
    channel.provider,
    options,
    images.length,
    channel.model
  );
  const compatibleImages = images.slice(0, normalized.imageLimit);
  const compatibleOptions = normalized.options;

  if (channel.provider === "grok") {
    try {
      return {
        result: {
          provider: "grok",
          source: await generateWithGrok(
            channel,
            prompt,
            compatibleImages,
            compatibleOptions
          ),
        },
        warnings: normalized.warnings,
      };
    } catch (error) {
      throw tagMediaError(error, "grok", "video");
    }
  }

  if (channel.provider === "openai") {
    try {
      return {
        result: {
          provider: "openai",
          source: await generateOpenAIVideoAndWait(
            {
              model: normalized.model,
              prompt,
              images: compatibleImages,
              seconds: compatibleOptions.duration
                ? String(compatibleOptions.duration)
                : undefined,
              metadata: {
                ...(compatibleOptions.aspectRatio && { ratio: compatibleOptions.aspectRatio }),
                ...(compatibleOptions.resolution && { resolution: compatibleOptions.resolution }),
              },
            },
            channel,
            path.join(plugindata, "openai", "videos")
          ),
        },
        warnings: normalized.warnings,
      };
    } catch (error) {
      throw tagMediaError(error, "openai", "video");
    }
  }

  if (channel.provider === "gemini") {
    try {
      const result = await generateGeminiOmniVideo(
        { prompt, images: compatibleImages, options: compatibleOptions },
        channel
      );
      return {
        result: {
          provider: "gemini",
          source: await saveVideoBuffer(
            result.buffer,
            "gemini",
            extensionFromMimeType(result.mimeType)
          ),
        },
        warnings: normalized.warnings,
      };
    } catch (error) {
      throw tagMediaError(error, "gemini", "video");
    }
  }

  throw new Error(`不支持的视频渠道类型：${channel.provider || "unknown"}`);
}

export async function generateVideoWithProvider({
  channel: requestedChannel = null,
  prompt,
  images = [],
  options = {},
  onParameterWarnings = null,
  selfId = null,
}) {
  const selection = resolveVideoSelection(requestedChannel, selfId);

  const { plan, routeId } = selection;
  const outcome = await executeRoutePlan({
    plan,
    routeId,
    run: (attempt) => generateVideoOnce(
      videoConfigFromRouteAttempt(attempt),
      prompt,
      images,
      options
    ),
  });
  if (outcome.ok) {
    await notifyParameterWarnings(onParameterWarnings, outcome.value.warnings);
    return outcome.value.result;
  }

  throw outcome.error || new Error(`视频模型 ${routeId} 没有可用的供应商。`);
}
