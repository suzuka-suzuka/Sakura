// 标准 OpenAI Videos API（POST /videos → GET /videos/{id} → /videos/{id}/content）。
// 主要面向 Seedance、可灵等中转站：模型名后缀 -t2v / -i2v / -multi 决定任务类型，
// 其余生成参数放在 metadata 里。参考图必须是公网直链，base64 图先经 /files/upload 换链接，
// 上传接口不存在时退回 multipart 的 input_reference（只能带首帧一张）。
import fs from "node:fs/promises";
import path from "node:path";
import {
  VIDEO_GENERATION_POLL_INTERVAL_MS,
  VIDEO_GENERATION_TIMEOUT_MS,
} from "./videoGenerationConstants.js";

const API_DISPLAY_NAME = "OpenAI Videos 接口";
const COMPLETE_STATUSES = new Set(["completed", "succeeded", "success"]);
const FAILED_STATUSES = new Set(["failed", "error", "expired", "cancelled", "canceled"]);

function trimTrailingSlash(value) {
  return `${value || ""}`.trim().replace(/\/+$/, "");
}

function normalizeConfig(raw = {}) {
  const baseURL = trimTrailingSlash(raw.baseURL || raw.baseUrl);
  if (!baseURL) {
    throw new Error(`${API_DISPLAY_NAME}未配置 API 地址。`);
  }
  const timeoutMs = Number(raw.timeoutMs);
  return {
    baseURL,
    apiKey: `${raw.apiKey || raw.api || ""}`.trim(),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : VIDEO_GENERATION_TIMEOUT_MS,
  };
}

function authHeaders(config) {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request(config, endpoint, { method = "GET", json = null, form = null, timeoutMs } = {}) {
  const headers = authHeaders(config);
  let body;
  if (json != null) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form != null) {
    body = form;
  }

  const timeout = timeoutMs ?? config.timeoutMs;
  let response;
  try {
    response = await fetch(`${config.baseURL}${endpoint}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new Error(
        `${API_DISPLAY_NAME}请求超时：${method} ${endpoint} 超过 ${timeout} 毫秒。`,
        { cause: error }
      );
    }
    throw error;
  }

  const payload = await readResponseBody(response);
  if (!response.ok) {
    const message = typeof payload === "string"
      ? payload
      : payload?.error?.message || JSON.stringify(payload || {});
    const error = new Error(
      `${API_DISPLAY_NAME}请求失败：${method} ${endpoint} 返回 ${response.status}，${`${message}`.slice(0, 500)}`
    );
    error.status = response.status;
    throw error;
  }
  return payload;
}

function dataUrlParts(value) {
  const matched = `${value || ""}`.match(/^data:([^;,]+);base64,(.+)$/is);
  if (!matched) return null;
  return { mimeType: matched[1], buffer: Buffer.from(matched[2], "base64") };
}

/** 把各种形态的参考图统一成 { url } 或 { buffer, mimeType }。 */
export function normalizeReferenceImage(input) {
  if (!input) return null;
  if (Buffer.isBuffer(input)) return { buffer: input, mimeType: "image/png" };
  if (typeof input === "string") {
    const text = input.trim();
    if (/^https?:\/\//i.test(text)) return { url: text };
    return dataUrlParts(text);
  }
  if (input.url) return normalizeReferenceImage(input.url);
  if (input.base64) {
    const inline = dataUrlParts(input.base64);
    if (inline) return inline;
    return { buffer: Buffer.from(`${input.base64}`, "base64"), mimeType: input.mimeType || "image/jpeg" };
  }
  if (input.inlineData?.data) {
    return {
      buffer: Buffer.from(input.inlineData.data, "base64"),
      mimeType: input.inlineData.mimeType || "image/jpeg",
    };
  }
  if (input.buffer) {
    return {
      buffer: Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer),
      mimeType: input.mimeType || "image/png",
    };
  }
  return null;
}

function extensionFromMime(mimeType = "") {
  if (/png/i.test(mimeType)) return "png";
  if (/webp/i.test(mimeType)) return "webp";
  return "jpg";
}

function imageBlob(image) {
  return new Blob([image.buffer], { type: image.mimeType || "image/png" });
}

async function uploadReferenceImage(config, image, index) {
  const form = new FormData();
  form.append("file", imageBlob(image), `reference_${index + 1}.${extensionFromMime(image.mimeType)}`);
  const payload = await request(config, "/files/upload", {
    method: "POST",
    form,
    timeoutMs: Math.min(config.timeoutMs, 120000),
  });
  const url = payload?.url || payload?.data?.url;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    throw new Error(`${API_DISPLAY_NAME}的素材上传没有返回链接。`);
  }
  return url;
}

/**
 * 把参考图都换成公网直链。上传接口不存在（404/405）时返回 null，交给调用方走 multipart。
 */
async function resolveReferenceURLs(config, images) {
  const urls = [];
  for (const [index, image] of images.entries()) {
    if (image.url) {
      urls.push(image.url);
      continue;
    }
    try {
      urls.push(await uploadReferenceImage(config, image, index));
    } catch (error) {
      if (error?.status === 404 || error?.status === 405) return null;
      throw error;
    }
  }
  return urls;
}

function videoTaskType(model) {
  return `${model || ""}`.match(/-(t2v|i2v|multi)$/i)?.[1]?.toLowerCase() || null;
}

function buildJsonRequest({ model, prompt, seconds, metadata }, imageURLs) {
  const body = { model };
  if (prompt) body.prompt = prompt;
  if (seconds) body.seconds = seconds;
  const meta = { ...metadata };

  if (imageURLs.length > 0) {
    if (videoTaskType(model) === "multi") {
      meta.content = imageURLs.map((url) => ({ type: "image_url", image_url: { url } }));
    } else {
      body.images = imageURLs;
    }
  }
  if (Object.keys(meta).length > 0) body.metadata = meta;
  return body;
}

function buildMultipartRequest({ model, prompt, seconds, metadata }, image) {
  const form = new FormData();
  form.append("model", model);
  if (prompt) form.append("prompt", prompt);
  if (seconds) form.append("seconds", seconds);
  if (Object.keys(metadata).length > 0) form.append("metadata", JSON.stringify(metadata));
  form.append(
    "input_reference",
    imageBlob(image),
    `input_reference.${extensionFromMime(image.mimeType)}`
  );
  return form;
}

function extractTaskId(payload) {
  for (const value of [payload?.id, payload?.task_id, payload?.data?.id, payload?.data?.task_id]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function extractResultURL(payload) {
  for (const value of [
    payload?.metadata?.url,
    payload?.url,
    payload?.video_url,
    payload?.output?.url,
    payload?.data?.url,
  ]) {
    if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) return value.trim();
  }
  return null;
}

function payloadError(payload) {
  const error = payload?.error;
  if (!error) return "";
  if (typeof error === "string") return error;
  return [error.code, error.message].filter(Boolean).join("：") || JSON.stringify(error);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function submitVideoTask(config, params, images) {
  const imageURLs = images.length > 0 ? await resolveReferenceURLs(config, images) : [];
  if (imageURLs) {
    return request(config, "/videos", {
      method: "POST",
      json: buildJsonRequest(params, imageURLs),
    });
  }

  // 没有上传接口：标准 OpenAI 只接受一张 input_reference 作为首帧。
  logger.warn(`[OpenAI Videos] ${config.baseURL} 没有 /files/upload，改用 multipart 上传首帧参考图`);
  return request(config, "/videos", {
    method: "POST",
    form: buildMultipartRequest(params, images[0]),
  });
}

async function pollVideoTask(config, taskId, deadline) {
  while (Date.now() < deadline) {
    const payload = await request(config, `/videos/${encodeURIComponent(taskId)}`, {
      timeoutMs: Math.max(1000, Math.min(60000, deadline - Date.now())),
    });
    const status = `${payload?.status || ""}`.toLowerCase();
    if (COMPLETE_STATUSES.has(status)) return payload;
    if (FAILED_STATUSES.has(status)) {
      throw new Error(`视频生成失败：${payloadError(payload) || status}`);
    }

    const waitMs = Math.min(VIDEO_GENERATION_POLL_INTERVAL_MS, deadline - Date.now());
    if (waitMs > 0) await wait(waitMs);
  }

  throw new Error(
    `视频生成超时：等待 ${Math.round(config.timeoutMs / 1000)} 秒后仍未完成（任务 ${taskId}）。`
  );
}

async function fetchVideoBuffer(url, headers, timeoutMs) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(Math.max(30000, timeoutMs)),
  });
  if (!response.ok) {
    throw new Error(`视频下载失败：HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * 提交并等待视频任务完成，下载到 targetDir。
 * 下载失败时返回结果直链（若有），交给上层回退为发链接。
 */
export async function generateOpenAIVideoAndWait(
  { model, prompt, images = [], seconds, metadata = {} },
  rawConfig = {},
  targetDir
) {
  const config = normalizeConfig(rawConfig);
  const deadline = Date.now() + config.timeoutMs;
  const references = images.map(normalizeReferenceImage).filter(Boolean);
  const params = { model, prompt, seconds, metadata };

  const created = await submitVideoTask(config, params, references);
  const taskId = extractTaskId(created);
  if (!taskId) {
    throw new Error(`${API_DISPLAY_NAME}没有返回视频任务 ID。`);
  }

  const status = `${created?.status || ""}`.toLowerCase();
  const finished = COMPLETE_STATUSES.has(status)
    ? created
    : await pollVideoTask(config, taskId, deadline);

  const resultURL = extractResultURL(finished);
  const remainingMs = Math.max(0, deadline - Date.now());
  let buffer;
  try {
    buffer = resultURL
      ? await fetchVideoBuffer(resultURL, {}, remainingMs)
      : await fetchVideoBuffer(
        `${config.baseURL}/videos/${encodeURIComponent(taskId)}/content`,
        authHeaders(config),
        remainingMs
      );
  } catch (error) {
    if (resultURL) {
      logger.warn(`[OpenAI Videos] 视频下载失败，返回原始链接：${error.message}`);
      return resultURL;
    }
    throw error;
  }

  const targetPath = path.join(targetDir, `video_${Date.now()}.mp4`);
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(targetPath, buffer);
  return targetPath;
}
