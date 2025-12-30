import config from "../../src/core/config.js";
import { getRedis } from "../../src/utils/redis.js";

export function parseTime(timeStr) {
  if (!timeStr) return null;

  let totalSeconds = 0;
  const regex = /(\d+)\s*(秒|分钟?|时|小时|天|日|s|m|h|d)/gi;
  let match;

  while ((match = regex.exec(timeStr)) !== null) {
    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();

    switch (unit) {
      case "s":
      case "秒":
        totalSeconds += value;
        break;
      case "m":
      case "分":
      case "分钟":
        totalSeconds += value * 60;
        break;
      case "h":
      case "时":
      case "小时":
        totalSeconds += value * 3600;
        break;
      case "d":
      case "天":
      case "日":
        totalSeconds += value * 86400;
        break;
    }
  }

  return totalSeconds > 0 ? totalSeconds : null;
}

export function formatTime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0) parts.push(`${minutes}分钟`);

  return parts.join("") || "不足1分钟";
}

export async function blockUser(targetId, duration = 0) {
  try {
    let blackUsers = (config.get("blackUsers") || []).map(Number);

    if (blackUsers.includes(targetId)) {
      return { success: false, message: `${targetId} 已经在黑名单中了` };
    }

    blackUsers.push(targetId);

    if (duration > 0) {
      try {
        const redis = getRedis();
        await redis.setex(
          `tempblock:${targetId}`,
          duration,
          Date.now().toString()
        );

        if (config.set("blackUsers", blackUsers)) {
          const timeDesc = formatTime(duration);
          return {
            success: true,
            message: `已将 ${targetId} 临时拉黑 ${timeDesc}，到期后自动解除`,
          };
        } else {
          return { success: false, message: "保存配置文件失败" };
        }
      } catch (err) {
        logger.error(`[Permission] Redis 操作失败: ${err.message}`);
        return { success: false, message: "临时拉黑失败，Redis 操作异常" };
      }
    } else {
      if (config.set("blackUsers", blackUsers)) {
        return {
          success: true,
          message: `已将 ${targetId} 添加到黑名单（永久）`,
        };
      } else {
        return { success: false, message: "保存配置文件失败" };
      }
    }
  } catch (err) {
    logger.error(`[Permission] 拉黑失败: ${err.message}`);
    return { success: false, message: `拉黑失败: ${err.message}` };
  }
}

export async function unblockUser(targetId) {
  try {
    let blackUsers = (config.get("blackUsers") || []).map(Number);

    if (!blackUsers.includes(targetId)) {
      return { success: false, message: `${targetId} 不在黑名单中` };
    }

    try {
      const redis = getRedis();
      await redis.del(`tempblock:${targetId}`);
    } catch (err) {
      logger.warn(`[Permission] Redis 删除 key 失败: ${err.message}`);
    }

    blackUsers = blackUsers.filter((id) => id !== targetId);

    if (config.set("blackUsers", blackUsers)) {
      return { success: true, message: `已将 ${targetId} 移出黑名单` };
    } else {
      return { success: false, message: "保存配置文件失败" };
    }
  } catch (err) {
    logger.error(`[Permission] 解黑失败: ${err.message}`);
    return { success: false, message: `解黑失败: ${err.message}` };
  }
}

export class Permission extends plugin {
  constructor() {
    super({
      name: "权限管理",
      event: "message",
      priority: 1135,
    });

    this.initRedisExpireListener();
  }

  async initRedisExpireListener() {
    try {
      const redis = getRedis();

      await redis.config("SET", "notify-keyspace-events", "Ex");

      const subscriber = redis.duplicate();
      await subscriber.connect();

      await subscriber.psubscribe("__keyevent@*__:expired");

      subscriber.on("pmessage", async (pattern, channel, expiredKey) => {
        if (expiredKey.startsWith("tempblock:")) {
          const userId = Number(expiredKey.split(":")[1]);
          await this.autoUnblock(userId);
        }
      });
    } catch (err) {
      logger.error(`[Permission] 初始化 Redis 监听失败: ${err.message}`);
    }
  }

  async autoUnblock(userId) {
    try {
      let blackUsers = (config.get("blackUsers") || []).map(Number);

      if (blackUsers.includes(userId)) {
        blackUsers = blackUsers.filter((id) => id !== userId);
      }
    } catch (err) {
      logger.error(`[Permission] 自动解黑失败: ${err.message}`);
    }
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

    let whiteUsers = (config.get("whiteUsers") || []).map(Number);

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

    if (!config.set("whiteUsers", whiteUsers)) {
      logger.error("保存配置文件失败");
      await e.reply("保存配置文件失败", 10);
    }
  });

  handleGroupPermission = Command(
    /^(拉白|取消拉白)\s*(.*)$/,
    "master",
    async (e) => {
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

      let whiteGroups = (config.get("whiteGroups") || []).map(Number);

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

      if (!config.set("whiteGroups", whiteGroups)) {
        logger.error("保存配置文件失败");
        await e.reply("保存配置文件失败", 10);
      }
    }
  );

  handleBlockUser = Command(
    /^(拉黑|解黑|取消拉黑)\s*(.*)$/,
    "master",
    async (e) => {
      const isAdd = e.match[1] === "拉黑";
      const params = e.match[2].trim().split(/\s+/);

      let targetId = e.at ? Number(e.at) : null;
      let timeStr = null;

      if (!targetId) {
        for (let i = 0; i < params.length; i++) {
          if (/^\d+$/.test(params[i])) {
            targetId = Number(params[i]);
            if (i + 1 < params.length) {
              timeStr = params[i + 1];
            }
            break;
          }
        }
      } else {
        timeStr = params[0];
      }

      if (!targetId) {
        return false;
      }

      let result;

      if (isAdd) {
        const duration = parseTime(timeStr);
        result = await blockUser(targetId, duration);
      } else {
        result = await unblockUser(targetId);
      }

      await e.reply(result.message, 10);
    }
  );
}
