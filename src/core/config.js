import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import chokidar from 'chokidar';
import lodash from 'lodash';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { ConfigSchema, getDefaultConfig, schemaToMeta } from './configSchema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '../../config/config.yaml');

class Config {
    constructor() {
        this.config = {};
        this.watcher = null;
        this._listeners = [];
        this._lastErrors = null;
        this.init();
    }

    init() {
        this.checkFile();
        this.load();
        this.watch();
    }

    /**
     * 检查配置文件是否存在
     * 如果不存在，从 Zod Schema 的默认值生成初始配置
     */
    checkFile() {
        if (!fs.existsSync(CONFIG_PATH)) {
            const configDir = path.dirname(CONFIG_PATH);
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }

            // 从 Zod Schema 生成默认配置
            const defaultConfig = getDefaultConfig();
            const yamlContent = yaml.dump(defaultConfig, {
                indent: 2,
                lineWidth: -1,
                noRefs: true,
                quotingType: "'",
            });
            fs.writeFileSync(CONFIG_PATH, yamlContent, 'utf8');
            logger.info('[Config] 配置文件不存在，已从 Schema 默认值生成');
        }
    }

    /**
     * 加载配置文件，并用 Zod Schema 验证
     */
    load() {
        try {
            if (fs.existsSync(CONFIG_PATH)) {
                const fileContents = fs.readFileSync(CONFIG_PATH, 'utf8');
                const rawData = yaml.load(fileContents) || {};

                // 用 Zod 验证（自动补全缺失字段的默认值 + 剥离多余字段）
                const result = ConfigSchema.safeParse(rawData);
                if (result.success) {
                    this.config = result.data;
                    this._lastErrors = null;
                    logger.info('[Config] 配置已加载并验证通过');
                } else {
                    // 验证失败：打印错误
                    this._lastErrors = result.error.issues;
                    logger.warn('[Config] 配置验证有误，部分字段可能不符合 Schema:');
                    for (const issue of result.error.issues) {
                        logger.warn(`  - ${issue.path.join('.')}: ${issue.message}`);
                    }
                    // 用默认值兜底，再深度合并用户的合法值
                    this.config = this._deepMergeWithDefaults(rawData);
                }

                // 检查是否需要同步：缺失字段需补全 / 多余字段需清理
                if (JSON.stringify(this.config) !== JSON.stringify(rawData)) {
                    logger.info('[Config] 配置结构与 Schema 不一致，正在同步...');
                    this._syncSave();
                }

                // Set logger level if present
                if (this.config.logLevel) {
                    logger.level = this.config.logLevel;
                }
            } else {
                this.config = getDefaultConfig();
                this._syncSave();
                logger.info('[Config] 配置文件不存在，已从 Schema 默认值生成');
            }

            // 通知所有监听器
            this._notifyListeners();
        } catch (e) {
            logger.error(`[Config] 加载配置失败: ${e}`);
        }
    }

    /**
     * 将用户的原始数据与 Schema 默认值深度合并
     * 保留用户已填写的合法值，补充缺失字段，剥离多余字段
     */
    _deepMergeWithDefaults(rawData) {
        const defaults = getDefaultConfig();
        return this._mergeObjects(defaults, rawData);
    }

    _mergeObjects(defaults, raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw ?? defaults;
        if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) return defaults;

        const result = {};
        // 只保留 defaults 中存在的键（Schema 定义的键）
        for (const key of Object.keys(defaults)) {
            if (key in raw) {
                // 如果两边都是对象，递归合并
                if (typeof defaults[key] === 'object' && !Array.isArray(defaults[key])
                    && typeof raw[key] === 'object' && !Array.isArray(raw[key])) {
                    result[key] = this._mergeObjects(defaults[key], raw[key]);
                } else {
                    // 取用户的值
                    result[key] = raw[key];
                }
            } else {
                // 用户缺失此键，用默认值补全
                result[key] = defaults[key];
            }
        }
        return result;
    }

    /**
     * 同步保存到文件（在 watcher 触发前暂停监听，避免循环重载）
     */
    _syncSave() {
        try {
            // 暂时取消监听，防止 save → change → load 的循环
            if (this.watcher) {
                this.watcher.removeAllListeners('change');
            }

            const yamlContent = yaml.dump(this.config, {
                indent: 2,
                lineWidth: -1,
                noRefs: true,
                quotingType: "'",
            });
            fs.writeFileSync(CONFIG_PATH, yamlContent, 'utf8');

            // 延迟恢复监听（等文件系统事件消化完）
            setTimeout(() => {
                if (this.watcher) {
                    this.watcher.on('change', () => {
                        logger.info('[Config] 检测到配置文件变更，正在重载...');
                        this.load();
                    });
                }
            }, 500);
        } catch (e) {
            logger.error(`[Config] 同步保存配置失败: ${e}`);
        }
    }

    get(key) {
        if (key) {
            return lodash.get(this.config, key);
        }
        return this.config;
    }

    set(key, value) {
        lodash.set(this.config, key, value);
        return this.save();
    }

    /**
     * 批量更新配置（替换整个配置对象）
     */
    update(newConfig) {
        // 验证新配置
        const result = ConfigSchema.safeParse(newConfig);
        if (!result.success) {
            this._lastErrors = result.error.issues;
            return { success: false, errors: result.error.issues };
        }

        this.config = result.data;
        this._lastErrors = null;
        const saved = this.save();
        if (saved) {
            return { success: true };
        }
        return { success: false, errors: [{ message: '保存文件失败' }] };
    }

    save() {
        try {
            const yamlContent = yaml.dump(this.config, {
                indent: 2,
                lineWidth: -1,
                noRefs: true,
                quotingType: "'",
            });
            fs.writeFileSync(CONFIG_PATH, yamlContent, 'utf8');
            return true;
        } catch (e) {
            logger.error(`[Config] 保存配置失败: ${e}`);
            return false;
        }
    }

    watch() {
        if (this.watcher) return;
        this.watcher = chokidar.watch(CONFIG_PATH);
        this.watcher.on('change', () => {
            logger.info('[Config] 检测到配置文件变更，正在重载...');
            this.load();
        });
    }

    /**
     * 注册配置变更回调
     * @param {Function} callback - 接收最新配置对象
     */
    onChange(callback) {
        if (typeof callback === 'function') {
            this._listeners.push(callback);
        }
    }

    /**
     * 获取 Schema 元数据（供前端渲染表单）
     */
    getSchema() {
        return schemaToMeta(ConfigSchema);
    }

    /**
     * 获取最近一次验证的错误信息
     */
    getValidationErrors() {
        return this._lastErrors;
    }

    /**
     * 获取默认配置（从 Zod Schema 生成）
     */
    getDefaults() {
        return getDefaultConfig();
    }

    /** 通知所有监听器 */
    _notifyListeners() {
        for (const fn of this._listeners) {
            try {
                fn(this.config);
            } catch (e) {
                logger.error(`[Config] onChange 回调执行失败: ${e}`);
            }
        }
    }
}

export default new Config();
