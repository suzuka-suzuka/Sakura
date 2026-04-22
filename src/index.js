import { OneBotWsClient } from "./core/wsClient.js";
import { MilkyClient } from "./adapters/milkyClient.js";
import { logger } from "./utils/logger.js";
import { OneBotApi, Segment, removeBot, getBot, rememberBotTargets } from "./api/client.js";
import { logEvent } from "./handlers/logging.js";
import { PluginLoader } from "./core/loader.js";
import { Command, OnEvent, plugin, Event, Cron } from "./core/plugin.js";
import { connectRedis } from "./utils/redis.js";
import Config from "./core/config.js";
import { installOsCompatPatch } from "./utils/osCompat.js";
import { startConfigServer } from "./web/configServer.js";

logger.info(logger.magenta("-----------------sakura框架-----------------"))
logger.info(logger.magenta("  ____   ____   __  __  __ __ _____   ____ "))
logger.info(logger.magenta(" (_ (_` / () \\ |  |/  /|  |  || () ) / () \\"))
logger.info(logger.magenta(".__)__)/__/\\__\\|__|\\__\\ \\___/ |_|\\_\\/__/\\__\\"))
logger.info(logger.magenta("                                            "))
logger.info(logger.magenta("-------------sakura框架加载成功-------------"))

global.logger = logger;
global.Command = Command;
global.OnEvent = OnEvent;
global.Cron = Cron;
global.plugin = plugin;
global.Event = Event;
global.segment = Segment;
global.bot = null;

installOsCompatPatch();

try {
  global.redis = await connectRedis();
} catch (e) {
  logger.error(`Redis 连接失败，程序退出: ${e}`);
  process.exit(1);
}

const loader = new PluginLoader();
await loader.loadPlugins();

// 启动配置面板
startConfigServer();

// =================== WebSocket 多客户端管理 ===================

/** 所有活跃的 WS 客户端 */
const wsClients = [];

/** selfId → { client, routeKey }，用于断线时精准清理对应 bot */
const selfIdToClient = new Map();

/** 当前生效的 ws 配置快照，用于热重载比对 */
let currentWsConfig = null;

/**
 * 为一个 WsClient 实例绑定所有事件监听
 * @param {OneBotWsClient} client
 * @param {string} label  日志标识，如 "正向" / "反向"
 */
function setupClient(client, label) {
  const tag = `[${label}]`;

  function bindSelfId(selfId, routeKey) {
    const id = Number(selfId);
    if (!Number.isFinite(id)) return;
    selfIdToClient.set(id, { client, routeKey: routeKey || label });
  }

  function cleanupBotsForRoute(routeKey, explicitSelfIds = []) {
    const normalizedSelfIds = explicitSelfIds
      .map((selfId) => Number(selfId))
      .filter((selfId) => Number.isFinite(selfId));

    if (normalizedSelfIds.length > 0) {
      for (const selfId of normalizedSelfIds) {
        const bound = selfIdToClient.get(selfId);
        if (bound?.client === client) {
          selfIdToClient.delete(selfId);
          removeBot(selfId);
        }
      }
      return;
    }

    for (const [selfId, bound] of selfIdToClient) {
      if (bound.client !== client) continue;
      if (routeKey && bound.routeKey !== routeKey) continue;
      selfIdToClient.delete(selfId);
      removeBot(selfId);
    }
  }

  // ---- 统一事件处理 ----
  function handleEvent(data) {
    if (!data || !data.post_type) return;

    const routeKey = data.__routeKey || label;

    if (data.self_id) {
      bindSelfId(data.self_id, routeKey);
      rememberBotTargets(data);
    }

    // 首次出现的 self_id → 注册 bot 实例
    if (data.self_id && !getBot(data.self_id)) {
      logger.info(`${tag} 检测到新的 Bot 实例: ${data.self_id}`);
      new OneBotApi(client, data.self_id);
    }

    logEvent(data);
    loader.deal(data);
  }

  client.on("message", handleEvent);
  client.on("message_sent", handleEvent);
  client.on("notice", handleEvent);
  client.on("request", handleEvent);
  client.on("meta_event", handleEvent);

  // ---- 连接管理 ----

  client.on("socket.open", (data = {}) => {
    const routeText = data.routeKey ? ` (${data.routeKey})` : "";
    logger.info(`${tag} WebSocket 连接成功${routeText}`);
  });

  client.on("socket.close", (data) => {
    const routeText = data.routeKey ? ` (${data.routeKey})` : "";
    logger.warn(`${tag} WebSocket 连接断开${routeText} [code: ${data.code}] ${data.reason || ""}`);
    cleanupBotsForRoute(data.routeKey, data.selfIds || []);
  });

  client.on("socket.error", (data) => {
    logger.error(`${tag} WebSocket 错误: ${data.error_type}`);
  });

  client.on("socket.connecting", () => {
    logger.info(`${tag} 正在重连...`);
  });

  // ---- 生命周期: 初始化 Bot ----

  client.on("meta_event.lifecycle.connect", async (data) => {
    if (!data.self_id) return;

    const routeKey = data.__routeKey || label;
    bindSelfId(data.self_id, routeKey);

    let botInstance = getBot(data.self_id);
    if (!botInstance) {
      logger.info(`${tag} 初始化 Bot 实例: ${data.self_id}`);
      botInstance = new OneBotApi(client, data.self_id);
    }

    try {
      const restartInfoStr = await redis.get("sakura:restart_info");
      if (restartInfoStr) {
        const info = JSON.parse(restartInfoStr);
        const timeTaken = ((Date.now() - info.start_time) / 1000).toFixed(2);
        const msg = `重启成功，用时 ${timeTaken} 秒`;

        if (info.source_type === "group") {
          await botInstance.sendGroupMsg(info.source_id, msg);
        } else {
          await botInstance.sendPrivateMsg(info.source_id, msg);
        }

        await redis.del("sakura:restart_info");
      }
    } catch (e) {
      logger.error(`${tag} 检查重启状态失败: ${e}`);
    }
  });
}

// =================== 客户端创建工厂 ===================

/**
 * 根据 ws 配置创建并启动所有客户端
 */
async function createAndStartClients(wsConfig) {
  const clients = [];

  const forwardEntries = Array.isArray(wsConfig.forward) ? wsConfig.forward : [];
  const reverseEntries = Array.isArray(wsConfig.reverse) ? wsConfig.reverse : [];
  const milkyEntries = Array.isArray(wsConfig.milky) ? wsConfig.milky : [];

  for (const [index, fwdCfg] of forwardEntries.entries()) {
    if (fwdCfg?.enable === false) continue;
    const url = fwdCfg?.url || "ws://127.0.0.1:3001";
    const label = `正向:${fwdCfg?.name || index + 1}`;
    logger.info(`[${label}] WebSocket: ${url}`);
    const client = new OneBotWsClient({
      mode: "forward",
      url,
      accessToken: fwdCfg?.accessToken || "",
      reconnectDelay: fwdCfg?.reconnectDelay ?? 5000,
      heartbeatInterval: fwdCfg?.heartbeatInterval ?? 30000,
    });
    setupClient(client, label);
    clients.push(client);
  }

  for (const [index, revCfg] of reverseEntries.entries()) {
    if (!revCfg?.enable) continue;
    const port = revCfg?.port || 3002;
    const label = `反向:${revCfg?.name || index + 1}`;
    logger.info(`[${label}] WebSocket 监听端口: ${port}`);
    const client = new OneBotWsClient({
      mode: "reverse",
      reversePort: port,
      accessToken: revCfg?.accessToken || "",
    });
    setupClient(client, label);
    clients.push(client);
  }

  for (const [index, milkyCfg] of milkyEntries.entries()) {
    if (!milkyCfg?.enable) continue;
    const url = milkyCfg?.url || "http://127.0.0.1:3000";
    const label = `Milky:${milkyCfg?.name || index + 1}`;
    logger.info(`[${label}] 协议连接: ${url}`);
    const client = new MilkyClient({
      url,
      accessToken: milkyCfg?.accessToken || "",
      reconnectDelay: milkyCfg?.reconnectDelay ?? 5000,
      heartbeatInterval: milkyCfg?.heartbeatInterval ?? 30000,
    });
    setupClient(client, label);
    clients.push(client);
  }

  if (clients.length === 0) {
    logger.warn("未启用任何连接，请检查配置 ws.forward / ws.reverse / ws.milky");
  }

  // 启动所有客户端
  for (const client of clients) {
    try {
      await client.connect();
    } catch (e) {
      logger.error(`连接失败: ${e}`);
    }
  }

  return clients;
}

/**
 * 断开并清理所有现有客户端
 */
function disconnectAllClients() {
  for (const client of wsClients) {
    try {
      client.disconnect();
    } catch (e) {
      logger.error(`断开连接失败: ${e}`);
    }
  }
  // 清理 selfIdToClient 和 bot 实例
  for (const [selfId, bound] of selfIdToClient) {
    if (wsClients.includes(bound.client)) {
      selfIdToClient.delete(selfId);
      removeBot(selfId);
    }
  }
  wsClients.length = 0;
}

// =================== 初始启动 ===================

currentWsConfig = Config.get("ws") || {};
const initialClients = await createAndStartClients(currentWsConfig);
wsClients.push(...initialClients);

// =================== 配置热重载 ===================

Config.onChange((newConfig) => {
  const newWsConfig = newConfig.ws || {};
  const oldWsConfig = currentWsConfig || {};

  // 深度比较 ws 配置，仅在变更时重连
  const changed =
    JSON.stringify(newWsConfig) !== JSON.stringify(oldWsConfig);

  if (!changed) return;

  logger.info("[Config] 检测到连接配置变更，正在重新连接...");
  currentWsConfig = newWsConfig;

  // 断开旧连接，用新配置创建新连接
  disconnectAllClients();
  createAndStartClients(newWsConfig).then((clients) => {
    wsClients.push(...clients);
  }).catch((e) => {
    logger.error(`[Config] 重新连接失败: ${e}`);
  });
});

// =================== 优雅退出处理 ===================

let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`收到 ${signal} 信号，正在优雅关闭...`);

  try {
    disconnectAllClients();
    logger.info("所有连接已断开");

    if (global.redis) {
      await global.redis.quit();
      logger.info("Redis 连接已关闭");
    }
  } catch (e) {
    logger.error(`关闭过程出错: ${e}`);
  }

  setTimeout(() => {
    process.exit(0);
  }, 500);
}

// 只监听 IPC 消息，不直接监听 SIGINT/SIGTERM
// 因为父进程会通过 IPC 发送 shutdown 消息
process.on("message", (msg) => {
  if (msg === "shutdown") {
    gracefulShutdown("IPC shutdown");
  }
});

// 作为备用，如果直接运行此脚本（不通过 app.js）
if (!process.send) {
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
}

process.on("disconnect", () => {
  gracefulShutdown("IPC disconnect");
});

export { bot as api } from "./api/client.js";
