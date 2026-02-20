import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import chokidar from 'chokidar';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_CONFIG_DIR = path.join(__dirname, '../../config');

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
            logger.warn(`[PluginConfig] ${pluginName} 提供的 schemaMap 无效，跳过注册`);
            return;
        }
        this.schemas[pluginName] = schemaMap;
        this.configs[pluginName] = {};
        if (categories && typeof categories === 'object') {
            this.categories[pluginName] = categories;
        }
        if (pluginMeta && typeof pluginMeta === 'object') {
            this.pluginMeta[pluginName] = pluginMeta;
        }
        if (dynamicOptionsConfig && typeof dynamicOptionsConfig === 'object') {
            this.dynamicOptionsConfig[pluginName] = dynamicOptionsConfig;
        }

        const configDir = path.join(ROOT_CONFIG_DIR, pluginName);


        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
            logger.info(`[PluginConfig] 已创建配置目录: config/${pluginName}/`);
        }


        for (const [moduleName, schema] of Object.entries(schemaMap)) {
            this._initModuleConfig(pluginName, moduleName, schema, configDir);
        }


        this._watchDir(pluginName, configDir);
        const moduleCount = Object.keys(schemaMap).length;
        logger.info(`[PluginConfig] 已注册 ${pluginName}（${moduleCount} 个模块）`);
    }

    _initModuleConfig(pluginName, moduleName, schema, configDir) {
        const configFile = path.join(configDir, `${moduleName}.yaml`);


        if (!fs.existsSync(configFile)) {
            const oldConfigFile = path.join(__dirname, '../../plugins', pluginName, 'config', `${moduleName}.yaml`);
            if (fs.existsSync(oldConfigFile)) {
                try {
                    fs.copyFileSync(oldConfigFile, configFile);
                    logger.info(`[PluginConfig] 已迁移旧配置: plugins/${pluginName}/config/${moduleName}.yaml → config/${pluginName}/${moduleName}.yaml`);
                } catch (e) {
                    logger.error(`[PluginConfig] 迁移旧配置失败: ${e}`);
                }
            }
        }

        if (fs.existsSync(configFile)) {
            this._loadModuleConfig(pluginName, moduleName, schema, configFile);
        } else {

            try {
                const defaultConfig = this._getDefaults(schema);
                this._writeYaml(configFile, defaultConfig);
                this.configs[pluginName][moduleName] = defaultConfig;
                logger.info(`[PluginConfig] 已生成默认配置: config/${pluginName}/${moduleName}.yaml`);
            } catch (e) {
                logger.error(`[PluginConfig] 生成默认配置失败 [${pluginName}/${moduleName}]: ${e}`);
            }
        }
    }


    _loadModuleConfig(pluginName, moduleName, schema, configFile) {
        try {
            const rawContent = fs.readFileSync(configFile, 'utf8');
            const rawData = yaml.load(rawContent);

            const result = schema.safeParse(rawData || {});
            if (result.success) {
                this.configs[pluginName][moduleName] = result.data;
                if (JSON.stringify(result.data) !== JSON.stringify(rawData)) {
                    this._writeYaml(configFile, result.data);
                    logger.debug(`[PluginConfig] 已同步配置: config/${pluginName}/${moduleName}.yaml`);
                }
            } else {

                logger.warn(`[PluginConfig] 配置验证有误 [${pluginName}/${moduleName}]:`);
                for (const issue of result.error.issues) {
                    logger.warn(`  - ${issue.path.join('.')}: ${issue.message}`);
                }
                const defaults = this._getDefaults(schema);
                this.configs[pluginName][moduleName] = this._mergeObjects(defaults, rawData || {});
            }
        } catch (e) {
            logger.error(`[PluginConfig] 加载配置失败 [${pluginName}/${moduleName}]: ${e}`);
            try {
                this.configs[pluginName][moduleName] = this._getDefaults(schema);
            } catch {
                this.configs[pluginName][moduleName] = {};
            }
        }
    }


    _getDefaults(schema) {
        try {
            return schema.parse({});
        } catch {

            try { return schema.parse(undefined); } catch { return {}; }
        }
    }


    getConfig(pluginName, moduleName) {
        if (!this.configs[pluginName]) return null;
        const config = this.configs[pluginName][moduleName];
        return config !== undefined ? config : null;
    }


    getAll(pluginName) {
        return this.configs[pluginName] || null;
    }


    setConfig(pluginName, moduleName, newData) {
        const schema = this.schemas[pluginName]?.[moduleName];
        if (!schema) {
            return { success: false, errors: [{ message: `未找到 Schema: ${pluginName}/${moduleName}` }] };
        }

        const result = schema.safeParse(newData);
        if (!result.success) {
            return { success: false, errors: result.error.issues };
        }
        const configFile = path.join(ROOT_CONFIG_DIR, pluginName, `${moduleName}.yaml`);
        this.configs[pluginName][moduleName] = result.data;
        this._writeYaml(configFile, result.data);
        return { success: true };
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

    _schemaToMeta(schema, labelFallback = '') {
        if (!schema) return { type: 'string', description: labelFallback, label: '', help: '' };


        let inner = schema;
        let defaultValue = undefined;
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
        if (description) {
            const parts = description.split('|');
            label = parts[0].trim();

            const remaining = [];
            for (let i = 1; i < parts.length; i++) {
                const part = parts[i].trim();
                if (part.startsWith('#')) {
                    uiType = part.slice(1);
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
            let itemSchema = inner._zod?.def?.element;
            let itemMeta = { type: 'string' };
            if (itemSchema) {
                itemMeta = this._schemaToMeta(itemSchema, '');
            }
            return { type: 'array', description: displayName, label, help, items: itemMeta, default: defaultValue, ...(uiType && { uiType }) };
        }

        if (typeName === 'enum') {
            const values = inner._zod?.def?.entries || inner._zod?.def?.values || [];
            return { type: 'enum', description: displayName, label, help, options: values, default: defaultValue, ...(uiType && { uiType }) };
        }

        if (typeName === 'union') {
            const options = inner._zod?.def?.options || [];
            const types = options.map(o => o._zod?.def?.type).filter(Boolean);
            if (types.includes('number') && types.includes('string')) {
                return { type: 'number|string', description: displayName, label, help, default: defaultValue, ...(uiType && { uiType }) };
            }
        }


        const typeMap = {
            'string': 'string',
            'number': 'number',
            'boolean': 'boolean',
            'int': 'number',
            'float': 'number',
        };

        return {
            type: typeMap[typeName] || 'string',
            description: displayName,
            label,
            help,
            default: defaultValue,
            ...(uiType && { uiType }),
        };
    }


    onChange(pluginName, callback) {
        if (!this._listeners[pluginName]) {
            this._listeners[pluginName] = [];
        }
        this._listeners[pluginName].push(callback);
    }


    _watchDir(pluginName, configDir) {
        if (this.watchers[pluginName]) return;

        const watcher = chokidar.watch(configDir, {
            ignoreInitial: true,
            awaitWriteFinish: { stabilityThreshold: 300 },
        });

        watcher.on('change', (filePath) => {
            const basename = path.basename(filePath, '.yaml');
            if (!filePath.endsWith('.yaml')) return;

            const schema = this.schemas[pluginName]?.[basename];
            if (!schema) return;

            logger.info(`[PluginConfig] 检测到配置变更: ${pluginName}/${basename}`);
            this._loadModuleConfig(pluginName, basename, schema, filePath);


            const listeners = this._listeners[pluginName] || [];
            for (const fn of listeners) {
                try {
                    fn(basename, this.configs[pluginName][basename]);
                } catch (e) {
                    logger.error(`[PluginConfig] onChange 回调执行失败: ${e}`);
                }
            }
        });

        this.watchers[pluginName] = watcher;
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
            const yamlContent = yaml.dump(data, {
                indent: 2,
                lineWidth: -1,
                noRefs: true,
                quotingType: "'",
            });
            fs.writeFileSync(filePath, yamlContent, 'utf8');
        } catch (e) {
            logger.error(`[PluginConfig] 写入文件失败 [${filePath}]: ${e}`);
        }
    }
}

export default new PluginConfigManager();
