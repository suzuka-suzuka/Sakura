import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "../../logs");

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
    } else {
      process.exit(0);
    }
  });

  shutdown = Command(/^#关机$/, async (e) => {
    await e.react(124);

    if (process.send) {
      process.send("shutdown");
    } else {
      process.exit(0);
    }
  });

  getLogs = Command(/^#日志$/, async (e) => {
    await e.react(124);
    if (!fs.existsSync(LOG_DIR)) {
      return e.reply("暂无日志文件");
    }

    const files = fs
      .readdirSync(LOG_DIR)
      .filter((f) => f.startsWith("bot.") && f.endsWith(".log"))
      .sort()
      .reverse();

    if (files.length === 0) {
      return e.reply("暂无日志文件");
    }

    const logFile = path.join(LOG_DIR, files[0]);

    try {
      const content = fs.readFileSync(logFile, "utf-8");
      const lines = content.split("\n");

      const errorLines = lines.filter(
        (line) => line.includes("[ERROR]")
      );

      if (errorLines.length === 0) {
        return e.reply("今日暂无错误日志");
      }

      const lastErrors = errorLines.slice(-20);

      await e.sendForwardMsg(lastErrors, {
        prompt: "查看错误日志",
        summary: `共找到 ${errorLines.length} 条错误，显示最近 ${lastErrors.length} 条`,
        source: "系统日志",
      });
    } catch (err) {
      logger.error(`读取日志失败: ${err}`);
      e.reply(`读取日志失败: ${err.message}`);
    }
  });
}
