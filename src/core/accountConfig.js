import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { AccountConfigSchema, getDefaultAccountConfig, schemaToMeta } from './configSchema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNT_CONFIG_DIR = path.join(__dirname, '../../config/account');
const DEFAULT_CONFIG_CACHE_KEY = '__default__';
const DEFAULT_CONFIG_FILE = path.join(ACCOUNT_CONFIG_DIR, 'default.yaml');

function getConfigPath(selfId) {
    if (selfId == null) {
        return DEFAULT_CONFIG_FILE;
    }
    return path.join(ACCOUNT_CONFIG_DIR, `${selfId}.yaml`);
}

function ensureDir() {
    if (!fs.existsSync(ACCOUNT_CONFIG_DIR)) {
        fs.mkdirSync(ACCOUNT_CONFIG_DIR, { recursive: true });
    }
}

function normalizeSelfId(value) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : null;
}

class AccountConfigManager {
    constructor() {
        this._configCache = new Map();
    }

    getConfig(selfId) {
        const normalizedSelfId = normalizeSelfId(selfId);
        const cacheKey = normalizedSelfId ?? DEFAULT_CONFIG_CACHE_KEY;

        if (this._configCache.has(cacheKey)) {
            return structuredClone(this._configCache.get(cacheKey));
        }

        const filePath = getConfigPath(normalizedSelfId);
        if (!fs.existsSync(filePath)) {
            if (normalizedSelfId != null) {
                return this.getConfig(null);
            }

            const defaults = getDefaultAccountConfig();
            this._configCache.set(cacheKey, defaults);
            return structuredClone(defaults);
        }

        try {
            const raw = yaml.load(fs.readFileSync(filePath, 'utf8')) || {};
            const result = AccountConfigSchema.safeParse(raw);
            const nextConfig = result.success
                ? result.data
                : { ...getDefaultAccountConfig(), ...(raw && typeof raw === 'object' ? raw : {}) };

            this._configCache.set(cacheKey, nextConfig);
            return structuredClone(nextConfig);
        } catch (error) {
            logger.error(`[账号配置] 加载${normalizedSelfId == null ? '默认' : `账号 ${normalizedSelfId}`}配置失败：${error}`);
            if (normalizedSelfId != null) {
                return this.getConfig(null);
            }

            const defaults = getDefaultAccountConfig();
            this._configCache.set(cacheKey, defaults);
            return structuredClone(defaults);
        }
    }

    setConfig(selfId, data) {
        const normalizedSelfId = normalizeSelfId(selfId);
        const cacheKey = normalizedSelfId ?? DEFAULT_CONFIG_CACHE_KEY;

        const result = AccountConfigSchema.safeParse(data);
        if (!result.success) {
            return { success: false, errors: result.error.issues };
        }

        try {
            ensureDir();
            const content = yaml.dump(result.data, {
                indent: 2,
                lineWidth: -1,
                noRefs: true,
                quotingType: "'",
            });
            fs.writeFileSync(getConfigPath(normalizedSelfId), content, 'utf8');
            this._configCache.set(cacheKey, result.data);
            logger.info(`[账号配置] 已保存${normalizedSelfId == null ? '默认' : `账号 ${normalizedSelfId}`}配置`);
            return { success: true };
        } catch (error) {
            logger.error(`[账号配置] 保存${normalizedSelfId == null ? '默认' : `账号 ${normalizedSelfId}`}配置失败：${error}`);
            return { success: false, errors: [{ message: '保存文件失败' }] };
        }
    }

    getSchema() {
        return schemaToMeta(AccountConfigSchema);
    }

    listConfiguredSelfIds() {
        if (!fs.existsSync(ACCOUNT_CONFIG_DIR)) return [];
        return fs.readdirSync(ACCOUNT_CONFIG_DIR)
            .filter((file) => file.endsWith('.yaml'))
            .map((file) => normalizeSelfId(file.replace('.yaml', '')))
            .filter((selfId) => selfId != null);
    }
}

export default new AccountConfigManager();
