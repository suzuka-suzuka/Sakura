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
  buildContextKey,
  contexts,
  contextTimers,
  eventStorage,
} from "./plugin.js";
import Config from "./config.js";
import pluginConfigManager from "./pluginConfig.js";
import schedule from "node-schedule";
import { logger, logContext } from "../utils/logger.js";
import { getBot, getBots, withBotContext } from "../api/client.js";
import { isMasterUser } from "../utils/common.js";
import EconomyManager from "../../plugins/sakura-plugin/lib/economy/EconomyManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_RUNTIME_BASE_DIR = path.join(__dirname, "../../temp/plugin-runtime");
const HOT_RELOAD_CODE_DIRS = new Set(["apps", "lib"]);
const HOT_RELOAD_SHARED_DIRS = new Set([".git", ".runtime", "node_modules", "data", "logs"]);

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

function buildCronScopeIds(pluginName) {
  const configuredIds = pluginConfigManager.getConfiguredSelfIds(pluginName);
  const onlineIds = getBots().map((currentBot) => Number(currentBot.self_id)).filter((selfId) =>
    Number.isFinite(selfId)
  );
  return [...new Set([...configuredIds, ...onlineIds])];
}

async function runCronInScope(instance, handler, selfId = null) {
  const run = async () => {
    instance.e = null;
    await instance[handler.methodName].call(instance);
  };

  if (selfId == null) {
    return run();
  }

  return withBotContext(selfId, run);
}

export class PluginLoader {
  constructor() {
    this.executableHandlers = [];
    this.pluginDirs = [];
    this.watchers = [];
    this.loadedPlugins = new Map();
    this.configToPlugins = new Map();
    /** 记录每个插件文件对应的动态 import URL，用于卸载时清理模块缓存 */
    this.loadedModuleUrls = new Map();
    this.pluginRuntimeState = new Map();
    this.pluginDirs.push(path.join(__dirname, "../../plugins"));

    fsSync.rmSync(PLUGIN_RUNTIME_BASE_DIR, { recursive: true, force: true });
    fsSync.mkdirSync(PLUGIN_RUNTIME_BASE_DIR, { recursive: true });
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
                pluginConfigManager.register(pluginName, schemaMap, categories, pluginMeta, dynamicOptionsConfig);
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
      // 清理该文件之前的模块缓存条目，避免内存泄漏
      const prevUrl = this.loadedModuleUrls.get(filePath);
      if (prevUrl) {
        // Node.js ESM 没有公开的缓存清理 API，
        // 但我们可以解除对旧模块 URL 的引用追踪，帮助 GC
        this.loadedModuleUrls.delete(filePath);
      }

      const runtimeFilePath = this._getRuntimeFilePath(filePath);
      const fileUrl = pathToFileURL(runtimeFilePath).href;
      const module = await import(fileUrl);
      this.loadedModuleUrls.set(filePath, fileUrl);


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
          const pluginName = this._getPluginNameFromPath(filePath);

          for (const handler of handlers) {
            if (handler.type === "cron" && handler.cronExpression) {
              handler.isExecuting = false;
              const job = schedule.scheduleJob(
                handler.cronExpression,
                async () => {
                  if (handler.isExecuting) {
                    logger.warn(`[${instance.name}] 定时任务 ${handler.methodName} 仍在执行中，跳过本次触发`);
                    return;
                  }
                  try {
                    handler.isExecuting = true;
                    if (instance.log) {
                      logger.info(
                        `[${instance.name}] 触发定时任务: ${handler.methodName}`
                      );
                    }
                    const scopeIds = pluginName ? buildCronScopeIds(pluginName) : [];
                    if (scopeIds.length === 0) {
                      await runCronInScope(instance, handler, null);
                    } else {
                      for (const selfId of scopeIds) {
                        await runCronInScope(instance, handler, selfId);
                      }
                    }
                  } catch (e) {
                    logger.error(
                      `[${instance.name}] 定时任务 ${handler.methodName} 执行出错: ${e}`
                    );
                  } finally {
                    handler.isExecuting = false;
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

  _getPluginRootFromPath(filePath) {
    const normalized = path.resolve(filePath).replace(/\\/g, "/");
    const match = normalized.match(/^(.*\/plugins\/[^/]+)/);
    return match ? path.normalize(match[1]) : null;
  }

  _getPluginRelativePath(filePath) {
    const pluginRoot = this._getPluginRootFromPath(filePath);
    if (!pluginRoot) return null;
    return path.relative(pluginRoot, filePath).replace(/\\/g, "/");
  }

  _classifyWatchedPluginPath(filePath) {
    const relativePath = this._getPluginRelativePath(filePath);
    if (!relativePath || !relativePath.endsWith(".js")) return null;

    const parts = relativePath.split("/");
    if (parts[0] === "lib") {
      return "dependency";
    }
    if (parts.length === 1) {
      return relativePath === "configSchema.js" ? "meta" : "entry";
    }
    if (parts[0] === "apps") {
      return "entry";
    }
    return null;
  }

  _getPluginRuntimeState(pluginName, pluginRoot) {
    let state = this.pluginRuntimeState.get(pluginName);
    if (!state || state.sourceRoot !== pluginRoot) {
      state = {
        sourceRoot: pluginRoot,
        version: 0,
        runtimeRoot: null,
      };
      this.pluginRuntimeState.set(pluginName, state);
    }
    return state;
  }

  _getPluginRuntimeRoot(pluginName, version) {
    return path.join(PLUGIN_RUNTIME_BASE_DIR, `v${version}`, pluginName);
  }

  _createRuntimeJunction(sourcePath, targetPath) {
    if (fsSync.existsSync(targetPath)) return;
    fsSync.mkdirSync(path.dirname(targetPath), { recursive: true });
    fsSync.symlinkSync(path.resolve(sourcePath), targetPath, "junction");
  }

  /**
   * 在运行时基础目录下创建指向项目真实 src/ 和 plugins/ 的 junction，
   * 以便被复制到运行时快照中的插件代码通过相对路径 import 仍能正确解析。
   * 例如 setting.js 中的 "../../../src/core/pluginConfig.js"
   */
  _ensureExternalJunctions() {
    if (this._externalJunctionsDone) return;
    const projectRoot = path.join(__dirname, "../..");
    for (const dirName of ["src", "plugins"]) {
      const target = path.join(PLUGIN_RUNTIME_BASE_DIR, dirName);
      if (!fsSync.existsSync(target)) {
        try {
          fsSync.symlinkSync(path.resolve(projectRoot, dirName), target, "junction");
        } catch { /* 已存在或无权限 */ }
      }
    }
    this._externalJunctionsDone = true;
  }

  _buildPluginRuntimeSnapshot(pluginName, pluginRoot, version) {
    const runtimeRoot = this._getPluginRuntimeRoot(pluginName, version);
    if (fsSync.existsSync(runtimeRoot)) {
      return runtimeRoot;
    }

    fsSync.mkdirSync(runtimeRoot, { recursive: true });

    // 确保运行时基础目录中存在 src → 真实 src 的 junction，
    // 以便插件代码中 "../../../src/..." 等相对引用能正确解析
    this._ensureExternalJunctions();

    const entries = fsSync.readdirSync(pluginRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".runtime") continue;

      const sourcePath = path.join(pluginRoot, entry.name);
      const targetPath = path.join(runtimeRoot, entry.name);

      if (entry.isDirectory()) {
        if (HOT_RELOAD_CODE_DIRS.has(entry.name)) {
          fsSync.cpSync(sourcePath, targetPath, { recursive: true, force: true });
        } else if (HOT_RELOAD_SHARED_DIRS.has(entry.name)) {
          this._createRuntimeJunction(sourcePath, targetPath);
        } else {
          this._createRuntimeJunction(sourcePath, targetPath);
        }
        continue;
      }

      if (entry.isFile()) {
        fsSync.copyFileSync(sourcePath, targetPath);
      }
    }

    return runtimeRoot;
  }

  _ensurePluginRuntime(pluginName, pluginRoot, { bump = false } = {}) {
    const state = this._getPluginRuntimeState(pluginName, pluginRoot);
    if (!state.runtimeRoot || bump) {
      state.version += 1;
      state.runtimeRoot = this._buildPluginRuntimeSnapshot(pluginName, pluginRoot, state.version);
    }
    return state;
  }

  _getRuntimeFilePath(filePath) {
    const pluginName = this._getPluginNameFromPath(filePath);
    const pluginRoot = this._getPluginRootFromPath(filePath);

    if (!pluginName || !pluginRoot) {
      return filePath;
    }

    const state = this._ensurePluginRuntime(pluginName, pluginRoot);
    const relativePath = path.relative(pluginRoot, filePath);
    return path.join(state.runtimeRoot, relativePath);
  }

  _collectPluginEntryFiles(pluginName) {
    const runtimeState = this.pluginRuntimeState.get(pluginName);
    const pluginRoot = runtimeState?.sourceRoot || path.join(__dirname, "../../plugins", pluginName);

    if (!fsSync.existsSync(pluginRoot)) {
      return [];
    }

    const entryFiles = new Set();
    const rootEntries = fsSync.readdirSync(pluginRoot, { withFileTypes: true });

    for (const entry of rootEntries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".js")) continue;
      if (entry.name === "configSchema.js") continue;
      entryFiles.add(path.join(pluginRoot, entry.name));
    }

    const appsDir = path.join(pluginRoot, "apps");
    if (fsSync.existsSync(appsDir)) {
      const walk = (dir) => {
        const entries = fsSync.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
            continue;
          }
          if (entry.isFile() && entry.name.endsWith(".js")) {
            entryFiles.add(fullPath);
          }
        }
      };

      walk(appsDir);
    }

    return [...entryFiles];
  }

  async _reloadPluginEntries(pluginName, reason = "change") {
    const entryFiles = this._collectPluginEntryFiles(pluginName);
    if (entryFiles.length === 0) {
      return;
    }

    logger.info(`[Loader] 检测到 ${pluginName} ${reason}，正在重载 ${entryFiles.length} 个入口插件。`);

    for (const entryFile of entryFiles) {
      await this.loadPlugin(entryFile);
    }

    this.sortHandlers();
  }

  async _handleWatchedPluginChange(filePath, eventType) {
    const pluginName = this._getPluginNameFromPath(filePath);
    const pluginRoot = this._getPluginRootFromPath(filePath);
    const changeType = this._classifyWatchedPluginPath(filePath);

    if (!pluginName || !pluginRoot || !changeType) {
      return;
    }

    if (path.basename(filePath) === "configSchema.js") {
      commandNamesCache = null;
    }

    if (changeType === "dependency" || changeType === "meta") {
      this._ensurePluginRuntime(pluginName, pluginRoot, { bump: true });
      await this._reloadPluginEntries(
        pluginName,
        changeType === "dependency" ? "lib 变更" : "配置元数据变更"
      );
      return;
    }

    if (changeType === "entry") {
      if (eventType === "unlink" || !fsSync.existsSync(filePath)) {
        this.unloadPlugin(filePath);
        this.sortHandlers();
        return;
      }

      this._ensurePluginRuntime(pluginName, pluginRoot, { bump: true });
      logger.info(`[Loader] 检测到插件变更: ${this._getPluginRelativePath(filePath)}，正在重载。`);
      await this.loadPlugin(filePath);
      this.sortHandlers();
    }
  }


  _registerConfigWatcher(pluginName) {
    if (this._configWatcherRegistered?.has(pluginName)) return;
    if (!this._configWatcherRegistered) this._configWatcherRegistered = new Set();
    this._configWatcherRegistered.add(pluginName);
    pluginConfigManager.onChange(pluginName, async (configName, newConfig) => {
      const key = `${pluginName}/${configName}`;
      const pluginPaths = this.configToPlugins.get(key);

      if (pluginPaths && pluginPaths.size > 0) {
        logger.info(`[Loader] 配置 ${key} 变更，正在重载 ${pluginPaths.size} 个相关插件..`);

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
      const normalizedInstances = Array.isArray(instances) ? instances : [instances];

      for (const instance of normalizedInstances) {
        if (instance?.destroy) {
          instance.destroy();
        }

        for (const [key, context] of Object.entries(contexts)) {
          if (context?.plugin !== instance) continue;
          delete contexts[key];
          if (contextTimers[key]) {
            clearTimeout(contextTimers[key]);
            delete contextTimers[key];
          }
        }
      }

      this.loadedPlugins.delete(filePath);
    }

    // 清理模块 URL 追踪，帮助旧模块被 GC
    this.loadedModuleUrls.delete(filePath);

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

  _legacyStartWatch() {
    return undefined;

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
        if (!['add', 'change', 'unlink'].includes(eventType)) return;

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          try {
            await this._handleWatchedPluginChange(filePath, eventType);

            logger.info(`检测到插件变更: ${filename}，正在重载..`);
          } catch {
            this.unloadPlugin(filePath);
            this.sortHandlers();
          }
        }, 100);
      }
      );
      this.watchers.push(watcher);
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
      }).on("all", (eventType, filePath) => {
        if (!filePath || !filePath.endsWith(".js")) return;
        if (!["add", "change", "unlink"].includes(eventType)) return;

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          try {
            await this._handleWatchedPluginChange(filePath, eventType);
          } catch {
            this.unloadPlugin(filePath);
            this.sortHandlers();
          }
        }, 100);
      });

      this.watchers.push(watcher);
    }
  }

  async deal(e) {
    if (e.post_type !== "meta_event") {
      const config = Config.getForSelf(e.self_id);
      const { group_id, user_id } = e;

      if (user_id && config.blackUsers.includes(user_id)) {
        return;
      }

      if (config.blockPrivate && e.message_type === "private") {
        if (!isMasterUser(user_id, config.master)) {
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
    const _logCtx = {
      self_id: e.self_id,
      group_id: e.group_id,
      user_id: e.user_id,
      group_name: e.group_name,
      user_name: e.sender?.card || e.sender?.nickname,
    };
    return logContext.run(_logCtx, () => withBotContext(e.self_id, () => eventStorage.run(eventObj, async () => {

      let context = buildContextKey(e, true) ? contexts[buildContextKey(e, true)] : null;

      if (!context && e.user_id) {
        context = contexts[buildContextKey(e, false)];
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
            const config = Config.getForSelf(e.self_id);
            const uid = String(e.user_id);
            const isUserMaster = isMasterUser(uid, config.master);

            if (permission === "master") {
              if (!isUserMaster) continue;
            } else if (permission === "white") {
              const whiteUsers = (config.whiteUsers || []).map(String);
              if (!isUserMaster && !whiteUsers.includes(uid)) continue;
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
    })));
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
