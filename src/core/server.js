import { WebSocketServer, WebSocket } from "ws";
import { EventEmitter } from "events";
import { logger } from "../utils/logger.js";
import Config from "./config.js";
export class OneBotServer extends EventEmitter {
  constructor(config, messageHandler) {
    super();
    this.config = config;
    this.messageHandler = messageHandler;
    this.wss = new WebSocketServer({
      port: config.port,
      path: config.path,
      verifyClient: (info, callback) => {
        const accessToken = Config.get('onebot.accessToken');
        
        if (!accessToken) {
          callback(true);
          return;
        }

        const auth = info.req.headers['authorization'];
        if (auth === `Bearer ${accessToken}`) {
          callback(true);
          return;
        }

        const url = new URL(info.req.url, `http://${info.req.headers.host}`);
        const urlToken = url.searchParams.get('access_token');
        if (urlToken === accessToken) {
          callback(true);
          return;
        }

        logger.warn(`客户端连接被拒绝: Token 验证失败`);
        callback(false, 401, 'Unauthorized');
      }
    });
    this.clients = new Map();

    this.init();
  }

  init() {
    logger.info(`OneBot v11 反向 WebSocket 服务器已启动`);
    logger.info(`监听地址: ws://127.0.0.1:${this.config.port}${this.config.path}`);

    this.wss.on("connection", (ws, req) => {
      logger.info(`客户端已连接`);
      
      let selfId = 0;
      if (req.headers['x-self-id']) {
        selfId = Number(req.headers['x-self-id']);
        logger.info(`Bot Self ID: ${selfId}`);
        this.clients.set(selfId, ws);
        this.emit("connection_success", selfId);
      }

      logger.info(JSON.stringify({
        headers: req.headers,
      }, null, 2));

      ws.on("message", (data) => {
        try {
          const message = data.toString();

          try {
            const json = JSON.parse(message);
            if (!json.self_id && selfId) {
                json.self_id = selfId;
            }
            logger.debug(JSON.stringify(json, null, 2));
            this.emit("data", json);
            this.messageHandler(json);
          } catch (e) {
            logger.warn(`消息不是有效的 JSON 格式: ${message}`);
          }
        } catch (error) {
          logger.error(`处理消息时出错: ${error}`);
        }
      });

      ws.on("close", (code, reason) => {
        logger.info(`客户端断开连接 ${code} ${reason.toString() || ""}`);
        if (selfId) {
            this.clients.delete(selfId);
            this.emit("connection_close", selfId);
        }
      });

      ws.on("error", (error) => {
        logger.error(` WebSocket 错误: ${error}`);
      });
    });

    this.wss.on("error", (error) => {
      logger.error(`服务器错误 ${error}`);
    });
  }

  send(data, selfId) {
    if (selfId) {
        const client = this.clients.get(selfId);
        if (client && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        } else {
            logger.warn(`Bot ${selfId} 未连接或连接已断开`);
        }
    } else {
        this.wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(data));
            }
        });
    }
  }

  shutdown() {
    logger.info("正在关闭服务器...");

    this.wss.clients.forEach((client) => {
      client.terminate();
    });

    this.wss.close(() => {
      logger.info("服务器已关闭");
      process.exit(0);
    });

    setTimeout(() => {
      logger.warn("强制退出");
      process.exit(1);
    }, 3000);
  }
}
