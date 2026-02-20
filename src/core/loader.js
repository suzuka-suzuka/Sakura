import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import chokidar from "chokidar";
import { fileURLToPath, pathToFileURL } from "url";
import {
  PLUGIN_HANDLERS,
  HANDLER_METADATA,
  plugin,
  Event,
  contexts,
  eventStorage,
} from "./plugin.js";
import Config from "./config.js";
import pluginConfigManager from "./pluginConfig.js";
import schedule from "node-schedule";
import { logger } from "../utils/logger.js";
import { getBot } from "../api/client.js";
import EconomyManager from "../../plugins/sakura-plugin/lib/economy/EconomyManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let commandNamesCache = null;

async function getCommandNames() {
  if (commandNamesCache) return commandNamesCache;
  try {
    const schemaPath = path.join(__dirname, "../../plugins/sakura-plugin/configSchema.js");
    const schemaUrl = pathToFileURL(schemaPath).href + '?t=' + Date.now();
    const schemaMod = await import(schemaUrl);
    commandNamesCache = schemaMod.commandNames || {};
    return commandNamesCache;
  } catch {
    return {};
  }
}

async function checkAndConsumeCoins(e, instance, handler) {
  try {
    const economyConfig = pluginConfigManager.getConfig("sakura-plugin", "economy");
    if (!economyConfig?.enable) return true;

    const groupId = e.group_id;
    if (!groupId || !economyConfig.Groups?.includes(Number(groupId))) return true;

    const commandKey = `${instance.constructor.name}.${handler.methodName}`;

    const commandNames = await getCommandNames();
    const commandDisplayName = commandNames[commandKey];

    if (!commandDisplayName) return true;

    const commandCosts = economyConfig.commandCosts || [];
    const costConfig = commandCosts.find(c => c.command === commandDisplayName);

    if (!costConfig || !costConfig.cost || costConfig.cost <= 0) return true;

    const economyManager = new EconomyManager(e);

    const userCoins = economyManager.getCoins(e);
    if (userCoins < costConfig.cost) {
      return false;
    }

    economyManager.reduceCoins(e, costConfig.cost);
    return true;
  } catch (err) {
    logger.error(`[Loader] 检查指令消耗出错: ${err}`);
    return true;
  }
}

export class PluginLoader {
  constructor() {
    this.executableHandlers = [];
    this.pluginDirs = [];
    this.watchers = [];
    this.loadedPlugins = new Map();
    this.configToPlugins = new Map();
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
            const schemaPath = path.join(fullPath, 'configSchema.js');
            const pluginName = entry.name;
            try {
              await fs.access(schemaPath);
              const schemaUrl = pathToFileURL(schemaPath).href + '?t=' + Date.now();
              const schemaMod = await import(schemaUrl);
              const schemaMap = schemaMod.configSchema || schemaMod.default;
              const categories = schemaMod.schemaCategories || null;
              const pluginMeta = schemaMod.pluginMeta || null;
              const dynamicOptionsConfig = schemaMod.dynamicOptionsConfig || null;
              if (schemaMap && typeof schemaMap === 'object') {
                if (!pluginConfigManager.schemas[pluginName]) {
                  pluginConfigManager.register(pluginName, schemaMap, categories, pluginMeta, dynamicOptionsConfig);
                }
              }
            } catch {
            }
            await this.loadPlugin(indexPath);

            this._registerConfigWatcher(pluginName);

            const appsPath = path.join(fullPath, 'apps');
            try {
              await fs.access(appsPath);
              await this.loadPluginsFromDir(appsPath);
            } catch {
            }
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

          if (instance.configWatch) {
            const watchConfigs = Array.isArray(instance.configWatch)
              ? instance.configWatch
              : [instance.configWatch];

            const pluginName = this._getPluginNameFromPath(filePath);
            if (pluginName) {
              for (const configName of watchConfigs) {
                const key = `${pluginName}/${configName}`;
                if (!this.configToPlugins.has(key)) {
                  this.configToPlugins.set(key, new Set());
                }
                this.configToPlugins.get(key).add(filePath);
              }
            }
          }

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

  _getPluginNameFromPath(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    const match = normalized.match(/plugins\/([^/]+)/);
    return match ? match[1] : null;
  }


  _registerConfigWatcher(pluginName) {
    if (this._configWatcherRegistered?.has(pluginName)) return;
    if (!this._configWatcherRegistered) this._configWatcherRegistered = new Set();
    this._configWatcherRegistered.add(pluginName);
    pluginConfigManager.onChange(pluginName, async (configName, newConfig) => {
      const key = `${pluginName}/${configName}`;
      const pluginPaths = this.configToPlugins.get(key);

      if (pluginPaths && pluginPaths.size > 0) {
        logger.info(`[Loader] 配置 ${key} 变更，正在重载 ${pluginPaths.size} 个相关插件...`);

        for (const pluginPath of pluginPaths) {
          try {
            await this.loadPlugin(pluginPath);
          } catch (e) {
            logger.error(`[Loader] 重载插件失败 ${path.basename(pluginPath)}: ${e}`);
          }
        }
        this.sortHandlers();
      }
    });
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


    for (const [key, paths] of this.configToPlugins.entries()) {
      paths.delete(filePath);
      if (paths.size === 0) {
        this.configToPlugins.delete(key);
      }
    }

    const initialLength = this.executableHandlers.length;
    this.executableHandlers = this.executableHandlers.filter(
      (h) => h.filePath !== filePath
    );
  }

  sortHandlers() {
    this.executableHandlers.sort((a, b) => a.priority - b.priority);
    this.categorizedHandlers = {};
    for (const item of this.executableHandlers) {
      const { instance, handler } = item;
      const targetEvent = handler.type === "regex" ? (handler.eventName || instance.event || "message") : handler.eventName;
      const rootType = targetEvent ? targetEvent.split('.')[0] : "all";

      const typesToAttach = rootType === "all" ? ["message", "notice", "request", "meta_event"] : [rootType];

      for (const t of typesToAttach) {
        if (!this.categorizedHandlers[t]) {
          this.categorizedHandlers[t] = [];
        }
        this.categorizedHandlers[t].push(item);
      }
    }
  }

  startWatch() {
    if (this.watchers.length > 0) return;

    for (const dir of this.pluginDirs) {
      if (!fsSync.existsSync(dir)) continue;

      logger.info(`开始监听插件目录: ${dir}`);
      let debounceTimer;

      const watcher = chokidar.watch(dir, {
        ignored: /(^|[\/\\])\../,
        persistent: true,
        ignoreInitial: true,
      }).on('all', (eventType, filePath) => {
        if (!filePath || !filePath.endsWith(".js")) return;
        if (eventType !== 'add' && eventType !== 'change') return;

        const filename = path.relative(dir, filePath).replace(/\\/g, '/');

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          try {

            const isInAppsDir = filename.includes("apps" + path.sep) || filename.includes("apps/");
            const isInLibDir = false;
            if (filename.includes("lib" + path.sep) || filename.includes("lib/")) return;
            if (isInAppsDir) {

              await fs.access(filePath);
              logger.info(`检测到插件变更: ${filename}，正在重载...`);
              await this.loadPlugin(filePath);
              this.sortHandlers();
            } else if (isInLibDir) {

              const pathParts = filename.split(path.sep).length > 1 ? filename.split(path.sep) : filename.split('/');
              const pluginName = pathParts[0];
              const appsDir = path.join(dir, pluginName, 'apps');
              if (fsSync.existsSync(appsDir)) {
                logger.info(`检测到库文件变更: ${filename}，正在重载 ${pluginName} 的所有插件...`);
                const appFiles = fsSync.readdirSync(appsDir).filter(f => f.endsWith('.js'));
                for (const appFile of appFiles) {
                  const appPath = path.join(appsDir, appFile);
                  await this.loadPlugin(appPath);
                }
                this.sortHandlers();
                logger.info(`已重载 ${appFiles.length} 个插件`);
              }
            } else {

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
              logger.info(`检测到文件变更: ${filename}，正在重载...`);
              await this.loadPlugin(entryPath);
              this.sortHandlers();
            }
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

    // 使用 eventStorage 传播事件对象到所有异步操作中，
    // 确保 setTimeout 等回调中 setContext/finish/getContext 能获取正确的事件
    return eventStorage.run(eventObj, async () => {

      let context = e.group_id && e.user_id ? contexts[`${e.group_id}:${e.user_id}`] : null;

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

      const handlers = this.categorizedHandlers ? (this.categorizedHandlers[e.post_type] || []) : this.executableHandlers;
      for (const item of handlers) {
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



          if (!eventObj.isMaster) {
            const canProceed = await checkAndConsumeCoins(e, instance, handler);
            if (!canProceed) {
              continue;
            }
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
    });
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
