import { Command, plugin } from "../../src/core/plugin.js";
import accountConfig from "../../src/core/accountConfig.js";
import { logger } from "../../src/utils/logger.js";
import { getRedis, onRedisKeyExpired } from "../../src/utils/redis.js";

const TEMP_BLOCK_PREFIX = "tempblock";

function getScopedPermissionConfig(selfId) {
  return accountConfig.getConfig(selfId);
}

function saveScopedPermissionConfig(selfId, nextConfig) {
  return accountConfig.setConfig(selfId, nextConfig);
}

function buildTempBlockKey(selfId, targetId) {
  const scope = selfId ? String(selfId) : "global";
  return `${TEMP_BLOCK_PREFIX}:${scope}:${targetId}`;
}

function parseTempBlockKey(key) {
  const parts = String(key || "").split(":");
  if (parts[0] !== TEMP_BLOCK_PREFIX) {
    return null;
  }

  if (parts.length === 2) {
    const userId = Number(parts[1]);
    return Number.isFinite(userId) ? { selfId: null, userId } : null;
  }

  if (parts.length === 3) {
    const selfId = parts[1] === "global" ? null : Number(parts[1]);
    const userId = Number(parts[2]);
    if (!Number.isFinite(userId)) return null;
    return {
      selfId: Number.isFinite(selfId) ? selfId : null,
      userId,
    };
  }

  return null;
}

async function removeTempBlockKeys(targetId, selfId = null) {
  try {
    const redis = getRedis();
    const keys = [buildTempBlockKey(selfId, targetId)];
    if (selfId != null) {
      keys.push(buildTempBlockKey(null, targetId));
    }
    await redis.del(...keys);
  } catch (error) {
    logger.warn(`[Permission] failed to remove temp block key: ${error.message}`);
  }
}

function updateScopedList(selfId, key, updater) {
  const currentConfig = getScopedPermissionConfig(selfId);
  const currentList = Array.isArray(currentConfig[key]) ? currentConfig[key].map(Number) : [];
  const nextList = updater(currentList);
  const result = saveScopedPermissionConfig(selfId, {
    ...currentConfig,
    [key]: nextList,
  });

  return {
    result,
    list: nextList,
  };
}

async function removeUserFromBlacklist(targetId, selfId = null) {
  if (selfId == null) {
    const accountIds = accountConfig.listConfiguredSelfIds();
    for (const accountId of accountIds) {
      updateScopedList(accountId, "blackUsers", (blackUsers) =>
        blackUsers.filter((id) => id !== targetId)
      );
    }
    return;
  }

  updateScopedList(selfId, "blackUsers", (blackUsers) =>
    blackUsers.filter((id) => id !== targetId)
  );
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

export async function blockUser(targetId, duration = 0, selfId = null) {
  try {
    if (selfId == null) {
      return { success: false, message: "缺少账号作用域，无法写入账号黑名单" };
    }

    const currentConfig = getScopedPermissionConfig(selfId);
    const blackUsers = (currentConfig.blackUsers || []).map(Number);

    if (blackUsers.includes(targetId)) {
      return { success: false, message: `${targetId} 已经在黑名单中了` };
    }

    if (duration > 0) {
      try {
        const redis = getRedis();
        await redis.setex(
          buildTempBlockKey(selfId, targetId),
          duration,
          Date.now().toString()
        );
      } catch (error) {
        logger.error(`[Permission] Redis operation failed: ${error.message}`);
        return { success: false, message: "临时拉黑失败，Redis 操作异常" };
      }
    }

    const saveResult = saveScopedPermissionConfig(selfId, {
      ...currentConfig,
      blackUsers: [...blackUsers, targetId],
    });

    if (!saveResult.success) {
      if (duration > 0) {
        await removeTempBlockKeys(targetId, selfId);
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

export async function unblockUser(targetId, selfId = null) {
  try {
    if (selfId == null) {
      return { success: false, message: "缺少账号作用域，无法写入账号黑名单" };
    }

    const currentConfig = getScopedPermissionConfig(selfId);
    const blackUsers = (currentConfig.blackUsers || []).map(Number);

    if (!blackUsers.includes(targetId)) {
      return { success: false, message: `${targetId} 不在黑名单中` };
    }

    const saveResult = saveScopedPermissionConfig(selfId, {
      ...currentConfig,
      blackUsers: blackUsers.filter((id) => id !== targetId),
    });

    if (!saveResult.success) {
      return { success: false, message: "保存配置文件失败" };
    }

    await removeTempBlockKeys(targetId, selfId);
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
        const parsed = parseTempBlockKey(expiredKey);
        if (!parsed) return;
        await this.autoUnblock(parsed.userId, parsed.selfId);
      });
    } catch (error) {
      logger.error(`[Permission] init Redis expire listener failed: ${error.message}`);
    }
  }

  async autoUnblock(userId, selfId = null) {
    try {
      await removeUserFromBlacklist(userId, selfId);
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

    const currentConfig = getScopedPermissionConfig(e.self_id);
    const whiteUsers = (currentConfig.whiteUsers || []).map(Number);

    if (isAdd && whiteUsers.includes(targetId)) {
      await e.reply(`${targetId} 已经在白名单中了`, 10);
      return;
    }

    if (!isAdd && !whiteUsers.includes(targetId)) {
      await e.reply(`${targetId} 不在白名单中`, 10);
      return;
    }

    const result = saveScopedPermissionConfig(e.self_id, {
      ...currentConfig,
      whiteUsers: isAdd
        ? [...whiteUsers, targetId]
        : whiteUsers.filter((id) => id !== targetId),
    });

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

      const currentConfig = getScopedPermissionConfig(e.self_id);
      const whiteGroups = (currentConfig.whiteGroups || []).map(Number);

      if (isAdd && whiteGroups.includes(targetGroupId)) {
        await e.reply(`${targetGroupId} 已经在白名单中了`, 10);
        return;
      }

      if (!isAdd && !whiteGroups.includes(targetGroupId)) {
        await e.reply(`${targetGroupId} 不在白名单中`, 10);
        return;
      }

      const result = saveScopedPermissionConfig(e.self_id, {
        ...currentConfig,
        whiteGroups: isAdd
          ? [...whiteGroups, targetGroupId]
          : whiteGroups.filter((id) => id !== targetGroupId),
      });

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
        ? await blockUser(targetId, parseTime(timeStr), e.self_id)
        : await unblockUser(targetId, e.self_id);

      await e.reply(result.message, 10);
    }
  );
}
