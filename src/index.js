import { logger } from "./utils/logger.js";
import { OneBotServer } from "./core/server.js";
import { OneBotApi, Segment, removeBot, getBot } from "./api/client.js";
import { logEvent } from "./handlers/logging.js";
import { PluginLoader } from "./core/loader.js";
import { Command, OnEvent, plugin, Event, Cron } from "./core/plugin.js";
import { connectRedis } from "./utils/redis.js";

global.logger = logger;
global.Command = Command;
global.OnEvent = OnEvent;
global.Cron = Cron;
global.plugin = plugin;
global.Event = Event;
global.segment = Segment;
global.bot = null;

const PORT = 11351;
const PATH = "/sakura";

try {
  global.redis = await connectRedis();
} catch (e) {
  logger.error(`Redis 连接失败，程序退出: ${e}`);
  process.exit(1);
}

const loader = new PluginLoader();
await loader.loadPlugins();

const server = new OneBotServer({ port: PORT, path: PATH }, (data) => {
  if (data.post_type) {
    if (data.self_id && !getBot(data.self_id)) {
      logger.info(`[Auto Register] 检测到新的 Bot 实例: ${data.self_id}`);
      new OneBotApi(server, data.self_id);
    }

    logEvent(data);
    loader.deal(data);
  } else {
    if (!data.echo) {
      logger.info(`[收到非事件消息] ${JSON.stringify(data)}`);
    }
  }
});

server.on("connection_success", async (selfId) => {
  logger.info(`初始化 Bot 实例: ${selfId}`);
  const bot = new OneBotApi(server, selfId);

  try {
    const restartInfoStr = await redis.get("sakura:restart_info");
    if (restartInfoStr) {
      const info = JSON.parse(restartInfoStr);
      const timeTaken = ((Date.now() - info.start_time) / 1000).toFixed(2);
      const msg = `重启成功，用时 ${timeTaken} 秒`;

      if (info.source_type === "group") {
        await bot.sendGroupMsg(info.source_id, msg);
      } else {
        await bot.sendPrivateMsg(info.source_id, msg);
      }

      await redis.del("sakura:restart_info");
    }
  } catch (e) {
    logger.error(`检查重启状态失败: ${e}`);
  }
});

server.on("connection_close", (selfId) => {
  logger.info(`Bot 实例断开: ${selfId}`);
  removeBot(selfId);
});

// 优雅退出处理
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  
  logger.info(`收到 ${signal} 信号，正在优雅关闭...`);
  
  try {
    // 先关闭 WebSocket 服务器
    await server.shutdown();
    
    // 关闭 Redis 连接
    if (global.redis) {
      await global.redis.quit();
      logger.info('Redis 连接已关闭');
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
process.on('message', (msg) => {
  if (msg === 'shutdown') {
    gracefulShutdown('IPC shutdown');
  }
});

// 作为备用，如果直接运行此脚本（不通过 app.js）
if (!process.send) {
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

export { bot as api } from "./api/client.js";
