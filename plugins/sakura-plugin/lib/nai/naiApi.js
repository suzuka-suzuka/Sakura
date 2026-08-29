import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import Setting from "../setting.js";

const DEFAULT_MODEL = "nai-diffusion-4-5-full";
const DEFAULT_NEGATIVE =
    "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page";
const DEFAULT_STEPS = 28;
const QUALITY_TAGS = ["very aesthetic", "masterpiece"];
const NO_TEXT_TAG = "no text";
const MANAGED_PROMPT_TAGS = new Set([...QUALITY_TAGS, NO_TEXT_TAG]);
const NAI_SUBSCRIPTION_URL = "https://image.novelai.net/user/subscription";
const NAI_USAGE_MIN_PERCENT = 5;
const NAI_USAGE_FALLBACK_COOLDOWN_SECONDS = 60;
const NAI_OPUS_TIER = 3;
const NAI_FREE_MAX_PIXELS = 1024 * 1024;
const NAI_FREE_MAX_STEPS = 28;
const NAI_IMAGE_RETRY_DELAYS_MS = [10_000, 20_000, 30_000];
const NAI_RETRYABLE_NETWORK_CODES = new Set([
    "ABORT_ERR",
    "EAI_AGAIN",
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETDOWN",
    "ENETUNREACH",
    "ENOTFOUND",
    "EPIPE",
    "ERR_STREAM_PREMATURE_CLOSE",
    "ETIMEDOUT",
    "UND_ERR_ABORTED",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
    "UND_ERR_SOCKET",
]);
const NAI_RETRYABLE_NETWORK_MESSAGE =
    /(?:terminated|fetch failed|network error|socket hang up|timed?\s*out|timeout|connection (?:reset|refused|closed)|premature close|other side closed|econnreset|econnrefused|etimedout|eai_again|enotfound|网络(?:错误|异常|中断)|连接(?:重置|超时|中断|失败))/i;

const MODEL_PROFILES = {
    v5: {
        family: "v5",
        paramsVersion: 4,
        scale: 7,
        steps: DEFAULT_STEPS,
        legacyUc: false,
        skipCfgAboveSigma: null,
        maxCharacters: 32,
        supportsVibe: false,
        characterPositionGrid: null,
    },
    v45: {
        family: "v4.5",
        paramsVersion: 4,
        scale: 5,
        steps: DEFAULT_STEPS,
        legacyUc: false,
        skipCfgAboveSigma: null,
        maxCharacters: 6,
        supportsVibe: true,
        characterPositionGrid: 5,
    },
    v4: {
        family: "v4",
        paramsVersion: 4,
        scale: 5.5,
        steps: DEFAULT_STEPS,
        legacyUc: true,
        skipCfgAboveSigma: null,
        maxCharacters: 6,
        supportsVibe: true,
        characterPositionGrid: 5,
    },
    legacy: {
        family: "legacy",
        paramsVersion: 3,
        scale: 5,
        steps: DEFAULT_STEPS,
        legacyUc: false,
        skipCfgAboveSigma: 58,
        maxCharacters: null,
        supportsVibe: true,
        characterPositionGrid: null,
    },
};

const VIBE_PARAMETER_KEYS = [
    "reference_image_multiple",
    "reference_information_extracted_multiple",
    "reference_strength_multiple",
];

const queue = [];
let isProcessing = false;

function normalizePromptTag(tag) {
    return String(tag || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function mergeManagedPromptTags(visualPrompt, hasVisibleTextIntent) {
    const promptParts = String(visualPrompt || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    const mergedParts = [];
    const seenManagedTags = new Set();

    for (const part of promptParts) {
        const normalized = normalizePromptTag(part);
        if (MANAGED_PROMPT_TAGS.has(normalized)) {
            if (normalized === NO_TEXT_TAG && hasVisibleTextIntent) continue;
            if (seenManagedTags.has(normalized)) continue;
            seenManagedTags.add(normalized);
        }
        mergedParts.push(part);
    }

    for (const tag of QUALITY_TAGS) {
        if (seenManagedTags.has(tag)) continue;
        seenManagedTags.add(tag);
        mergedParts.push(tag);
    }
    if (!hasVisibleTextIntent && !seenManagedTags.has(NO_TEXT_TAG)) {
        mergedParts.push(NO_TEXT_TAG);
    }

    return mergedParts.join(", ");
}

export function appendNaiQualityTags(prompt) {
    const input = String(prompt || "").trim();
    const textBlockIndex = input.search(/\bText\s*:/i);
    const visualPrompt = (textBlockIndex >= 0
        ? input.slice(0, textBlockIndex)
        : input
    ).replace(/[\s,]+$/g, "");
    const textBlock = textBlockIndex >= 0
        ? input.slice(textBlockIndex).trim()
        : "";
    const visiblePromptWithoutNoText = visualPrompt.replace(
        /\bno\s+text\b/gi,
        "",
    );
    const hasVisibleTextIntent = Boolean(textBlock) ||
        /\b(?:english|japanese|chinese)?\s*text\b/i.test(
            visiblePromptWithoutNoText,
        );
    const mergedPrompt = mergeManagedPromptTags(
        visualPrompt,
        hasVisibleTextIntent,
    );

    return textBlock ? `${mergedPrompt}\n${textBlock}` : mergedPrompt;
}

export function wantsNaiTransparentBackground(prompt) {
    return /\b(?:transparent background|has alpha|alpha transparency)\b/i.test(
        String(prompt || ""),
    );
}

function getNaiUsageCooldownKey(token) {
    const tokenHash = createHash("sha256")
        .update(String(token))
        .digest("hex")
        .slice(0, 24);
    return `sakura:nai:usage-limit:${tokenHash}`;
}

function normalizeCooldownSeconds(timeUntilNextPercent) {
    const seconds = Number(timeUntilNextPercent);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return NAI_USAGE_FALLBACK_COOLDOWN_SECONDS;
    }
    return Math.max(1, Math.ceil(seconds));
}

function formatCooldownDuration(seconds) {
    const totalSeconds = Math.max(1, Math.ceil(Number(seconds) || 1));
    if (totalSeconds < 60) return `${totalSeconds} 秒`;

    const totalMinutes = Math.ceil(totalSeconds / 60);
    if (totalMinutes < 60) return `${totalMinutes} 分钟`;

    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

function createUsageLimitError(
    percent,
    cooldownSeconds,
    { tier = null, active = false } = {},
) {
    const percentText = Number.isFinite(Number(percent))
        ? `${Number(percent)}%`
        : "未知";
    const error = new Error(
        `NovelAI V5 用量仅剩 ${percentText}，已暂停生图；预计 ${formatCooldownDuration(cooldownSeconds)}后恢复下一档，请稍后再试`,
    );
    error.code = "NAI_USAGE_LIMIT";
    error.percent = percent;
    error.cooldownSeconds = cooldownSeconds;
    error.subscriptionTier = tier;
    error.subscriptionActive = Boolean(active);
    return error;
}

export async function checkNaiUsageLimit(
    token,
    {
        redisClient = global.redis,
        fetchImpl = global.fetch,
    } = {},
) {
    if (!redisClient) {
        throw new Error("Redis 未连接，无法验证 NovelAI 用量，已停止生图");
    }
    if (typeof fetchImpl !== "function") {
        throw new Error("无法请求 NovelAI 用量接口，已停止生图");
    }

    const cooldownKey = getNaiUsageCooldownKey(token);
    let cooldown;
    try {
        cooldown = await redisClient.get(cooldownKey);
    } catch (error) {
        throw new Error(
            `读取 NovelAI 用量冷却失败，已停止生图：${error.message}`,
        );
    }

    if (cooldown) {
        let ttl = NAI_USAGE_FALLBACK_COOLDOWN_SECONDS;
        try {
            const redisTtl = await redisClient.ttl(cooldownKey);
            if (redisTtl > 0) ttl = redisTtl;
        } catch {
            // 冷却已生效，TTL 查询失败时仍保持保守拒绝。
        }

        let lockedUsage = {};
        try {
            lockedUsage = JSON.parse(cooldown);
        } catch {
            lockedUsage = {};
        }
        throw createUsageLimitError(lockedUsage.percent, ttl, {
            tier: lockedUsage.tier,
            active: lockedUsage.active,
        });
    }

    let response;
    try {
        response = await fetchImpl(NAI_SUBSCRIPTION_URL, {
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${token}`,
            },
        });
    } catch (error) {
        throw new Error(
            `NovelAI 用量查询失败，已停止生图：${error.message}`,
        );
    }

    if (!response.ok) {
        throw new Error(
            `NovelAI 用量查询失败（HTTP ${response.status}），已停止生图`,
        );
    }

    let subscription;
    try {
        subscription = await response.json();
    } catch {
        throw new Error("NovelAI 用量接口返回异常，已停止生图");
    }

    const usage = subscription?.usage;
    const rawPercent = Number(usage?.percent);
    if (!usage || !Number.isFinite(rawPercent)) {
        throw new Error("NovelAI 未返回有效的用量限制，已停止生图");
    }

    const percent = usage.isNegative
        ? 0
        : Math.max(0, Math.min(100, rawPercent));
    const tier = Number(subscription?.tier);
    const active = Boolean(subscription?.active);
    const cooldownSeconds = normalizeCooldownSeconds(
        usage.timeUntilNextPercent,
    );

    if (percent <= NAI_USAGE_MIN_PERCENT) {
        const lockValue = JSON.stringify({
            percent,
            timeUntilNextPercent: cooldownSeconds,
            tier,
            active,
            lockedAt: Date.now(),
        });
        try {
            await redisClient.set(
                cooldownKey,
                lockValue,
                "EX",
                cooldownSeconds,
            );
        } catch (error) {
            throw new Error(
                `设置 NovelAI 用量冷却失败，已停止生图：${error.message}`,
            );
        }
        throw createUsageLimitError(percent, cooldownSeconds, {
            tier,
            active,
        });
    }

    return {
        percent,
        isNegative: Boolean(usage.isNegative),
        timeUntilNextPercent: cooldownSeconds,
        tier,
        active,
    };
}

export function getNaiModelProfile(model = DEFAULT_MODEL) {
    const modelName = String(model || DEFAULT_MODEL).toLowerCase();

    if (modelName.startsWith("nai-diffusion-5-")) {
        return MODEL_PROFILES.v5;
    }
    if (modelName.startsWith("nai-diffusion-4-5-")) {
        return MODEL_PROFILES.v45;
    }
    if (modelName.startsWith("nai-diffusion-4-")) {
        return MODEL_PROFILES.v4;
    }
    return MODEL_PROFILES.legacy;
}

function hasVibeParameters(parameters) {
    return VIBE_PARAMETER_KEYS.some((key) => {
        const value = parameters?.[key];
        return Array.isArray(value) ? value.length > 0 : value != null;
    });
}

function normalizeCharacterCenter(center, profile) {
    const clamp = (value) =>
        Math.max(0, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : 0.5));
    const normalized = {
        x: clamp(center?.x),
        y: clamp(center?.y),
    };

    if (profile.characterPositionGrid !== 5) return normalized;

    // V4/V4.5 官方使用 5×5 网格，传入坐标吸附到各格中心。
    const snapToFiveGrid = (value) =>
        (Math.min(4, Math.floor(value * 5)) * 2 + 1) / 10;
    return {
        x: snapToFiveGrid(normalized.x),
        y: snapToFiveGrid(normalized.y),
    };
}

export function getNai45FallbackModel(model = DEFAULT_MODEL) {
    return String(model).toLowerCase().includes("curated")
        ? "nai-diffusion-4-5-curated"
        : "nai-diffusion-4-5-full";
}

export function resolveNaiModelForRequest(model = DEFAULT_MODEL, parameters = {}) {
    if (
        getNaiModelProfile(model).family === "v5" &&
        hasVibeParameters(parameters)
    ) {
        return getNai45FallbackModel(model);
    }
    return model;
}

export function isNai45ZeroAnlasGeneration(payload) {
    const parameters = payload?.parameters || {};
    const width = Number(parameters.width);
    const height = Number(parameters.height);
    const steps = Number(parameters.steps);
    const samples = Number(parameters.n_samples);

    return (
        payload?.action === "generate" &&
        Number.isFinite(width) &&
        Number.isFinite(height) &&
        width > 0 &&
        height > 0 &&
        width * height <= NAI_FREE_MAX_PIXELS &&
        Number.isFinite(steps) &&
        steps > 0 &&
        steps <= NAI_FREE_MAX_STEPS &&
        samples === 1
    );
}

export function canUseFreeNai45Fallback(payload, usageLimitError) {
    return (
        usageLimitError?.code === "NAI_USAGE_LIMIT" &&
        Number(usageLimitError.subscriptionTier) === NAI_OPUS_TIER &&
        usageLimitError.subscriptionActive === true &&
        isNai45ZeroAnlasGeneration(payload)
    );
}

export function buildNaiImagePayload({
    prompt,
    model = DEFAULT_MODEL,
    negative = DEFAULT_NEGATIVE,
    parameters = {},
    image = null,
    characters = [],
}) {
    const profile = getNaiModelProfile(model);
    const usePrompt = appendNaiQualityTags(prompt);
    const useNegative = negative || DEFAULT_NEGATIVE;
    const useCharacters = Array.isArray(characters) ? characters : [];

    if (!profile.supportsVibe && hasVibeParameters(parameters)) {
        throw new Error(
            "NovelAI V5 暂不支持画风（Vibe Transfer），请切换到 V4.5 模型后再使用",
        );
    }
    if (
        profile.maxCharacters != null &&
        useCharacters.length > profile.maxCharacters
    ) {
        throw new Error(
            `${profile.family} 模型最多支持 ${profile.maxCharacters} 个角色提示词`,
        );
    }

    const useCoords = useCharacters.length > 0;
    const positionedCharacters = useCharacters.map((char) => ({
        ...char,
        center: normalizeCharacterCenter(char.center, profile),
    }));
    const characterPrompts = positionedCharacters.map((char) => ({
        prompt: char.prompt,
        uc: char.uc || "",
        center: char.center,
        enabled: char.enabled !== false,
    }));
    const v4CharCaptions = positionedCharacters.map((char) => ({
        char_caption: char.prompt,
        centers: [char.center],
    }));
    const v4NegativeCharCaptions = positionedCharacters.map((char) => ({
        char_caption: char.uc || "",
        centers: [char.center],
    }));

    const generationParameters = {
        params_version: profile.paramsVersion,
        width: 832,
        height: 1216,
        scale: profile.scale,
        sampler: "k_euler_ancestral",
        steps: profile.steps,
        seed: Math.floor(Math.random() * 4294967296),
        n_samples: 1,
        autoSmea: false,
        dynamic_thresholding: false,
        controlnet_strength: 1,
        legacy: false,
        add_original_image: true,
        cfg_rescale: 0,
        noise_schedule: "karras",
        legacy_v3_extend: false,
        use_coords: useCoords,
        legacy_uc: profile.legacyUc,
        normalize_reference_strength_multiple: true,
        inpaintImg2ImgStrength: 1,
        characterPrompts,
        v4_prompt: {
            caption: {
                base_caption: usePrompt,
                char_captions: v4CharCaptions,
            },
            use_coords: useCoords,
            use_order: true,
        },
        v4_negative_prompt: {
            caption: {
                base_caption: useNegative,
                char_captions: v4NegativeCharCaptions,
            },
            legacy_uc: profile.legacyUc,
        },
        negative_prompt: useNegative,
        deliberate_euler_ancestral_bug: false,
        prefer_brownian: true,
        image_format: "png",
        ...(profile.skipCfgAboveSigma == null
            ? {}
            : { skip_cfg_above_sigma: profile.skipCfgAboveSigma }),
        ...(profile.family === "v5"
            ? {
                tag_hint_transparent_background:
                    wantsNaiTransparentBackground(prompt),
            }
            : {}),
        ...parameters,
    };

    // 模型协议版本不能被调用方的透传参数覆盖。
    generationParameters.params_version = profile.paramsVersion;
    // NAI 的多图请求会额外消耗 Anlas；批量生成必须由调用层拆成连续单图请求。
    generationParameters.n_samples = 1;
    if (profile.family === "v5") {
        generationParameters.noise_schedule = "karras";
    }

    if (image) {
        generationParameters.image = image;
        generationParameters.strength = parameters.strength ?? 0.7;
        generationParameters.noise = parameters.noise ?? 0;
    }

    return {
        input: usePrompt,
        model,
        action: image ? "img2img" : "generate",
        parameters: generationParameters,
    };
}

async function processQueue() {
    if (isProcessing) return;
    isProcessing = true;

    while (queue.length > 0) {
        const task = queue.shift();
        const { resolve, reject, params } = task;
        try {
            if (task.onStart) {
                task.onStart(queue.length);
            }
            const result = await _generateImage(...params);
            resolve(result);
        } catch (error) {
            reject(error);
        }
    }

    isProcessing = false;
}

export function getQueueLength() {
    return queue.length;
}

export function getIsProcessing() {
    return isProcessing;
}

export function generateImage(
    prompt,
    model = null,
    negative = null,
    parameters = {},
    image = null,
    characters = [],
) {
    return new Promise((resolve, reject) => {
        queue.push({
            resolve,
            reject,
            params: [prompt, model, negative, parameters, image, characters],
        });
        processQueue();
    });
}

export function generateImageWithCallback(
    prompt,
    model = null,
    negative = null,
    parameters = {},
    image = null,
    characters = [],
    onStart = null,
) {
    return new Promise((resolve, reject) => {
        queue.push({
            resolve,
            reject,
            params: [prompt, model, negative, parameters, image, characters],
            onStart,
        });
        processQueue();
    });
}

function getNaiErrorChain(error) {
    const chain = [];
    const seen = new Set();
    let current = error;

    while (current != null && !seen.has(current)) {
        chain.push(current);
        if (typeof current !== "object") break;
        seen.add(current);
        current = current.cause;
    }

    return chain;
}

function getNaiErrorStatus(error) {
    for (const item of getNaiErrorChain(error)) {
        if (typeof item !== "object" || item == null) continue;
        const status = Number(
            item.status ?? item.statusCode ?? item.response?.status,
        );
        if (Number.isInteger(status) && status > 0) return status;
    }
    return null;
}

function isRetryableNaiImageError(error) {
    if (getNaiErrorStatus(error) === 429) return true;

    return getNaiErrorChain(error).some((item) => {
        const code = String(item?.code || "").toUpperCase();
        if (NAI_RETRYABLE_NETWORK_CODES.has(code)) return true;

        const name = String(item?.name || "").toLowerCase();
        if (name === "aborterror" || name === "timeouterror") return true;

        const message = String(item?.message ?? item ?? "");
        return NAI_RETRYABLE_NETWORK_MESSAGE.test(message);
    });
}

function waitForNaiImageRetry(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function performNaiImageRequest(payload, token) {
    const response = await fetch("https://image.novelai.net/ai/generate-image", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        let errorText;
        try {
            errorText = await response.text();
        } catch (error) {
            const responseError = new Error(
                error?.message || String(error),
                { cause: error },
            );
            responseError.status = response.status;
            throw responseError;
        }

        const requestError = new Error(
            `API Request failed with status ${response.status}: ${errorText}`,
        );
        requestError.status = response.status;
        throw requestError;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const zip = new AdmZip(buffer);
    const zipEntries = zip.getEntries();

    if (zipEntries.length > 0) {
        return zipEntries[0].getData();
    }
    throw new Error("生成失败，未收到图片数据");
}

async function requestNaiImageWithRetry(payload, token) {
    for (let retryIndex = 0; ; retryIndex += 1) {
        try {
            return await performNaiImageRequest(payload, token);
        } catch (error) {
            const retryDelayMs = NAI_IMAGE_RETRY_DELAYS_MS[retryIndex];
            if (
                retryDelayMs == null ||
                !isRetryableNaiImageError(error)
            ) {
                throw error;
            }

            const retryNumber = retryIndex + 1;
            const reason = getNaiErrorStatus(error) === 429
                ? "HTTP 429"
                : (error?.message || String(error));
            global.logger?.warn?.(
                `[NAI] 生图请求失败（${reason}），${retryDelayMs / 1000} 秒后进行第 ${retryNumber}/${NAI_IMAGE_RETRY_DELAYS_MS.length} 次重试`,
            );
            await waitForNaiImageRetry(retryDelayMs);
        }
    }
}

async function _generateImage(
    prompt,
    model = null,
    negative = null,
    parameters = {},
    image = null,
    characters = [],
) {
    const config = Setting.getConfig("nai");
    if (!config || !config.token) {
        throw new Error("请先在配置中设置 NovelAI Token");
    }

    const requestedModel = model || config.model || DEFAULT_MODEL;
    const useNegative = negative || config.negative || DEFAULT_NEGATIVE;
    let useModel = resolveNaiModelForRequest(requestedModel, parameters);

    if (useModel !== requestedModel) {
        logger.warn(
            `[NAI] V5 暂不支持 Vibe Transfer，已自动切换为 ${useModel}`,
        );
    }

    let payload = buildNaiImagePayload({
        prompt,
        model: useModel,
        negative: useNegative,
        parameters,
        image,
        characters,
    });

    if (
        useModel !== requestedModel &&
        !isNai45ZeroAnlasGeneration(payload)
    ) {
        throw new Error(
            "Vibe Transfer 已切换到 V4.5，但当前请求包含底图或超出免费规格，已停止生图以避免消耗 Anlas",
        );
    }

    if (getNaiModelProfile(useModel).family === "v5") {
        try {
            await checkNaiUsageLimit(config.token);
        } catch (error) {
            if (!canUseFreeNai45Fallback(payload, error)) {
                if (error.code === "NAI_USAGE_LIMIT") {
                    throw new Error(
                        `${error.message}；当前请求不符合 V4.5 免费条件，未自动降级以避免消耗 Anlas`,
                    );
                }
                throw error;
            }

            const fallbackModel = getNai45FallbackModel(useModel);
            try {
                payload = buildNaiImagePayload({
                    prompt,
                    model: fallbackModel,
                    negative: useNegative,
                    parameters,
                    image,
                    characters,
                });
            } catch (fallbackError) {
                throw new Error(
                    `${error.message}；自动降级 V4.5 失败：${fallbackError.message}`,
                );
            }
            useModel = fallbackModel;
            logger.warn(
                `[NAI] V5 用量为 ${error.percent}%，已自动切换为 ${useModel}`,
            );
        }
    }

    return requestNaiImageWithRetry(payload, config.token);
}

/**
 * 编码 Vibe Transfer 参考图片（V4+ 模型需要先编码才能使用）
 * @param {string} imageBase64 - 原始图片的 base64 数据
 * @returns {Promise<string>} 编码后的 vibe 数据（base64）
 */
export async function encodeVibe(imageBase64) {
    const config = Setting.getConfig("nai");
    if (!config || !config.token) {
        throw new Error("请先在配置中设置 NovelAI Token");
    }

    const configuredModel = config.model || DEFAULT_MODEL;
    const useModel = getNaiModelProfile(configuredModel).supportsVibe
        ? configuredModel
        : getNai45FallbackModel(configuredModel);

    if (useModel !== configuredModel) {
        logger.warn(
            `[NAI] V5 暂不支持 Vibe Transfer 编码，已自动切换为 ${useModel}`,
        );
    }

    const response = await fetch("https://image.novelai.net/ai/encode-vibe", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.token}`,
        },
        body: JSON.stringify({
            image: imageBase64,
            model: useModel,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
            `Vibe encode failed with status ${response.status}: ${errorText}`,
        );
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return buffer.toString("base64");
}
