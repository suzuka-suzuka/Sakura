import log4js from "log4js";
import chalk from "chalk";

// 配置 log4js
log4js.configure({
  appenders: {
    // 控制台输出
    console: {
      type: "console",
      layout: {
        type: "pattern",
        pattern: "%[%d{hh:mm:ss} [%p] %m%]"
      }
    },
    // 文件输出
    file: {
      type: "dateFile",
      filename: "logs/bot.log",
      pattern: "yyyy-MM-dd",
      keepFileExt: true,
      alwaysIncludePattern: true,
      numBackups: 7,
      layout: {
        type: "pattern",
        pattern: "[%d{hh:mm:ss}] [%p] %m"
      }
    }
  },
  categories: {
    default: { appenders: ["console", "file"], level: "info" },
  },
});

const logger = log4js.getLogger();
logger.level = "info";

// 挂载 chalk 颜色方法到 logger
const colors = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray'];
for (const color of colors) {
  logger[color] = chalk[color];
}

export { logger };
