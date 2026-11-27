import fs from "fs";
import path from "path";

/**
 * 拆成一号一实例之前留下的分账号配置：
 *   config/account/<QQ>.yaml                  主人和黑白名单
 *   config/<插件>/_accounts/<QQ>/<模块>.yaml   插件配置
 * 现在运行时只读 config/config.yaml 和 config/<插件>/<模块>.yaml，这些文件不再生效。
 * scripts/split-instance.mjs 用它们生成各实例的配置；运行时只用来提醒。
 */

export const LEGACY_ACCOUNT_DIR = "account";
export const LEGACY_PLUGIN_ACCOUNTS_DIR = "_accounts";

function isAccountId(name) {
  return /^\d+$/.test(name) && Number(name) > 0;
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function listYaml(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".yaml"));
  } catch {
    return [];
  }
}

/** 找出某个账号的旧配置文件 */
export function findLegacyAccountConfig(configDir, selfId) {
  const id = String(selfId);
  const accountFile = path.join(configDir, LEGACY_ACCOUNT_DIR, `${id}.yaml`);
  const pluginModules = [];

  for (const pluginName of listDirs(configDir)) {
    if (pluginName === LEGACY_ACCOUNT_DIR) continue;
    const accountDir = path.join(configDir, pluginName, LEGACY_PLUGIN_ACCOUNTS_DIR, id);
    for (const file of listYaml(accountDir)) {
      pluginModules.push({
        pluginName,
        moduleName: file.slice(0, -".yaml".length),
        file: path.join(accountDir, file),
      });
    }
  }

  return {
    accountFile: fs.existsSync(accountFile) ? accountFile : null,
    pluginModules,
  };
}

/** 列出留有旧配置的所有账号 */
export function listLegacyAccountIds(configDir) {
  const ids = new Set();
  for (const file of listYaml(path.join(configDir, LEGACY_ACCOUNT_DIR))) {
    const name = file.slice(0, -".yaml".length);
    if (isAccountId(name)) ids.add(name);
  }
  for (const pluginName of listDirs(configDir)) {
    for (const name of listDirs(path.join(configDir, pluginName, LEGACY_PLUGIN_ACCOUNTS_DIR))) {
      if (isAccountId(name)) ids.add(name);
    }
  }
  return [...ids].sort((a, b) => Number(a) - Number(b));
}

const warned = new Set();

/** 账号上线时调用：它还有不再生效的旧配置就提醒一次 */
export function warnLegacyAccountConfig(configDir, selfId, logger) {
  const id = String(selfId);
  if (warned.has(id)) return;
  warned.add(id);

  const found = findLegacyAccountConfig(configDir, id);
  const count = (found.accountFile ? 1 : 0) + found.pluginModules.length;
  if (count === 0) return;

  logger.warn(
    `[配置] 账号 ${id} 还有 ${count} 个旧的分账号配置文件（config/account/${id}.yaml、config/<插件>/_accounts/${id}/），` +
    `现在一个实例只读 config/ 下的那一份，它们已不再生效。` +
    `确认后运行 node scripts/split-instance.mjs merge --self ${id} 并入当前配置（会先备份）`
  );
}
