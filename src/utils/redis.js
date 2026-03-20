import { Redis } from 'ioredis';
import Config from '../core/config.js';
import { logger } from './logger.js';

let redisInstance = null;
let expiredSubscriber = null;
let expiredSubscriberInitPromise = null;
const expiredListeners = new Set();

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

/**
 * 注册 Redis Key 过期监听（公共能力）
 * @param {(expiredKey: string, pattern: string, channel: string) => (void|Promise<void>)} callback
 * @returns {Promise<() => void>} 取消监听函数
 */
export async function onRedisKeyExpired(callback) {
  if (typeof callback !== 'function') {
    throw new Error('onRedisKeyExpired callback 必须为函数');
  }

  expiredListeners.add(callback);

  if (!expiredSubscriber) {
    if (!expiredSubscriberInitPromise) {
      expiredSubscriberInitPromise = (async () => {
        const redis = getRedis();

        try {
          await redis.config('SET', 'notify-keyspace-events', 'Ex');
        } catch (err) {
          logger.warn(`[Redis] 设置 notify-keyspace-events 失败: ${err.message}`);
        }

        const subscriber = redis.duplicate();
        await subscriber.connect();
        await subscriber.psubscribe('__keyevent@*__:expired');

        subscriber.on('pmessage', async (pattern, channel, expiredKey) => {
          for (const listener of expiredListeners) {
            try {
              await listener(expiredKey, pattern, channel);
            } catch (err) {
              logger.error(`[Redis] 过期键监听回调执行失败: ${err.message}`);
            }
          }
        });

        expiredSubscriber = subscriber;
      })();
    }

    await expiredSubscriberInitPromise;
  }

  return () => {
    expiredListeners.delete(callback);
  };
}
