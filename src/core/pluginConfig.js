import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import chokidar from 'chokidar';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { getCurrentBotSelfId } from '../api/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_CONFIG_DIR = path.join(__dirname, '../../config');
const ACCOUNT_SCOPE_DIR = '_accounts';
const DEFAULT_SCOPE_KEY = '__default__';

function normalizeSelfId(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function toScopeKey(selfId) {
    return selfId == null ? DEFAULT_SCOPE_KEY : String(selfId);
}

class PluginConfigManager {
    constructor() {
        this.schemas = {};
        this.configs = {};
        this.categories = {};
        this.pluginMeta = {};
        this.dynamicOptionsConfig = {};
        this.watchers = {};
        this._listeners = {};
    }

    register(pluginName, schemaMap, categories, pluginMeta, dynamicOptionsConfig) {
        if (!schemaMap || typeof schemaMap !== 'object') {
            logger.warn(`[插件配置] ${pluginName} 提供了无效的 schemaMap，跳过注册`);
            return;
        }

        this.schemas[pluginName] = schemaMap;
        this.configs[pluginName] ||= {};

        if (categories && typeof categories === 'object') {
            this.categories[pluginName] = categories;
        }
        if (pluginMeta && typeof pluginMeta === 'object') {
            this.pluginMeta[pluginName] = pluginMeta;
        }
        if (dynamicOptionsConfig && typeof dynamicOptionsConfig === 'object') {
            this.dynamicOptionsConfig[pluginName] = dynamicOptionsConfig;
        }

        const pluginDir = this._getPluginDir(pluginName);
        if (!fs.existsSync(pluginDir)) {
            fs.mkdirSync(pluginDir, { recursive: true });
            logger.info(`[插件配置] 已创建配置目录 config/${pluginName}/`);
        }

        this._watchDir(pluginName, pluginDir);

        const moduleCount = Object.keys(schemaMap).length;
        logger.info(`[插件配置] 已注册 ${pluginName} (${moduleCount} 个模块)`);
    }

    getConfig(pluginName, moduleName, options = {}) {
        const schema = this.schemas[pluginName]?.[moduleName];
        if (!schema) return null;

        const selfId = this._resolveSelfId(options);
        const scope = this._ensureScopeLoaded(pluginName, selfId);
        const config = scope?.[moduleName];
        return config !== undefined ? config : null;
    }

    getAll(pluginName, options = {}) {
        if (!this.schemas[pluginName]) return null;
        const selfId = this._resolveSelfId(options);
        return this._ensureScopeLoaded(pluginName, selfId);
    }

    setConfig(pluginName, moduleName, newData, options = {}) {
        const schema = this.schemas[pluginName]?.[moduleName];
        if (!schema) {
            return { success: false, errors: [{ message: `Schema not found: ${pluginName}/${moduleName}` }] };
        }

        const result = schema.safeParse(newData);
        if (!result.success) {
            return { success: false, errors: result.error.issues };
        }

        const selfId = this._resolveSelfId(options);
        const scopeKey = toScopeKey(selfId);
        this.configs[pluginName] ||= {};
        this.configs[pluginName][scopeKey] ||= {};
        this.configs[pluginName][scopeKey][moduleName] = result.data;

        const configFile = this._getConfigFilePath(pluginName, moduleName, selfId);
        this._writeYaml(configFile, result.data);

        return { success: true, selfId };
    }

    getSchema(pluginName, moduleName) {
        return this.schemas[pluginName]?.[moduleName] || null;
    }

    getRegisteredPlugins() {
        const result = {};
        for (const [pluginName, schemaMap] of Object.entries(this.schemas)) {
            result[pluginName] = {
                modules: Object.keys(schemaMap),
                categories: this.categories[pluginName] || null,
                meta: this.pluginMeta[pluginName] || null,
            };
        }
        return result;
    }

    getDynamicOptionsConfig(pluginName) {
        return this.dynamicOptionsConfig[pluginName] || null;
    }

    getSchemaMetadata(pluginName, moduleName) {
        const schema = this.schemas[pluginName]?.[moduleName];
        if (!schema) return null;
        return this._schemaToMeta(schema, moduleName);
    }

    getAllSchemaMetadata(pluginName) {
        const schemaMap = this.schemas[pluginName];
        if (!schemaMap) return null;

        const result = {};
        for (const [moduleName, schema] of Object.entries(schemaMap)) {
            result[moduleName] = this._schemaToMeta(schema, moduleName);
        }
        return result;
    }

    getConfiguredSelfIds(pluginName) {
        const accountsDir = this._getAccountsDir(pluginName);
        if (!fs.existsSync(accountsDir)) {
            return [];
        }

        try {
            return fs.readdirSync(accountsDir, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => normalizeSelfId(entry.name))
                .filter((selfId) => selfId != null && selfId > 0)
                .sort((a, b) => a - b);
        } catch (error) {
            logger.error(`[插件配置] 扫描 ${pluginName} 的账号配置目录失败: ${error}`);
            return [];
        }
    }

    onChange(pluginName, callback) {
        if (!this._listeners[pluginName]) {
            this._listeners[pluginName] = [];
        }
        this._listeners[pluginName].push(callback);
    }

    _resolveSelfId(options = {}) {
        if (options && Object.prototype.hasOwnProperty.call(options, 'selfId')) {
            const id = normalizeSelfId(options.selfId);
            return id || null; // 0 视为无效
        }
        const id = getCurrentBotSelfId();
        return id || null; // 0 视为无效，bot 未就绪时不写账号目录
    }

    _getPluginDir(pluginName) {
        return path.join(ROOT_CONFIG_DIR, pluginName);
    }

    _getAccountsDir(pluginName) {
        return path.join(this._getPluginDir(pluginName), ACCOUNT_SCOPE_DIR);
    }

    _getScopeDir(pluginName, selfId) {
        if (selfId == null) {
            return this._getPluginDir(pluginName);
        }
        return path.join(this._getAccountsDir(pluginName), String(selfId));
    }

    _getConfigFilePath(pluginName, moduleName, selfId) {
        return path.join(this._getScopeDir(pluginName, selfId), `${moduleName}.yaml`);
    }

    _getLegacyConfigFilePath(pluginName, moduleName) {
        return path.join(this._getPluginDir(pluginName), `${moduleName}.yaml`);
    }

    _ensureScopeLoaded(pluginName, selfId) {
        const schemaMap = this.schemas[pluginName];
        if (!schemaMap) return null;

        const scopeKey = toScopeKey(selfId);
        this.configs[pluginName] ||= {};
        this.configs[pluginName][scopeKey] ||= {};

        for (const [moduleName, schema] of Object.entries(schemaMap)) {
            this._ensureModuleLoaded(pluginName, moduleName, schema, selfId, scopeKey);
        }

        return this.configs[pluginName][scopeKey];
    }

    _ensureModuleLoaded(pluginName, moduleName, schema, selfId, scopeKey) {
        if (Object.prototype.hasOwnProperty.call(this.configs[pluginName][scopeKey], moduleName)) {
            return;
        }

        const targetFile = this._getConfigFilePath(pluginName, moduleName, selfId);
        if (fs.existsSync(targetFile)) {
            this._loadModuleConfig(pluginName, moduleName, schema, targetFile, scopeKey);
            return;
        }

        let nextConfig = null;
        if (selfId != null) {
            const legacyFile = this._getLegacyConfigFilePath(pluginName, moduleName);
            if (fs.existsSync(legacyFile)) {
                nextConfig = this._readAndNormalizeModule(schema, legacyFile);
            }
        }

        if (nextConfig == null) {
            nextConfig = this._getDefaults(schema);
        }

        this.configs[pluginName][scopeKey][moduleName] = nextConfig;
        this._writeYaml(targetFile, nextConfig);
    }

    _readAndNormalizeModule(schema, filePath) {
        try {
            const rawContent = fs.readFileSync(filePath, 'utf8');
            const rawData = yaml.load(rawContent);
            return this._normalizeModuleData(schema, rawData || {});
        } catch (error) {
            logger.error(`[插件配置] 读取 ${filePath} 失败: ${error}`);
            return this._getDefaults(schema);
        }
    }

    _loadModuleConfig(pluginName, moduleName, schema, configFile, scopeKey) {
        const nextConfig = this._readAndNormalizeModule(schema, configFile);
        this.configs[pluginName][scopeKey][moduleName] = nextConfig;
    }

    _normalizeModuleData(schema, rawData) {
        const result = schema.safeParse(rawData);
        if (result.success) {
            return result.data;
        }

        logger.warn('[插件配置] 配置文件验证失败，正在回退到默认值');
        for (const issue of result.error.issues) {
            logger.warn(`  - ${issue.path.join('.')}: ${issue.message}`);
        }

        const defaults = this._getDefaults(schema);
        return this._mergeObjects(defaults, rawData || {});
    }

    _getDefaults(schema) {
        try {
            return schema.parse({});
        } catch {
            try {
                return schema.parse(undefined);
            } catch {
                return {};
            }
        }
    }

    _schemaToMeta(schema, labelFallback = '') {
        if (!schema) return { type: 'string', description: labelFallback, label: '', help: '' };

        let inner = schema;
        let defaultValue;
        let description = '';
        if (inner.description) {
            description = inner.description;
        }

        if (inner._zod?.def?.type === 'default') {
            defaultValue = typeof inner._zod.def.defaultValue === 'function'
                ? inner._zod.def.defaultValue()
                : inner._zod.def.defaultValue;
            inner = inner._zod.def.innerType || inner;
            if (!description && inner.description) {
                description = inner.description;
            }
        }
        if (inner._zod?.def?.type === 'optional') {
            inner = inner._zod.def.innerType || inner;
            if (!description && inner.description) {
                description = inner.description;
            }
        }
        if (inner._zod?.def?.type === 'default') {
            defaultValue = typeof inner._zod.def.defaultValue === 'function'
                ? inner._zod.def.defaultValue()
                : inner._zod.def.defaultValue;
            inner = inner._zod.def.innerType || inner;
            if (!description && inner.description) {
                description = inner.description;
            }
        }

        let label = '';
        let help = '';
        let uiType = '';
        let step = null;
        let min = null;
        let max = null;
        let fixed = false;
        let nameField = null;

        if (description) {
            const parts = description.split('|');
            label = parts[0].trim();

            const remaining = [];
            for (let i = 1; i < parts.length; i++) {
                const part = parts[i].trim();
                if (part.startsWith('#')) {
                    const directive = part.slice(1);
                    if (directive.startsWith('step:')) {
                        step = parseFloat(directive.slice(5));
                    } else if (directive.startsWith('min:')) {
                        min = parseFloat(directive.slice(4));
                    } else if (directive.startsWith('max:')) {
                        max = parseFloat(directive.slice(4));
                    } else if (directive === 'fixed') {
                        fixed = true;
                    } else if (directive.startsWith('nameField:')) {
                        nameField = directive.slice(10);
                    } else {
                        uiType = directive;
                    }
                } else {
                    remaining.push(part);
                }
            }
            help = remaining.join('|').trim();
        }

        const displayName = label || labelFallback;
        const typeName = inner._zod?.def?.type || '';

        if (typeName === 'object') {
            const shape = inner._zod?.def?.shape || inner.shape || {};
            const children = {};
            for (const [key, childSchema] of Object.entries(shape)) {
                children[key] = this._schemaToMeta(childSchema, key);
            }
            return { type: 'object', description: displayName, label, help, children, default: defaultValue, ...(uiType && { uiType }) };
        }

        if (typeName === 'array') {
            const itemSchema = inner._zod?.def?.element;
            const itemMeta = itemSchema ? this._schemaToMeta(itemSchema, '') : { type: 'string' };
            return {
                type: 'array',
                description: displayName,
                label,
                help,
                items: itemMeta,
                default: defaultValue,
                ...(uiType && { uiType }),
                ...(fixed && { fixed }),
                ...(nameField && { nameField }),
            };
        }

        if (typeName === 'enum') {
            const entriesRaw = inner._zod?.def?.entries;
            const values = entriesRaw
                ? Object.values(entriesRaw)
                : (inner._zod?.def?.values || []);
            return { type: 'enum', description: displayName, label, help, options: values, default: defaultValue, ...(uiType && { uiType }) };
        }

        if (typeName === 'union') {
            const options = inner._zod?.def?.options || [];
            const types = options.map((option) => option._zod?.def?.type).filter(Boolean);
            if (types.includes('number') && types.includes('string')) {
                return { type: 'number|string', description: displayName, label, help, default: defaultValue, ...(uiType && { uiType }) };
            }
        }

        const typeMap = {
            string: 'string',
            number: 'number',
            boolean: 'boolean',
            int: 'number',
            float: 'number',
        };

        return {
            type: typeMap[typeName] || 'string',
            description: displayName,
            label,
            help,
            default: defaultValue,
            ...(uiType && { uiType }),
            ...(step != null && { step }),
            ...(min != null && { min }),
            ...(max != null && { max }),
        };
    }

    _watchDir(pluginName, configDir) {
        if (this.watchers[pluginName]) return;

        const watcher = chokidar.watch(configDir, {
            ignoreInitial: true,
            awaitWriteFinish: { stabilityThreshold: 300 },
        });

        watcher.on('all', (eventType, filePath) => {
            if (eventType !== 'add' && eventType !== 'change') return;
            if (!filePath.endsWith('.yaml')) return;

            const parsed = this._parseConfigFile(pluginName, filePath);
            if (!parsed) return;

            const { moduleName, selfId, scopeKey } = parsed;
            const schema = this.schemas[pluginName]?.[moduleName];
            if (!schema) return;

            logger.info(`[插件配置] 检测到配置更改: ${pluginName}/${moduleName}${selfId != null ? ` (${selfId})` : ''}`);
            this.configs[pluginName] ||= {};
            this.configs[pluginName][scopeKey] ||= {};
            this._loadModuleConfig(pluginName, moduleName, schema, filePath, scopeKey);

            const listeners = this._listeners[pluginName] || [];
            for (const fn of listeners) {
                try {
                    fn(moduleName, this.configs[pluginName][scopeKey][moduleName], { selfId, scopeKey });
                } catch (error) {
                    logger.error(`[插件配置] onChange 回调失败: ${error}`);
                }
            }
        });

        this.watchers[pluginName] = watcher;
    }

    _parseConfigFile(pluginName, filePath) {
        const pluginDir = this._getPluginDir(pluginName);
        const relativePath = path.relative(pluginDir, filePath);
        if (!relativePath || relativePath.startsWith('..')) {
            return null;
        }

        const parts = relativePath.split(path.sep);
        if (parts.length === 1) {
            return {
                moduleName: path.basename(parts[0], '.yaml'),
                selfId: null,
                scopeKey: DEFAULT_SCOPE_KEY,
            };
        }

        if (parts.length === 3 && parts[0] === ACCOUNT_SCOPE_DIR) {
            const selfId = normalizeSelfId(parts[1]);
            if (selfId == null) return null;
            return {
                moduleName: path.basename(parts[2], '.yaml'),
                selfId,
                scopeKey: toScopeKey(selfId),
            };
        }

        return null;
    }

    _mergeObjects(defaults, raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw ?? defaults;
        if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) return defaults;

        const result = {};
        for (const key of Object.keys(defaults)) {
            if (key in raw) {
                if (typeof defaults[key] === 'object' && !Array.isArray(defaults[key])
                    && typeof raw[key] === 'object' && !Array.isArray(raw[key])) {
                    result[key] = this._mergeObjects(defaults[key], raw[key]);
                } else {
                    result[key] = raw[key];
                }
            } else {
                result[key] = defaults[key];
            }
        }
        return result;
    }

    _writeYaml(filePath, data) {
        try {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const yamlContent = yaml.dump(data, {
                indent: 2,
                lineWidth: -1,
                noRefs: true,
                quotingType: "'",
            });
            fs.writeFileSync(filePath, yamlContent, 'utf8');
        } catch (error) {
            logger.error(`[插件配置] 写入 ${filePath} 失败: ${error}`);
        }
    }
}

export { DEFAULT_SCOPE_KEY };
export default new PluginConfigManager();
