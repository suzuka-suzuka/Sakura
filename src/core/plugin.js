import { getBot } from "../api/client.js";
import { AsyncLocalStorage } from "node:async_hooks";
export { Event } from "./event.js";

/**
 * 用于在异步调用链中传播事件对象，
 * 确保 setTimeout 等回调中也能获取到正确的事件引用，
 * 而不依赖可能被覆盖的 this.e
 */
export const eventStorage = new AsyncLocalStorage();


export const PLUGIN_HANDLERS = Symbol.for("PLUGIN_HANDLERS");
export const HANDLER_METADATA = Symbol.for("HANDLER_METADATA");

/**
 * 注册指令
 * @param {RegExp} reg 正则表达式
 * @param {string|number|object} [eventOrPriorityOrOptions] 事件类型 (string) 或 优先级 (number) 或 配置对象
 * @param {number} [priority] 优先级 (仅当第二个参数为事件类型时有效)
 * @param {Function} handler 处理函数
 */
export function Command(reg, ...args) {
  const handler = args.pop();
  const eventOrPriorityOrOptions = args[0];
  const priority = args[1];

  let eventName;
  let p;
  let permission;

  if (typeof eventOrPriorityOrOptions === "number") {
    p = eventOrPriorityOrOptions;
  } else if (typeof eventOrPriorityOrOptions === "string") {
    if (
      eventOrPriorityOrOptions === "master" ||
      eventOrPriorityOrOptions === "white"
    ) {
      permission = eventOrPriorityOrOptions;
    } else {
      eventName = eventOrPriorityOrOptions;
    }
    p = priority;
  } else if (typeof eventOrPriorityOrOptions === "object") {
    eventName = eventOrPriorityOrOptions.event;
    p = eventOrPriorityOrOptions.priority;
    permission = eventOrPriorityOrOptions.permission;
  }

  if (typeof handler === "function") {
    handler[HANDLER_METADATA] = {
      type: "regex",
      reg,
      eventName,
      priority: p,
      permission,
    };
  }
  return handler;
}

/**
 * 注册事件监听
 * @param {string} eventName 事件名称 (如 'notice.group_increase')
 * @param {number|string|object} [priorityOrPermissionOrOptions] 优先级 (number) 或 权限 (string: 'master'|'white') 或 配置对象
 * @param {number|string} [priorityOrPermission] 优先级或权限 (取决于前一个参数)
 * @param {Function} handler 处理函数
 */
export function OnEvent(eventName, ...args) {
  const handler = args.pop();
  const arg1 = args[0];
  const arg2 = args[1];

  let priority;
  let permission;

  if (typeof arg1 === "object" && arg1 !== null) {
    priority = arg1.priority;
    permission = arg1.permission;
  } else if (typeof arg1 === "number") {
    priority = arg1;
    if (typeof arg2 === "string") {
      permission = arg2;
    }
  } else if (typeof arg1 === "string") {
    if (arg1 === "master" || arg1 === "white") {
      permission = arg1;
      if (typeof arg2 === "number") {
        priority = arg2;
      }
    } else {
      priority = arg1;
    }
  } else {
    priority = arg1;
  }

  if (typeof handler === "function") {
    handler[HANDLER_METADATA] = {
      type: "event",
      eventName,
      priority,
      permission,
    };
  }
  return handler;
}

/**
 * 注册定时任务
 * @param {string} cronExpression Cron 表达式
 * @param {Function} handler 处理函数
 */
export function Cron(cronExpression, handler) {
  if (typeof handler === "function") {
    handler[HANDLER_METADATA] = {
      type: "cron",
      cronExpression,
    };
  }
  return handler;
}


export const contexts = {};
export const contextTimers = {};

export class plugin {
  constructor(config = {}) {
    const {
      name = "Unknown Plugin",
      event = "message",
      priority = 5000,
      log = false,
      permission,
      configWatch,  // 声明依赖的配置文件名，配置变更时自动重载插件
    } = config;

    this.name = name;
    this.event = event;
    this.priority = priority;
    this.log = log;
    this.permission = permission;
    this.configWatch = configWatch;  // 如 "teatime" 或 ["teatime", "AI"]
    this.jobs = [];
  }

  async init() { }

  destroy() {
    this.jobs.forEach((job) => job.cancel());
    this.jobs = [];
  }

  /**
   * 获取指定 Bot 实例
   * @param {number} selfId Bot QQ 号
   */
  getBot(selfId) {
    return getBot(selfId);
  }

  /**
   * 设置上下文
   * @param {string} method 方法名
   * @param {boolean|string|number} isGroup 是否为群组上下文，或者直接指定 ID
   * @param {number} timeout 超时时间 (秒)
   * @param {boolean} refreshTimer 是否刷新超时计时器（默认 true 刷新，false 则保留原有计时器）
   * @param {any} data 上下文数据
   */
  setContext(method, isGroup = false, timeout = 120, refreshTimer = true, data = null) {
    let id;
    if (typeof isGroup === "boolean") {
      const e = eventStorage.getStore() || this.e;
      if (!e) return;
      // 群组上下文使用 group_id:user_id 作为 key，避免不同用户上下文互相阻塞
      id = isGroup ? `${e.group_id}:${e.user_id}` : e.user_id;
    } else {
      // 兼容直接传入 ID 的情况，如果传入的是群号，需要配合 user_id 使用
      const e = eventStorage.getStore() || this.e;
      if (e && e.group_id && isGroup === e.group_id) {
        id = `${isGroup}:${e.user_id}`;
      } else {
        id = isGroup;
      }
    }

    if (!id) return;

    // 检查是否已存在相同的上下文，如果 refreshTimer 为 false 且上下文已存在，则不刷新计时器
    const existingContext = contexts[id];
    if (!refreshTimer && existingContext && existingContext.plugin === this && existingContext.method === method) {
      // 保留原有上下文和计时器，不做任何操作
      return;
    }

    // 清除旧的超时定时器
    if (contextTimers[id]) {
      clearTimeout(contextTimers[id]);
      delete contextTimers[id];
    }

    contexts[id] = {
      plugin: this,
      method,
      data,
    };

    if (timeout > 0) {
      contextTimers[id] = setTimeout(() => {
        if (contexts[id] && contexts[id].plugin === this && contexts[id].method === method) {
          delete contexts[id];
        }
        delete contextTimers[id];
      }, timeout * 1000);
    }
  }

  /**
   * 结束上下文
   * @param {string} method 方法名
   * @param {boolean|string|number} isGroup 是否为群组上下文，或者直接指定 ID
   */
  finish(method, isGroup = false) {
    let id;
    if (typeof isGroup === "boolean") {
      const e = eventStorage.getStore() || this.e;
      if (!e) return;
      // 群组上下文使用 group_id:user_id 作为 key
      id = isGroup ? `${e.group_id}:${e.user_id}` : e.user_id;
    } else {
      // 兼容直接传入 ID 的情况
      const e = eventStorage.getStore() || this.e;
      if (e && e.group_id && isGroup === e.group_id) {
        id = `${isGroup}:${e.user_id}`;
      } else {
        id = isGroup;
      }
    }

    if (contexts[id] && contexts[id].method === method) {
      delete contexts[id];
    }

    // 清除关联的超时定时器
    if (contextTimers[id]) {
      clearTimeout(contextTimers[id]);
      delete contextTimers[id];
    }
  }

  /**
   * 获取当前上下文
   * @param {string} method 方法名 (可选/用于严格匹配)
   * @param {boolean|string|number} isGroup 是否为群组上下文，或者直接指定 ID
   * @returns {object|undefined} 返回当前的上下文对象
   */
  getContext(method = null, isGroup = false) {
    let id;
    if (typeof isGroup === "boolean") {
      const e = eventStorage.getStore() || this.e;
      if (!e) return;
      id = isGroup ? `${e.group_id}:${e.user_id}` : e.user_id;
    } else {
      // 兼容直接传入 ID 的情况
      const e = eventStorage.getStore() || this.e;
      if (e && e.group_id && isGroup === e.group_id) {
        id = `${isGroup}:${e.user_id}`;
      } else {
        id = isGroup;
      }
    }

    const currentContext = contexts[id];

    // 如果没有上下文，或者指定了 method 但不匹配，就返回 undefined
    if (!currentContext) return undefined;
    if (method && currentContext.method !== method) return undefined;

    return currentContext;
  }
}
