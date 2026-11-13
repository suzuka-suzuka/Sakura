// 只启动配置面板后端，不连接 QQ 客户端、不加载插件逻辑，用于本地预览面板。
// 用法：node scripts/panel-preview.mjs
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { logger } from '../src/utils/logger.js';

global.logger = logger;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { default: pluginConfigManager } = await import('../src/core/pluginConfig.js');

const pluginName = 'sakura-plugin';
const schemaMod = await import(pathToFileURL(path.join(root, 'plugins', pluginName, 'configSchema.js')).href);
pluginConfigManager.register(
    pluginName,
    schemaMod.configSchema,
    schemaMod.schemaNavigation || schemaMod.schemaCategories || null,
    schemaMod.pluginMeta || null,
    schemaMod.dynamicOptionsConfig || null,
    { migrate: schemaMod.migrateConfig },
);

// 预览时可用 PANEL_PREVIEW_PASSWORD 临时覆盖登录密码（只改内存，不写回 config.yaml）
const { default: Config } = await import('../src/core/config.js');
const previewPassword = process.env.PANEL_PREVIEW_PASSWORD || process.argv[2];
if (previewPassword) {
    Config.config.web = { ...(Config.config.web || {}), password: previewPassword };
}

const { startConfigServer } = await import('../src/web/configServer.js');
startConfigServer();
logger.info('[面板预览] 配置面板已启动（未连接任何 QQ 账号）');
