import { NCWebsocket } from "node-napcat-ts";
import { logger } from "./utils/logger.js";
import { OneBotApi, Segment, removeBot, getBot, bots } from "./api/client.js";
import { logEvent } from "./handlers/logging.js";
import { PluginLoader } from "./core/loader.js";
import { Command, OnEvent, plugin, Event, Cron } from "./core/plugin.js";
import { connectRedis } from "./utils/redis.js";
import Config from "./core/config.js";
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

// =================== 正向 WebSocket 连接 ===================

const wsConfig = Config.get("ws") || {};
const wsUrl = wsConfig.url || "ws://127.0.0.1:3001";
const accessToken = wsConfig.accessToken || "";
const reconnection = wsConfig.reconnection || {};

logger.info(`正在连接  WebSocket: ${wsUrl}`);

const ncws = new NCWebsocket(
  {
    baseUrl: wsUrl,
    accessToken,
    reconnection: {
      enable: reconnection.enable ?? true,
      attempts: reconnection.attempts ?? 99,
      delay: reconnection.delay ?? 5000,
    },
  },
  false
);

// =================== 事件监听 ===================

/**
 * 统一事件处理：接收库解析好的事件，转发给框架的 logEvent + loader.deal
 */
function handleEvent(data) {
  if (!data || !data.post_type) return;

  // 确保 self_id 存在
  if (data.self_id && !getBot(data.self_id)) {
    logger.info(`检测到新的 Bot 实例: ${data.self_id}`);
    new OneBotApi(ncws, data.self_id);
  }

  logEvent(data);
  loader.deal(data);
}

// 监听所有消息事件
ncws.on("message", handleEvent);

// 监听自身发送消息事件
ncws.on("message_sent", handleEvent);

// 监听通知事件
ncws.on("notice", handleEvent);

// 监听请求事件
ncws.on("request", handleEvent);

// 监听元事件（心跳、生命周期等）
ncws.on("meta_event", handleEvent);

// =================== 连接管理 ===================

ncws.on("socket.open", async (data) => {
  logger.info("WebSocket 连接成功");
});

ncws.on("socket.close", (data) => {
  logger.warn(
    `WebSocket 连接断开 [code: ${data.code}] ${data.reason || ""}`
  );
  // 清理所有 bot 实例
  for (const [selfId] of bots) {
    removeBot(selfId);
  }
});

ncws.on("socket.error", (data) => {
  logger.error(`WebSocket 错误: ${data.error_type}`);
});

ncws.on("socket.connecting", (data) => {
  const { nowAttempts, attempts } = data.reconnection;
  if (nowAttempts > 1) {
    logger.info(`正在重连... (${nowAttempts}/${attempts})`);
  }
});

// 生命周期连接事件 → 初始化 Bot
ncws.on("meta_event.lifecycle.connect", async (data) => {
  if (data.self_id) {
    logger.info(`初始化 Bot 实例: ${data.self_id}`);
    const botInstance = new OneBotApi(ncws, data.self_id);

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
      logger.error(`检查重启状态失败: ${e}`);
    }
  }
});

// 启动连接
try {
  await ncws.connect();
} catch (e) {
  logger.error(`WebSocket 连接失败: ${e}`);
}

// =================== 优雅退出处理 ===================

let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`收到 ${signal} 信号，正在优雅关闭...`);

  try {
    // 断开 WebSocket 连接
    ncws.disconnect();
    logger.info("WebSocket 连接已断开");

    // 关闭 Redis 连接
    if (global.redis) {
      await global.redis.quit();
      logger.info("Redis 连接已关闭");
    }
  } catch (e) {
    logger.error(`关闭过程出错: ${e}`);
  }

  // 确保进程退出
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

export { bot as api } from "./api/client.js";
