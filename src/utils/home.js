import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

/**
 * 实例目录（SAKURA_HOME）。
 *
 * 一个进程只服务一个 QQ 号；要跑多个号就开多个实例，共用同一份代码，各自一个 home：
 *   <home>/config/                配置（config.yaml、插件配置）
 *   <home>/data/                  框架运行数据（软关机状态、面板会话、自动启动的 Redis 工作目录）
 *   <home>/logs/                  日志
 *   <home>/temp/                  临时文件
 *   <home>/plugins/<插件>/data/   插件数据（SQLite、图片、缓存……）
 *
 * 不设 SAKURA_HOME 时 home 就是项目根目录，目录结构和拆实例之前完全一样。
 * 相对路径按项目根目录解析，不受启动时 cwd 影响。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, "../..");

const rawHome = String(process.env.SAKURA_HOME || "").trim();

export const SAKURA_HOME = rawHome ? path.resolve(PROJECT_ROOT, rawHome) : PROJECT_ROOT;
export const IS_DEFAULT_HOME = path.relative(PROJECT_ROOT, SAKURA_HOME) === "";

export const CONFIG_DIR = path.join(SAKURA_HOME, "config");
export const DATA_DIR = path.join(SAKURA_HOME, "data");
export const LOG_DIR = path.join(SAKURA_HOME, "logs");
export const TEMP_DIR = path.join(SAKURA_HOME, "temp");

/** 实例的短标识：默认 home 为空串，其余取 home 路径的哈希，用来给共享目录里的东西分开命名 */
export const INSTANCE_KEY = IS_DEFAULT_HOME
  ? ""
  : crypto.createHash("sha1").update(SAKURA_HOME).digest("hex").slice(0, 8);

export function getPluginDataDir(pluginName) {
  return path.join(SAKURA_HOME, "plugins", pluginName, "data");
}
