import log4js from "log4js";
import chalk from "chalk";
import { AsyncLocalStorage } from "node:async_hooks";
import { BOT_LOG_BASE } from "./logPaths.js";

// 用于自动将当前事件的 self_id / 群 / 用户信息注入到日志前缀
export const logContext = new AsyncLocalStorage();
let includeSelfIdPrefix = false;

export function setLoggerBotCount(count = 0) {
  includeSelfIdPrefix = Number(count) > 1;
}

log4js.configure({
  appenders: {
    console: {
      type: "console",
      layout: {
        type: "pattern",
        pattern: "%[%d{hh:mm:ss} [%p] %m%]",
      },
    },
    file: {
      type: "dateFile",
      filename: BOT_LOG_BASE,
      pattern: "yyyy-MM-dd",
      keepFileExt: true,
      alwaysIncludePattern: true,
      numBackups: 7,
      layout: {
        type: "pattern",
        pattern: "[%d{hh:mm:ss}] [%p] %m",
      },
    },
  },
  categories: {
    default: { appenders: ["console", "file"], level: "info" },
  },
});

const _rawLogger = log4js.getLogger();
_rawLogger.level = "info";

const colors = ["red", "green", "yellow", "blue", "magenta", "cyan", "white", "gray"];
for (const color of colors) {
  _rawLogger[color] = chalk[color];
}

function makeLogPrefix() {
  const ctx = logContext.getStore();
  if (!ctx) {
    return { fullPrefix: "", selfPrefix: "" };
  }

  const parts = [];
  const selfPrefix = includeSelfIdPrefix && ctx.self_id ? `[${ctx.self_id}] ` : "";

  if (selfPrefix) {
    parts.push(selfPrefix.trimEnd());
  }

  if (ctx.group_id) {
    const groupLabel = ctx.group_name
      ? `${ctx.group_name}(${ctx.group_id})`
      : `群${ctx.group_id}`;
    parts.push(`[${groupLabel}]`);
  } else if (ctx.user_id) {
    const displayName = ctx.user_name || ctx.nickname;
    const userLabel = displayName
      ? `${displayName}(${ctx.user_id})`
      : `私聊:${ctx.user_id}`;
    parts.push(`[${userLabel}]`);
  }

  return {
    fullPrefix: parts.length > 0 ? `${parts.join(" ")} ` : "",
    selfPrefix,
  };
}

const _patchedMethods = ["error", "warn", "info", "debug", "trace"];
const logger = new Proxy(_rawLogger, {
  get(target, prop) {
    if (_patchedMethods.includes(prop)) {
      return (...args) => {
        const { fullPrefix, selfPrefix } = makeLogPrefix();
        if (fullPrefix && typeof args[0] === "string") {
          let prefixToUse = fullPrefix;
          if (selfPrefix && args[0].startsWith(selfPrefix)) {
            prefixToUse = fullPrefix.slice(selfPrefix.length);
          }
          if (prefixToUse) {
            args[0] = prefixToUse + args[0];
          }
        } else if (fullPrefix) {
          args.unshift(fullPrefix);
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
