import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { AccountConfigSchema, getDefaultAccountConfig, schemaToMeta } from './configSchema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNT_CONFIG_DIR = path.join(__dirname, '../../config/account');

function getConfigPath(selfId) {
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
        if (normalizedSelfId == null) {
            return getDefaultAccountConfig();
        }

        if (this._configCache.has(normalizedSelfId)) {
            return structuredClone(this._configCache.get(normalizedSelfId));
        }

        const filePath = getConfigPath(normalizedSelfId);
        if (!fs.existsSync(filePath)) {
            const defaults = getDefaultAccountConfig();
            this._configCache.set(normalizedSelfId, defaults);
            return structuredClone(defaults);
        }

        try {
            const raw = yaml.load(fs.readFileSync(filePath, 'utf8')) || {};
            const result = AccountConfigSchema.safeParse(raw);
            const nextConfig = result.success
                ? result.data
                : { ...getDefaultAccountConfig(), ...(raw && typeof raw === 'object' ? raw : {}) };

            this._configCache.set(normalizedSelfId, nextConfig);
            return structuredClone(nextConfig);
        } catch (error) {
            logger.error(`[账号配置] 加载账号 ${normalizedSelfId} 的配置失败：${error}`);
            const defaults = getDefaultAccountConfig();
            this._configCache.set(normalizedSelfId, defaults);
            return structuredClone(defaults);
        }
    }

    setConfig(selfId, data) {
        const normalizedSelfId = normalizeSelfId(selfId);
        if (normalizedSelfId == null) {
            return { success: false, errors: [{ message: '无效的 selfId' }] };
        }

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
            this._configCache.set(normalizedSelfId, result.data);
            logger.info(`[账号配置] 已保存账号 ${normalizedSelfId} 的配置`);
            return { success: true };
        } catch (error) {
            logger.error(`[账号配置] 保存账号 ${normalizedSelfId} 的配置失败：${error}`);
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
