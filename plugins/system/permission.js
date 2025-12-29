import config from "../../src/core/config.js";
import { getRedis } from "../../src/utils/redis.js";

export class Permission extends plugin {
  constructor() {
    super({
      name: "权限管理",
      event: "message",
      priority: 1135,
    });

    // 监听 Redis key 过期事件以实现自动解黑
    this.initRedisExpireListener();
  }

  /**
   * 初始化 Redis 过期监听
   */
  async initRedisExpireListener() {
    try {
      const redis = getRedis();
      
      // 配置 Redis keyspace notifications（需要在 redis.conf 中启用或通过命令启用）
      await redis.config('SET', 'notify-keyspace-events', 'Ex');
      
      // 创建订阅客户端
      const subscriber = redis.duplicate();
      await subscriber.connect();
      
      // 订阅过期事件
      await subscriber.psubscribe('__keyevent@*__:expired');
      
      subscriber.on('pmessage', async (pattern, channel, expiredKey) => {
        // 只处理临时拉黑的 key
        if (expiredKey.startsWith('tempblock:')) {
          const userId = Number(expiredKey.split(':')[1]);
          await this.autoUnblock(userId);
        }
      });
      
      logger.info('[Permission] Redis 过期监听已启动');
    } catch (err) {
      logger.error(`[Permission] 初始化 Redis 监听失败: ${err.message}`);
    }
  }

  /**
   * 自动解黑
   */
  async autoUnblock(userId) {
    try {
      let blackUsers = (config.get('blackUsers') || []).map(Number);
      
      if (blackUsers.includes(userId)) {
        blackUsers = blackUsers.filter((id) => id !== userId);
        
        if (config.set('blackUsers', blackUsers)) {
          logger.info(`[Permission] 用户 ${userId} 临时拉黑已到期，自动解除`);
        }
      }
    } catch (err) {
      logger.error(`[Permission] 自动解黑失败: ${err.message}`);
    }
  }

  /**
   * 解析时间字符串，返回秒数
   * 支持格式：1h, 30m, 1d, 2h30m
   */
  parseTime(timeStr) {
    if (!timeStr) return null;
    
    let totalSeconds = 0;
    const regex = /(\d+)([smhd])/g;
    let match;
    
    while ((match = regex.exec(timeStr.toLowerCase())) !== null) {
      const value = parseInt(match[1]);
      const unit = match[2];
      
      switch (unit) {
        case 's': totalSeconds += value; break;
        case 'm': totalSeconds += value * 60; break;
        case 'h': totalSeconds += value * 3600; break;
        case 'd': totalSeconds += value * 86400; break;
      }
    }
    
    return totalSeconds > 0 ? totalSeconds : null;
  }

  /**
   * 格式化时间描述
   */
  formatTime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    const parts = [];
    if (days > 0) parts.push(`${days}天`);
    if (hours > 0) parts.push(`${hours}小时`);
    if (minutes > 0) parts.push(`${minutes}分钟`);
    
    return parts.join('') || '不足1分钟';
  }

  handlePermission = Command(/^(赋权|取消赋权)\s*(.*)$/, "white", async (e) => {
    const isAdd = e.match[1] === "赋权";
    let targetId = e.at ? Number(e.at) : null;

    if (!targetId) {
      const text = e.match[2].trim();
      if (/^\d+$/.test(text)) {
        targetId = Number(text);
      }
    }

    if (!targetId) {
      return false;
    }

    let whiteUsers = (config.get('whiteUsers') || []).map(Number);

    if (isAdd) {
      if (whiteUsers.includes(targetId)) {
        await e.reply(`${targetId} 已经在白名单中了`, 10);
        return;
      }
      whiteUsers.push(targetId);
      await e.reply(`已将 ${targetId} 添加到白名单`, 10);
    } else {
      if (!whiteUsers.includes(targetId)) {
        await e.reply(`${targetId} 不在白名单中`, 10);
        return;
      }
      whiteUsers = whiteUsers.filter((id) => id !== targetId);
      await e.reply(`已将 ${targetId} 移出白名单`, 10);
    }

    if (!config.set('whiteUsers', whiteUsers)) {
      logger.error('保存配置文件失败');
      await e.reply("保存配置文件失败", 10);
    }
  });

  handleGroupPermission = Command(/^(拉白|取消拉白)\s*(.*)$/, "master", async (e) => {
    const isAdd = e.match[1] === "拉白";
    let targetGroupId;
    const text = e.match[2].trim();

    if (text && /^\d+$/.test(text)) {
      targetGroupId = Number(text);
    } else if (e.group_id) {
      targetGroupId = e.group_id;
    }

    if (!targetGroupId) {
      await e.reply("请指定群号或在群聊中使用", 10);
      return false;
    }

    let whiteGroups = (config.get('whiteGroups') || []).map(Number);

    if (isAdd) {
      if (whiteGroups.includes(targetGroupId)) {
        await e.reply(`${targetGroupId} 已经在白名单中了`, 10);
        return;
      }
      whiteGroups.push(targetGroupId);
      await e.reply(`已将 ${targetGroupId} 添加到白名单`, 10);
    } else {
      if (!whiteGroups.includes(targetGroupId)) {
        await e.reply(`${targetGroupId} 不在白名单中`, 10);
        return;
      }
      whiteGroups = whiteGroups.filter((id) => id !== targetGroupId);
      await e.reply(`已将 ${targetGroupId} 移出白名单`, 10);
    }

    if (!config.set('whiteGroups', whiteGroups)) {
      logger.error('保存配置文件失败');
      await e.reply("保存配置文件失败", 10);
    }
  });

  handleBlockUser = Command(/^(拉黑|解黑|取消拉黑)\s*(.*)$/, "master", async (e) => {
    const isAdd = e.match[1] === "拉黑";
    const params = e.match[2].trim().split(/\s+/);
    
    // 解析目标用户
    let targetId = e.at ? Number(e.at) : null;
    let timeStr = null;

    if (!targetId) {
      // 尝试从参数中解析用户ID
      for (let i = 0; i < params.length; i++) {
        if (/^\d+$/.test(params[i])) {
          targetId = Number(params[i]);
          // 剩余参数可能是时间
          if (i + 1 < params.length) {
            timeStr = params[i + 1];
          }
          break;
        }
      }
    } else {
      // 有 at，第一个参数可能是时间
      timeStr = params[0];
    }

    if (!targetId) {
      await e.reply("请指定要操作的用户QQ", 10);
      return false;
    }

    let blackUsers = (config.get('blackUsers') || []).map(Number);

    if (isAdd) {
      // 拉黑操作
      if (blackUsers.includes(targetId)) {
        await e.reply(`${targetId} 已经在黑名单中了`, 10);
        return;
      }
      
      // 解析时间参数
      const duration = this.parseTime(timeStr);
      
      if (duration) {
        // 临时拉黑，存入 Redis
        try {
          const redis = getRedis();
          await redis.setex(`tempblock:${targetId}`, duration, Date.now().toString());
          
          blackUsers.push(targetId);
          
          if (config.set('blackUsers', blackUsers)) {
            const timeDesc = this.formatTime(duration);
            await e.reply(`已将 ${targetId} 临时拉黑 ${timeDesc}，到期后自动解除`, 10);
          } else {
            await e.reply("保存配置文件失败", 10);
          }
        } catch (err) {
          logger.error(`[Permission] Redis 操作失败: ${err.message}`);
          await e.reply("临时拉黑失败，Redis 操作异常", 10);
        }
      } else {
        // 永久拉黑
        blackUsers.push(targetId);
        
        if (config.set('blackUsers', blackUsers)) {
          await e.reply(`已将 ${targetId} 添加到黑名单（永久）`, 10);
        } else {
          await e.reply("保存配置文件失败", 10);
        }
      }
    } else {
      // 解黑操作
      if (!blackUsers.includes(targetId)) {
        await e.reply(`${targetId} 不在黑名单中`, 10);
        return;
      }
      
      // 如果是临时拉黑，删除 Redis key
      try {
        const redis = getRedis();
        await redis.del(`tempblock:${targetId}`);
      } catch (err) {
        logger.warn(`[Permission] Redis 删除 key 失败: ${err.message}`);
      }
      
      blackUsers = blackUsers.filter((id) => id !== targetId);
      
      if (config.set('blackUsers', blackUsers)) {
        await e.reply(`已将 ${targetId} 移出黑名单`, 10);
      } else {
        await e.reply("保存配置文件失败", 10);
      }
    }
  });
}
