import fs from "fs";
import { getLatestBotLogPath } from "../../src/utils/logPaths.js";
import {
  buildLogSections,
  filterLogEntriesByLevel,
  formatLogSections,
  groupLogEntriesBySelfId,
  parseLogEntries,
} from "../../src/utils/logReader.js";

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

    const showAllAccounts = Boolean(e.match?.[1]);
    const isErrorOnly = e.match?.[2] === "错误";

    try {
      const content = fs.readFileSync(logFile, "utf-8");
      let entries = parseLogEntries(content);
      entries = filterLogEntriesByLevel(entries, isErrorOnly ? "WARN" : "ALL");

      const grouped = groupLogEntriesBySelfId(entries);
      const hasMultipleAccounts = grouped.bySelfId.size > 1;

      const sections = hasMultipleAccounts
        ? (
          showAllAccounts
            ? buildLogSections(entries, {
              groupBySelfId: true,
              includeCommon: true,
              limit: 50,
            })
            : buildLogSections(entries, {
              targetSelfId: e.self_id,
              includeCommon: true,
              limit: 50,
            })
        )
        : buildLogSections(entries, {
          includeCommon: true,
          limit: 50,
        });

      const validSections = sections.filter(
        (section) => Array.isArray(section.entries) && section.entries.length > 0
      );

      const typeLabel = isErrorOnly ? "错误日志" : "日志";
      const title = hasMultipleAccounts
        ? (showAllAccounts ? `全部账号${typeLabel}` : `当前账号${typeLabel}`)
        : typeLabel;

      if (validSections.length === 0) {
        return e.reply(`今日暂无${title}`);
      }

      await e.sendForwardMsg(
        validSections.map((section) => formatLogSections([section])),
        {
          prompt: title,
          source: "系统日志",
          news: validSections.slice(0, 5).map((section) => ({
            text: `${section.title} ${section.entries.length}/${section.total}`,
          })),
        }
      );
    } catch (err) {
      logger.error(`读取日志失败: ${err}`);
      e.reply(`读取日志失败: ${err.message}`);
    }
  });
}
