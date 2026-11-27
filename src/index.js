import { OneBotWsClient } from "./core/wsClient.js";
import { MilkyClient } from "./adapters/milkyClient.js";
import { logger } from "./utils/logger.js";
import { OneBotApi, Segment, removeBot, getBot } from "./api/client.js";
import { logEvent } from "./handlers/logging.js";
import { PluginLoader } from "./core/loader.js";
import { Command, OnEvent, plugin, Event, Cron } from "./core/plugin.js";
import { connectRedis } from "./utils/redis.js";
import Config from "./core/config.js";
import { installOsCompatPatch } from "./utils/osCompat.js";
import { startConfigServer } from "./web/configServer.js";
import { isBotOfflineEvent } from "./core/botLifecycle.js";
import { onShutdown, shutdown } from "./core/shutdown.js";
import { warnLegacyAccountConfig } from "./core/legacyAccountConfig.js";
import { CONFIG_DIR, IS_DEFAULT_HOME, SAKURA_HOME } from "./utils/home.js";

logger.info(logger.magenta("-----------------sakura框架-----------------"))
logger.info(logger.magenta("  ____   ____   __  __  __ __ _____   ____ "))
logger.info(logger.magenta(" (_ (_` / () \\ |  |/  /|  |  || () ) / () \\"))
logger.info(logger.magenta(".__)__)/__/\\__\\|__|\\__\\ \\___/ |_|\\_\\/__/\\__\\"))
logger.info(logger.magenta("                                            "))
logger.info(logger.magenta("-------------sakura框架加载成功-------------"))
if (!IS_DEFAULT_HOME) {
  logger.info(`[实例] ${process.env.SAKURA_INSTANCE || "未命名实例"}，目录: ${SAKURA_HOME}`);
}

global.logger = logger;
global.Command = Command;
global.OnEvent = OnEvent;
global.Cron = Cron;
global.plugin = plugin;
global.Event = Event;
global.segment = Segment;
global.bot = null;

process.on("unhandledRejection", (reason) => {
  logger.error("[全局] 未处理的 Promise 拒绝:", reason);
});

process.on("uncaughtException", (err) => {
  logger.error("[全局] 未捕获异常:", err);
});

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

// =================== 连接管理 ===================
//
// 一个实例只服务一个 QQ 号。配了多条连接时它们必须连的是同一个号；
// 别的号连上来时它的事件一律忽略，并提示去另开实例。

/** 所有活跃的连接客户端 */
const wsClients = [];

/** 当前账号的事件从哪条连接来：{ client, routeKey }，断线时据此注销账号 */
let boundRoute = null;

/** 已经提醒过的外来账号，避免每条事件都刷一次日志 */
const warnedForeignAccounts = new Set();

/** 当前生效的 ws 配置快照，用于热重载比对 */
let currentWsConfig = null;

function isForeignAccount(selfId) {
  const current = getBot();
  return Boolean(current) && Number(selfId) !== Number(current.self_id);
}

function warnForeignAccount(tag, selfId) {
  const key = String(selfId);
  if (warnedForeignAccounts.has(key)) return;
  warnedForeignAccounts.add(key);
  logger.error(
    `${tag} 账号 ${selfId} 也连上来了，但这个实例正在服务账号 ${getBot()?.self_id}。` +
    `一个实例只服务一个号，${selfId} 的事件会被忽略；多个号请各开一个实例（见 docs/multi-instance.md）`
  );
}

/** 账号上线（或换了一条连接继续发事件）：记下连接，首次出现时创建 Bot 实例 */
function bindAccount(tag, client, selfId, routeKey) {
  boundRoute = { client, routeKey };
  let currentBot = getBot(selfId);
  if (!currentBot) {
    logger.info(`${tag} 账号上线: ${selfId}`);
    currentBot = new OneBotApi(client, selfId);
    warnLegacyAccountConfig(CONFIG_DIR, selfId, logger);
  }
  return currentBot;
}

/** 这条连接断了：当前账号正是从它来的就注销。routeKey 为空表示整个客户端都断了 */
function releaseRoute(client, routeKey) {
  if (!boundRoute || boundRoute.client !== client) return null;
  if (routeKey && boundRoute.routeKey !== routeKey) return null;
  const selfId = getBot()?.self_id ?? null;
  boundRoute = null;
  removeBot();
  return selfId;
}

/**
 * 为一个连接客户端绑定所有事件监听
 * @param {OneBotWsClient|MilkyClient} client
 * @param {string} label  日志标识，如 "正向" / "反向"
 */
function setupClient(client, label) {
  const tag = `[${label}]`;

  // ---- 统一事件处理 ----
  function handleEvent(data) {
    if (!data || !data.post_type) return;

    const routeKey = data.__routeKey || label;
    const isOffline = isBotOfflineEvent(data);

    if (data.self_id && isForeignAccount(data.self_id)) {
      if (!isOffline) warnForeignAccount(tag, data.self_id);
      return;
    }

    if (data.self_id && !isOffline) {
      bindAccount(tag, client, data.self_id, routeKey);
    }

    try {
      logEvent(data);
    } catch (err) {
      logger.error("[LogEvent] 记录事件失败:", err);
    }

    // deal() 会在首次异步让出前构造 Event 并保存当前 e.bot。
    // 随后立即注销，既让离线通知仍可使用原实例，也避免状态继续对外暴露。
    const dealPromise = loader.deal(data);

    if (isOffline && data.self_id) {
      const removed = releaseRoute(client, routeKey);
      if (removed != null) {
        logger.info(`${tag} 账号已下线: ${removed}`);
      }
    }

    void dealPromise.catch((err) => {
      logger.error("[Loader] 事件处理未捕获异常:", err);
    });
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
    releaseRoute(client, data.routeKey);
  });

  client.on("socket.error", (data) => {
    logger.error(`${tag} WebSocket 错误: ${data.error_type}`);
  });

  client.on("socket.connecting", () => {
    logger.info(`${tag} 正在重连...`);
  });

  // ---- 生命周期: 初始化 Bot ----

  client.on("meta_event.lifecycle.connect", async (data) => {
    if (!data.self_id || isForeignAccount(data.self_id)) return;

    const botInstance = bindAccount(tag, client, data.self_id, data.__routeKey || label);

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
  // 当前账号来自这些连接的话一起注销
  if (boundRoute && wsClients.includes(boundRoute.client)) {
    boundRoute = null;
    removeBot();
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

// 先断开连接停止接收新事件，再等插件资源（浏览器等）关闭，最后关 Redis
onShutdown("断开连接", () => {
  disconnectAllClients();
  logger.info("所有连接已断开");
}, { order: -10 });

onShutdown("Redis", async () => {
  if (global.redis) {
    await global.redis.quit();
    logger.info("Redis 连接已关闭");
  }
}, { order: 10 });

// 只监听 IPC 消息，不直接监听 SIGINT/SIGTERM
// 因为父进程会通过 IPC 发送 shutdown 消息
process.on("message", (msg) => {
  if (msg === "shutdown") {
    shutdown("IPC shutdown");
  }
});

// 作为备用，如果直接运行此脚本（不通过 app.js）
if (!process.send) {
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

process.on("disconnect", () => {
  shutdown("IPC disconnect");
});

export { bot as api } from "./api/client.js";
