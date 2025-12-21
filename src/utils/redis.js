import { Redis } from 'ioredis';
import { getConfig } from '../core/config.js';
import { logger } from './logger.js';

let redisInstance = null;

export async function connectRedis() {
  const config = getConfig();
  const redisConfig = config.redis;
  
  if (!redisConfig) {
    throw new Error('Redis 配置未找到，请在 config.yaml 中配置 redis');
  }

  logger.info(`[Redis] 正在连接到 ${redisConfig.host}:${redisConfig.port}...`);

  return new Promise((resolve, reject) => {
    const client = new Redis({
      host: redisConfig.host,
      port: redisConfig.port,
      password: redisConfig.password,
      db: redisConfig.db || 0,
      lazyConnect: true, // 手动调用 connect 以便捕获启动错误
    });

    client.connect().then(() => {
        logger.info('[Redis] 连接成功');
        redisInstance = client;
        
        // 设置错误监听，防止后续运行中报错导致崩溃
        client.on('error', (err) => {
            logger.error(`[Redis] 运行时错误: ${err}`);
        });
        
        resolve(client);
    }).catch((err) => {
        logger.error(`[Redis] 连接失败: ${err}`);
        reject(err);
    });
  });
}

export function getRedis() {
  if (!redisInstance) {
    throw new Error('Redis 尚未初始化，请先调用 connectRedis()');
  }
  return redisInstance;
}
