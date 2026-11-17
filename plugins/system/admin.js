import fs from "fs";
import { logger } from "../../src/utils/logger.js";
import { shutdown } from "../../src/core/shutdown.js";
import { powerOff, powerOn } from "../../src/core/powerState.js";
import { getLatestBotLogPath } from "../../src/utils/logPaths.js";
import { formatTime } from "./permission.js";
import {
  filterLogEntriesByLevel,
  filterLogEntriesByScope,
  parseLogEntries,
  takeLatestLogEntries,
} from "../../src/utils/logReader.js";

const MAX_FORWARD_LOGS = 50;

function normalizeNumericId(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function buildLogSummary({ title, total, shown, usesAllLogs, groupId = null }) {
  const scopeLabel = usesAllLogs
    ? "当前账号全部群 + 通用日志"
    : groupId != null
      ? `当前群 ${groupId} + 通用日志`
      : "当前账号全部群 + 通用日志";

  return {
    prompt: title,
    source: "系统日志",
    summary: `${scopeLabel}，共 ${total} 条，显示最近 ${shown} 条`,
    news: [
      { text: scopeLabel },
      { text: `共 ${total} 条，显示最近 ${shown} 条` },
    ],
  };
}

export class SystemPlugin extends plugin {
  constructor() {
    super({
      name: "System Plugin",
      dsc: "系统管理插件",
      event: "message",
      priority: -Infinity,
      permission: "master",
    });
  }

  restart = Command(/^#重启$/, async (e) => {
    await e.react(124);
    const restartInfo = {
      source_type: e.group_id ? "group" : "private",
      source_id: e.group_id || e.user_id,
      start_time: Date.now(),
    };
    await redis.set(
      "sakura:restart_info",
      JSON.stringify(restartInfo),
      "EX",
      120
    );

    if (process.send) {
      process.send("restart");
    }
    // 走完整退出流程，等浏览器等资源关闭后再退出，避免遗留 Chromium
    await shutdown("#重启");
  });

  shutdown = Command(/^#关机$/, async (e) => {
    await e.react(124);

    if (process.send) {
      process.send("shutdown");
    } else {
      import("child_process").then((cp) => {
        cp.exec("pm2 stop sakura-bot", (error) => {
          if (error) {
            process.exit(0);
          }
        });
      });
    }
  });

  // 软关机：进程不退出，这个账号只处理主人的 #开机 和掉线通知，重启后仍保持关机
  softShutdown = Command(/^#软关机$/, async (e) => {
    powerOff(e.self_id);
    await e.reply("已软关机，之后只响应主人的 #开机");
  });

  boot = Command(/^#开机$/, { whileOff: true }, async (e) => {
    const since = powerOn(e.self_id);
    if (since == null) {
      await e.reply("已经是开机状态了");
      return;
    }
    await e.reply(`已开机，这次软关机了${formatTime(Math.floor((Date.now() - since) / 1000))}`);
  });

  getLogs = Command(/^#(全部)?(错误)?日志$/, async (e) => {
    const logFile = getLatestBotLogPath();
    if (!logFile) {
      return e.reply("暂无日志文件");
    }

    const showAllGroups = Boolean(e.match?.[1]);
    const isErrorOnly = e.match?.[2] === "错误";

    try {
      const content = fs.readFileSync(logFile, "utf-8");
      let entries = parseLogEntries(content);
      entries = filterLogEntriesByLevel(entries, isErrorOnly ? "WARN" : "ALL");

      const currentSelfId = normalizeNumericId(e.self_id);
      const currentGroupId = normalizeNumericId(e.group_id);
      const usesAllLogs = showAllGroups || currentGroupId == null;

      entries = usesAllLogs
        ? filterLogEntriesByScope(entries, {
          targetSelfId: currentSelfId,
          allGroups: true,
          includeCommon: true,
        })
        : filterLogEntriesByScope(entries, {
          targetSelfId: currentSelfId,
          groupId: currentGroupId,
          includeCommon: true,
        });

      const typeLabel = isErrorOnly ? "错误日志" : "日志";
      const title = `${showAllGroups ? "全部" : ""}${typeLabel}`;

      if (entries.length === 0) {
        return e.reply(`今日暂无${title}`);
      }

      const displayEntries = takeLatestLogEntries(entries, MAX_FORWARD_LOGS);

      await e.sendForwardMsg(
        displayEntries,
        buildLogSummary({
          title,
          total: entries.length,
          shown: displayEntries.length,
          usesAllLogs,
          groupId: currentGroupId,
        })
      );
    } catch (err) {
      logger.error(`读取日志失败: ${err}`);
      e.reply(`读取日志失败: ${err.message}`);
    }
  });
}
