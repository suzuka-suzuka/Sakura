import fs from "fs";
import { logger } from "../../src/utils/logger.js";
import { getLatestBotLogPath } from "../../src/utils/logPaths.js";
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
    process.exit(0);
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

  getLogs = Command(/^#(全部)?(错误)?日志$/, async (e) => {
    await e.react(124);
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
