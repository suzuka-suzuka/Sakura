import { Command, plugin } from "../../src/core/plugin.js";
import Config from "../../src/core/config.js";
import { logger } from "../../src/utils/logger.js";
import { getRedis, onRedisKeyExpired } from "../../src/utils/redis.js";

const TEMP_BLOCK_PREFIX = "tempblock";
// 拆实例前的键是 tempblock:<QQ>:<用户>，这个前缀之后的那段已经不用了，留着兼容还没过期的旧键
const TEMP_BLOCK_SCOPE = "global";

function getPermissionList(key) {
  const list = Config.get(key);
  return Array.isArray(list) ? list.map(Number) : [];
}

/** 改主人/黑白名单里的一项，写回 config.yaml */
function savePermissionList(key, nextList) {
  return Config.update({ ...Config.get(), [key]: nextList });
}

function buildTempBlockKey(targetId) {
  return `${TEMP_BLOCK_PREFIX}:${TEMP_BLOCK_SCOPE}:${targetId}`;
}

function parseTempBlockKey(key) {
  const parts = String(key || "").split(":");
  if (parts.length !== 3 || parts[0] !== TEMP_BLOCK_PREFIX) {
    return null;
  }

  const userId = Number(parts[2]);
  return Number.isFinite(userId) && userId > 0 ? userId : null;
}

async function removeTempBlockKey(targetId) {
  try {
    await getRedis().del(buildTempBlockKey(targetId));
  } catch (error) {
    logger.warn(`[Permission] failed to remove temp block key: ${error.message}`);
  }
}

function removeUserFromBlacklist(targetId) {
  const blackUsers = getPermissionList("blackUsers");
  if (!blackUsers.includes(targetId)) return;
  savePermissionList("blackUsers", blackUsers.filter((id) => id !== targetId));
}

export function parseTime(timeStr) {
  if (!timeStr) return null;

  let totalSeconds = 0;
  const regex = /(\d+)\s*(秒|分钟?|小时|天|s|m|h|d)/gi;
  let match;

  while ((match = regex.exec(timeStr)) !== null) {
    const value = parseInt(match[1], 10);
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
        totalSeconds += value * 86400;
        break;
      default:
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
    const blackUsers = getPermissionList("blackUsers");

    if (blackUsers.includes(targetId)) {
      return { success: false, message: `${targetId} 已经在黑名单中了` };
    }

    if (duration > 0) {
      try {
        const redis = getRedis();
        await redis.setex(
          buildTempBlockKey(targetId),
          duration,
          Date.now().toString()
        );
      } catch (error) {
        logger.error(`[Permission] Redis operation failed: ${error.message}`);
        return { success: false, message: "临时拉黑失败，Redis 操作异常" };
      }
    }

    const saveResult = savePermissionList("blackUsers", [...blackUsers, targetId]);

    if (!saveResult.success) {
      if (duration > 0) {
        await removeTempBlockKey(targetId);
      }
      return { success: false, message: "保存配置文件失败" };
    }

    if (duration > 0) {
      return {
        success: true,
        message: `已将 ${targetId} 临时拉黑 ${formatTime(duration)}，到期后自动解除`,
      };
    }

    return {
      success: true,
      message: `已将 ${targetId} 加入黑名单`,
    };
  } catch (error) {
    logger.error(`[Permission] block user failed: ${error.message}`);
    return { success: false, message: `拉黑失败: ${error.message}` };
  }
}

export async function unblockUser(targetId) {
  try {
    const blackUsers = getPermissionList("blackUsers");

    if (!blackUsers.includes(targetId)) {
      return { success: false, message: `${targetId} 不在黑名单中` };
    }

    const saveResult = savePermissionList("blackUsers", blackUsers.filter((id) => id !== targetId));

    if (!saveResult.success) {
      return { success: false, message: "保存配置文件失败" };
    }

    await removeTempBlockKey(targetId);
    return { success: true, message: `已将 ${targetId} 移出黑名单` };
  } catch (error) {
    logger.error(`[Permission] unblock user failed: ${error.message}`);
    return { success: false, message: `解黑失败: ${error.message}` };
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
      await onRedisKeyExpired(async (expiredKey) => {
        const userId = parseTempBlockKey(expiredKey);
        if (userId == null) return;
        this.autoUnblock(userId);
      });
    } catch (error) {
      logger.error(`[Permission] init Redis expire listener failed: ${error.message}`);
    }
  }

  autoUnblock(userId) {
    try {
      removeUserFromBlacklist(userId);
    } catch (error) {
      logger.error(`[Permission] auto unblock failed: ${error.message}`);
    }
  }

  handlePermission = Command(/^(赋权|取消赋权)\s*(.*)$/, "master", async (e) => {
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

    const whiteUsers = getPermissionList("whiteUsers");

    if (isAdd && whiteUsers.includes(targetId)) {
      await e.reply(`${targetId} 已经在白名单中了`, 10);
      return;
    }

    if (!isAdd && !whiteUsers.includes(targetId)) {
      await e.reply(`${targetId} 不在白名单中`, 10);
      return;
    }

    const result = savePermissionList(
      "whiteUsers",
      isAdd ? [...whiteUsers, targetId] : whiteUsers.filter((id) => id !== targetId)
    );

    if (!result.success) {
      await e.reply("保存配置文件失败", 10);
      return;
    }

    await e.reply(
      isAdd
        ? `已将 ${targetId} 加入白名单`
        : `已将 ${targetId} 移出白名单`,
      10
    );
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

      const whiteGroups = getPermissionList("whiteGroups");

      if (isAdd && whiteGroups.includes(targetGroupId)) {
        await e.reply(`${targetGroupId} 已经在白名单中了`, 10);
        return;
      }

      if (!isAdd && !whiteGroups.includes(targetGroupId)) {
        await e.reply(`${targetGroupId} 不在白名单中`, 10);
        return;
      }

      const result = savePermissionList(
        "whiteGroups",
        isAdd ? [...whiteGroups, targetGroupId] : whiteGroups.filter((id) => id !== targetGroupId)
      );

      if (!result.success) {
        await e.reply("保存配置文件失败", 10);
        return;
      }

      await e.reply(
        isAdd
          ? `已将 ${targetGroupId} 加入白名单`
          : `已将 ${targetGroupId} 移出白名单`,
        10
      );
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

      const result = isAdd
        ? await blockUser(targetId, parseTime(timeStr))
        : await unblockUser(targetId);

      await e.reply(result.message, 10);
    }
  );
}
