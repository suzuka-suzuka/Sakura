import http from "http";
import fs from "fs/promises";
import path from "path";
import { pluginresources } from "../path.js";
import Setting from "../setting.js";
import {
  destroySession,
  exchangeLoginCode,
  isLoginRateLimited,
  verifySession,
} from "./auth.js";
import { validateBaseURL, guardedFetch } from "./endpoint.js";
import { clearHistory, getChatProfile, getPublicProfile, saveProfile } from "./store.js";
import { getPrivateChatConfig, testChannel } from "./conversation.js";

// 私聊 AI 的用户设置页面。和配置面板完全分开：独立端口、独立的会话，只挂下面这几个接口，
// 普通用户的令牌碰不到面板的任何东西。建议只监听本机，由 nginx 等反代到 HTTPS 域名。

const STATIC_DIR = path.join(pluginresources, "private-chat");
const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MODEL_LENGTH = 200;
const MAX_API_KEY_LENGTH = 500;
const DEFAULT_PORT = 1136;
const DEFAULT_HOST = "127.0.0.1";

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

// 测试连接、拉模型列表会用用户的 Key 发外部请求，同一个人两次之间至少隔几秒
const lastOutboundAt = new Map();
const OUTBOUND_INTERVAL_MS = 3000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

async function serveStatic(res, pathname) {
  const entry = STATIC_FILES[pathname];
  if (!entry) return false;
  const [file, type] = entry;
  const content = await fs.readFile(path.join(STATIC_DIR, file));
  res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": type, "Cache-Control": "no-cache" });
  res.end(content);
  return true;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "提交的内容太长");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    throw new HttpError(400, "请求格式不对");
  }
}

/** 反代后真实 IP 在头里：优先 X-Real-IP，其次 X-Forwarded-For 最右边那个（由最近一层代理写入） */
function getClientKey(req) {
  const remote = req.socket.remoteAddress || "";
  const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (isLoopback) {
    const realIp = String(req.headers["x-real-ip"] || "").trim();
    if (realIp) return realIp;
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (forwarded.length) return forwarded[forwarded.length - 1];
  }
  return remote;
}

function getBearerToken(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : "";
}

async function requireUser(req) {
  const userId = await verifySession(getBearerToken(req));
  if (!userId) throw new HttpError(401, "登录已失效，请在私聊里重新发 #设置 获取登录码");
  return userId;
}

function throttleOutbound(userId) {
  const now = Date.now();
  if (now - (lastOutboundAt.get(userId) || 0) < OUTBOUND_INTERVAL_MS) {
    throw new HttpError(429, "操作太频繁，过几秒再试");
  }
  lastOutboundAt.set(userId, now);
  if (lastOutboundAt.size > 1000) {
    for (const [key, time] of lastOutboundAt) {
      if (now - time > OUTBOUND_INTERVAL_MS) lastOutboundAt.delete(key);
    }
  }
}

function readString(value, label, maxLength) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new HttpError(400, `${label}格式不对`);
  const text = value.trim();
  if (text.length > maxLength) throw new HttpError(400, `${label}不能超过 ${maxLength} 个字`);
  return text;
}

/** 测试和拉模型列表时：表单里填了新 Key 就用新的，没填就用已保存的 */
async function resolveDraftChannel(userId, body) {
  const saved = getChatProfile(userId);
  const baseURL = await validateBaseURL(readString(body.baseURL, "接口地址", 500)).catch((error) => {
    throw new HttpError(400, error.message);
  });
  const typedKey = readString(body.apiKey, "API Key", MAX_API_KEY_LENGTH);
  const apiKey = typedKey || saved?.apiKey || "";
  if (!apiKey) throw new HttpError(400, "请填写 API Key");
  return { userId, baseURL, apiKey, model: readString(body.model, "模型", MAX_MODEL_LENGTH) };
}

function profileResponse(userId) {
  const config = getPrivateChatConfig();
  return {
    ...getPublicProfile(userId),
    maxPersonaLength: Number(config.maxPersonaLength) || 4000,
  };
}

async function handleApi(req, res, pathname) {
  if (pathname === "/api/login" && req.method === "POST") {
    const clientKey = getClientKey(req);
    if (await isLoginRateLimited(clientKey)) {
      throw new HttpError(429, "尝试次数太多，过十分钟再试");
    }
    const body = await readJson(req);
    const session = await exchangeLoginCode(body.code, clientKey);
    if (!session) throw new HttpError(400, "登录码不对或已过期，请在私聊里重新发 #设置");
    return sendJson(res, 200, { token: session.token, profile: profileResponse(session.userId) });
  }

  if (pathname === "/api/me" && req.method === "GET") {
    const userId = await requireUser(req);
    return sendJson(res, 200, { profile: profileResponse(userId) });
  }

  if (pathname === "/api/me" && req.method === "PUT") {
    const userId = await requireUser(req);
    const body = await readJson(req);
    const config = getPrivateChatConfig();
    const maxPersonaLength = Number(config.maxPersonaLength) || 4000;
    const persona = readString(body.persona, "人设", maxPersonaLength);
    const model = readString(body.model, "模型", MAX_MODEL_LENGTH);
    const typedKey = readString(body.apiKey, "API Key", MAX_API_KEY_LENGTH);
    const baseURLInput = readString(body.baseURL, "接口地址", 500);
    let baseURL = "";
    if (baseURLInput) {
      try {
        baseURL = await validateBaseURL(baseURLInput);
      } catch (error) {
        throw new HttpError(400, error.message);
      }
    }
    const { personaChanged } = saveProfile(userId, {
      persona,
      baseURL,
      model,
      apiKey: typedKey || undefined,
    });
    logger.info(`[私聊AI] 用户 ${userId} 更新了设置${personaChanged ? "（人设有变化，已清空对话）" : ""}`);
    return sendJson(res, 200, { profile: profileResponse(userId), personaChanged });
  }

  if (pathname === "/api/test" && req.method === "POST") {
    const userId = await requireUser(req);
    throttleOutbound(userId);
    const draft = await resolveDraftChannel(userId, await readJson(req));
    if (!draft.model) throw new HttpError(400, "请填写模型");
    const result = await testChannel(draft, getPrivateChatConfig());
    return sendJson(res, 200, result);
  }

  if (pathname === "/api/models" && req.method === "POST") {
    const userId = await requireUser(req);
    throttleOutbound(userId);
    const draft = await resolveDraftChannel(userId, await readJson(req));
    let response;
    try {
      response = await guardedFetch(`${draft.baseURL}/models`, {
        headers: { Authorization: `Bearer ${draft.apiKey}` },
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw new HttpError(502, `获取模型列表失败：${error.message}`);
    }
    if (!response.ok) throw new HttpError(502, `获取模型列表失败：HTTP ${response.status}`);
    const data = await response.json().catch(() => null);
    const models = (Array.isArray(data?.data) ? data.data : [])
      .map((item) => String(item?.id || "").slice(0, MAX_MODEL_LENGTH))
      .filter(Boolean)
      .slice(0, 500);
    return sendJson(res, 200, { models });
  }

  if (pathname === "/api/history/clear" && req.method === "POST") {
    const userId = await requireUser(req);
    clearHistory(userId);
    return sendJson(res, 200, { profile: profileResponse(userId) });
  }

  if (pathname === "/api/logout" && req.method === "POST") {
    await destroySession(getBearerToken(req));
    return sendJson(res, 200, { ok: true });
  }

  throw new HttpError(404, "接口不存在");
}

async function handleRequest(req, res) {
  let pathname = "/";
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
      return;
    }
    if (req.method === "GET" && await serveStatic(res, pathname)) return;
    res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.message });
      return;
    }
    logger.error(`[私聊AI] 设置页面请求 ${pathname} 出错：${error.stack || error.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: "服务器出错了，请稍后再试" });
  }
}

// 开发环境改 lib 会按新版本重新导入本模块，模块里的变量跟着重置；
// 服务实例放在进程级的登记处，新版本模块接管同一个服务，只替换请求处理函数，不重复监听端口。
const REGISTRY_KEY = Symbol.for("sakura.privateChat.webServer");
const registry = globalThis[REGISTRY_KEY] ||= { server: null, key: "", handler: null };

async function stopServer() {
  const current = registry.server;
  if (!current) return;
  registry.server = null;
  registry.key = "";
  await new Promise((resolve) => {
    current.close(() => resolve());
    current.closeAllConnections?.();
  });
}

/**
 * 按当前配置启动、重启或关闭设置页面服务。插件每次加载（含配置变更后的重载）都会调用。
 * 总开关关掉时服务也关掉；按账号单独开关只影响私聊回复，不影响这个页面。
 */
export async function ensurePrivateChatWebServer() {
  registry.handler = handleRequest;
  const config = Setting.getConfig("PrivateChat") || {};
  const host = String(config.webHost || DEFAULT_HOST).trim() || DEFAULT_HOST;
  const port = Number(config.webPort) || DEFAULT_PORT;
  const key = config.enable === true ? `${host}:${port}` : "";
  if (key === registry.key) return;

  await stopServer();
  if (!key) return;

  const instance = http.createServer((req, res) => {
    registry.handler(req, res);
  });
  registry.server = instance;
  registry.key = key;
  await new Promise((resolve) => {
    instance.once("error", (error) => {
      logger.error(`[私聊AI] 设置页面服务启动失败（${host}:${port}）：${error.message}`);
      if (registry.server === instance) {
        registry.server = null;
        registry.key = "";
      }
      resolve();
    });
    instance.listen(port, host, () => {
      const publicUrl = normalizePublicUrl(config.publicUrl);
      logger.info(`[私聊AI] 设置页面已启动：http://${host}:${port}${publicUrl ? `，对外地址 ${publicUrl}` : ""}`);
      resolve();
    });
  });
}

export function normalizePublicUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}
