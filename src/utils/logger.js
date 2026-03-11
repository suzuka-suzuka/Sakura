import log4js from "log4js";
import chalk from "chalk";
import { AsyncLocalStorage } from "node:async_hooks";

// 用于自动将当前事件的群/用户信息注入到日志前缀
export const logContext = new AsyncLocalStorage();

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

const _rawLogger = log4js.getLogger();
_rawLogger.level = "info";

// 挂载 chalk 颜色方法
const colors = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray'];
for (const color of colors) {
  _rawLogger[color] = chalk[color];
}

// 自动注入群上下文前缀的包装
function makeGroupPrefix() {
  const ctx = logContext.getStore();
  if (!ctx) return "";
  if (ctx.group_id) {
    const groupLabel = ctx.group_name
      ? `${ctx.group_name}(${ctx.group_id})`
      : `群:${ctx.group_id}`;
    return `[${groupLabel}] `;
  }
  if (ctx.user_id) {
    const userLabel = ctx.nickname
      ? `${ctx.nickname}(${ctx.user_id})`
      : `私聊:${ctx.user_id}`;
    return `[${userLabel}] `;
  }
  return "";
}

const _patchedMethods = ["error", "warn", "info", "debug", "trace"];
const logger = new Proxy(_rawLogger, {
  get(target, prop) {
    if (_patchedMethods.includes(prop)) {
      return (...args) => {
        const prefix = makeGroupPrefix();
        if (prefix && typeof args[0] === "string") {
          args[0] = prefix + args[0];
        } else if (prefix) {
          args.unshift(prefix);
        }
        return target[prop](...args);
      };
    }
    return typeof target[prop] === "function"
      ? target[prop].bind(target)
      : target[prop];
  },
});

export { logger };
