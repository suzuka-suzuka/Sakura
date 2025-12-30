import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  PLUGIN_HANDLERS,
  HANDLER_METADATA,
  plugin,
  Event,
  contexts,
} from "./plugin.js";
import Config from "./config.js";
import schedule from "node-schedule";
import { logger } from "../utils/logger.js";
import { getBot } from "../api/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class PluginLoader {
  constructor() {
    this.executableHandlers = [];
    this.pluginDirs = [];
    this.watchers = [];
    this.loadedPlugins = new Map();
    this.pluginDirs.push(path.join(__dirname, "../../plugins"));
  }

  async loadPlugins() {
    this.executableHandlers = [];

    for (const dir of this.pluginDirs) {
      await this.loadPluginsFromDir(dir);
    }

    this.sortHandlers();
    logger.info(`共加载 ${this.executableHandlers.length} 个指令/事件处理器`);

    this.startWatch();
  }

  async loadPluginsFromDir(dir) {
    try {
      try {
        await fs.access(dir);
      } catch {
        logger.warn(`插件目录不存在: ${dir}`);
        return;
      }

      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          const indexPath = path.join(fullPath, "index.js");
          let hasIndex = false;
          try {
            await fs.access(indexPath);
            hasIndex = true;
          } catch {
            hasIndex = false;
          }

          if (hasIndex) {
            await this.loadPlugin(indexPath);
          } else {
            await this.loadPluginsFromDir(fullPath);
          }
        } else if (entry.isFile()) {
          if (entry.name.endsWith(".js")) {
            await this.loadPlugin(fullPath);
          }
        }
      }
    } catch (e) {
      logger.error(`读取插件目录 ${dir} 失败: ${e}`);
    }
  }

  async loadPlugin(filePath) {
    try {
      const fileUrl = pathToFileURL(filePath).href + "?t=" + Date.now();
      const module = await import(fileUrl);

      let pluginClasses = [];
      const isPluginClass = (obj) => {
        return typeof obj === "function" && obj.prototype instanceof plugin;
      };

      for (const exported of Object.values(module)) {
        if (isPluginClass(exported)) {
          pluginClasses.push(exported);
        } else if (typeof exported === "object" && exported !== null) {
          for (const nested of Object.values(exported)) {
            if (isPluginClass(nested)) {
              pluginClasses.push(nested);
            }
          }
        }
      }

      pluginClasses = [...new Set(pluginClasses)];

      if (pluginClasses.length > 0) {
        this.unloadPlugin(filePath);
        const instances = [];

        for (const PluginClass of pluginClasses) {
          const instance = new PluginClass();

          const implicitHandlers = [];
          for (const key of Object.getOwnPropertyNames(instance)) {
            const value = instance[key];
            if (typeof value === "function" && value[HANDLER_METADATA]) {
              const meta = value[HANDLER_METADATA];
              implicitHandlers.push({
                ...meta,
                methodName: key,
              });
            }
          }

          if (!instance[PLUGIN_HANDLERS]) instance[PLUGIN_HANDLERS] = [];
          instance[PLUGIN_HANDLERS].push(...implicitHandlers);

          await instance.init();
          instances.push(instance);

          const handlers = instance[PLUGIN_HANDLERS] || [];

          for (const handler of handlers) {
            if (handler.type === "cron" && handler.cronExpression) {
              const job = schedule.scheduleJob(
                handler.cronExpression,
                async () => {
                  try {
                    if (instance.log) {
                      logger.info(
                        `[${instance.name}] 触发定时任务: ${handler.methodName}`
                      );
                    }
                    await instance[handler.methodName].call(instance);
                  } catch (e) {
                    logger.error(
                      `[${instance.name}] 定时任务 ${handler.methodName} 执行出错: ${e}`
                    );
                  }
                }
              );
              instance.jobs.push(job);
            } else {
              const priority = handler.priority ?? instance.priority ?? 5000;
              this.executableHandlers.push({
                instance,
                handler,
                priority,
                filePath,
              });
            }
          }
        }
        this.loadedPlugins.set(filePath, instances);
      }
    } catch (e) {
      logger.error(`加载插件 ${path.basename(filePath)} 失败: ${e}`);
    }
  }

  unloadPlugin(filePath) {
    const instances = this.loadedPlugins.get(filePath);
    if (instances) {
      if (Array.isArray(instances)) {
        instances.forEach((instance) => instance.destroy && instance.destroy());
      } else {
        instances.destroy && instances.destroy();
      }
      this.loadedPlugins.delete(filePath);
    }

    const initialLength = this.executableHandlers.length;
    this.executableHandlers = this.executableHandlers.filter(
      (h) => h.filePath !== filePath
    );
  }

  sortHandlers() {
    this.executableHandlers.sort((a, b) => a.priority - b.priority);
  }

  startWatch() {
    if (this.watchers.length > 0) return;

    for (const dir of this.pluginDirs) {
      if (!fsSync.existsSync(dir)) continue;

      logger.info(`开始监听插件目录: ${dir}`);
      let debounceTimer;

      const watcher = fsSync.watch(
        dir,
        { recursive: true },
        (eventType, filename) => {
          if (!filename) return;
          if (!filename.endsWith(".js")) return;

          const filePath = path.join(dir, filename);

          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(async () => {
            try {
              let entryPath = filePath;
              let currentDir = path.dirname(filePath);

              while (currentDir.length > dir.length) {
                const indexPath = path.join(currentDir, "index.js");
                if (fsSync.existsSync(indexPath)) {
                  entryPath = indexPath;
                  break;
                }
                currentDir = path.dirname(currentDir);
              }

              await fs.access(entryPath);
              logger.info(`检测到插件变更: ${filename}，正在重载...`);
              await this.loadPlugin(entryPath);
              this.sortHandlers();
            } catch {
              this.unloadPlugin(filePath);
            }
          }, 100);
        }
      );
      this.watchers.push(watcher);
    }
  }

  async deal(e) {
    if (e.post_type !== "meta_event") {
      const config = Config.get();
      const { group_id, user_id } = e;

      if (user_id && config.blackUsers.includes(user_id)) {
        return;
      }

      if (config.blockPrivate && e.message_type === "private") {
        const masterId = config.master;
        const isMaster = Array.isArray(masterId)
          ? masterId.includes(user_id)
          : masterId == user_id;
        if (!isMaster) {
          return;
        }
      }

      if (group_id) {
        if (config.whiteGroups.length > 0) {
          const whiteGroups = config.whiteGroups.map(String);
          if (!whiteGroups.includes(String(group_id))) {
            return;
          }
        } else {
          const blackGroups = config.blackGroups.map(String);
          if (blackGroups.includes(String(group_id))) {
            return;
          }
        }
      }
    }

    const bot = getBot(e.self_id);
    if (!bot) {
      logger.warn(
        `[Loader] 无法获取 Bot 实例 (self_id: ${e.self_id})，事件可能无法正确处理`
      );
    }

    const eventObj = new Event(e, bot);

    // 优先查找 group_id:user_id 格式的上下文（群组内用户独立上下文）
    let context = e.group_id && e.user_id ? contexts[`${e.group_id}:${e.user_id}`] : null;
    // 兼容旧的私聊上下文（仅使用 user_id）
    if (!context && e.user_id) {
      context = contexts[e.user_id];
    }

    if (context) {
      const { plugin, method } = context;
      plugin.e = eventObj;
      try {
        if (plugin.log) {
        }
        await plugin[method](eventObj);
        return;
      } catch (err) {
        logger.error(`插件 ${plugin.name} 上下文执行出错: ${err}`);
      }
    }

    for (const item of this.executableHandlers) {
      const { instance, handler } = item;
      instance.e = eventObj;
      try {
        const permission = handler.permission || instance.permission;
        if (permission) {
          const config = Config.get();
          const uid = Number(e.user_id);
          const masterId = Number(config.master);

          if (permission === "master") {
            if (uid !== masterId) continue;
          } else if (permission === "white") {
            const whiteUsers = (config.whiteUsers || []).map(Number);
            if (uid !== masterId && !whiteUsers.includes(uid)) continue;
          }
        }

        if (handler.type === "event") {
          if (!this.checkEvent(e, handler.eventName)) continue;
        } else if (handler.type === "regex") {
          const targetEvent = handler.eventName || instance.event || "message";
          if (!this.checkEvent(e, targetEvent)) continue;

          const match = handler.reg.exec(eventObj.msg);
          if (!match) continue;
          eventObj.match = match;
        }

        if (instance.log) {
          logger.info(`[${instance.name}] 触发: ${handler.methodName}`);
        }

        const result = await instance[handler.methodName](eventObj);

        if (result !== false) {
          return;
        }
      } catch (err) {
        logger.error(`插件 ${instance.name} 执行出错: ${err}`);
      }
    }
  }

  checkEvent(e, targetEvent) {
    let currentEventStr = e.post_type;

    if (e.post_type === "message") {
      currentEventStr += `.${e.message_type}`;
    } else if (e.post_type === "notice") {
      currentEventStr += `.${e.notice_type}`;
      if (e.sub_type) currentEventStr += `.${e.sub_type}`;
    } else if (e.post_type === "request") {
      currentEventStr += `.${e.request_type}`;
      if (e.sub_type) currentEventStr += `.${e.sub_type}`;
    } else if (e.post_type === "meta_event") {
      currentEventStr += `.${e.meta_event_type}`;
    }

    return currentEventStr.startsWith(targetEvent);
  }
}
