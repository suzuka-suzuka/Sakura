import { Redis } from 'ioredis';
import Config from '../core/config.js';
import { logger } from './logger.js';

let redisInstance = null;

export async function connectRedis() {
  const redisConfig = Config.get('redis');
  
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
      lazyConnect: true,
    });

    client.connect().then(() => {
        logger.info('[Redis] 连接成功');
        redisInstance = client;
        
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
