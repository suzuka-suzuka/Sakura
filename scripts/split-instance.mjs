#!/usr/bin/env node
/**
 * 把"一个进程跑多个号"的旧部署拆成一号一实例。用法见 docs/multi-instance.md。
 *
 *   node scripts/split-instance.mjs list
 *       列出留有旧分账号配置的账号和 instances.json 里的实例
 *
 *   node scripts/split-instance.mjs merge --self <QQ> [--home <目录>] [--reset-cleanup-accounts] [--dry-run]
 *       当前实例继续服务 <QQ>：把它的旧分账号配置并进 config.yaml 和插件配置
 *
 *   node scripts/split-instance.mjs create --self <QQ> --name <实例名> [--home <目录>] [--from <源目录>] [--copy-data] [--dry-run]
 *       给 <QQ> 新建一个实例目录：复制源实例的配置、套上 <QQ> 的旧分账号配置，登记到 instances.json
 *
 * 覆盖或移走的文件都先备份到 <home>/data/split-backup-<时间>/。
 * --home / --from 默认取 SAKURA_HOME，没设就是项目根目录；相对路径按项目根目录算。
 */
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import yaml from "js-yaml";
import { PROJECT_ROOT } from "../src/utils/home.js";
import { PERMISSION_CONFIG_KEYS } from "../src/core/configSchema.js";
import {
  LEGACY_ACCOUNT_DIR,
  LEGACY_PLUGIN_ACCOUNTS_DIR,
  findLegacyAccountConfig,
  listLegacyAccountIds,
} from "../src/core/legacyAccountConfig.js";

const INSTANCES_FILE = path.join(PROJECT_ROOT, "instances.json");
const DEFAULT_INSTANCE_NAME = "sakura-bot";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");

// ---------------- 参数 ----------------

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) fail(`看不懂的参数：${arg}`);
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      i += 1;
    }
  }
  return { command, options };
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function resolveHome(value) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : (process.env.SAKURA_HOME || ".");
  return path.resolve(PROJECT_ROOT, raw);
}

function requireSelfId(options) {
  const id = String(options.self ?? "").trim();
  if (!/^\d+$/.test(id) || Number(id) <= 0) fail("需要 --self <QQ号>");
  return id;
}

function relativeToRoot(dir) {
  const rel = path.relative(PROJECT_ROOT, dir);
  return rel === "" ? "." : rel.split(path.sep).join("/");
}

// ---------------- 文件操作 ----------------

function readYaml(file) {
  if (!fs.existsSync(file)) return null;
  return yaml.load(fs.readFileSync(file, "utf8")) || {};
}

function yamlText(data) {
  return yaml.dump(data, { indent: 2, lineWidth: -1, noRefs: true, quotingType: "'" });
}

class Changes {
  /** keepBackup=false 用于新实例：里面的文件都是刚复制过来的，不用再备份一遍 */
  constructor(home, dryRun, { keepBackup = true } = {}) {
    this.home = home;
    this.dryRun = dryRun;
    this.keepBackup = keepBackup;
    this.backupDir = path.join(home, "data", `split-backup-${STAMP}`);
    this.lines = [];
  }

  note(text) {
    this.lines.push(text);
    console.log(`${this.dryRun ? "[预演] " : ""}${text}`);
  }

  backup(file) {
    if (this.dryRun || !this.keepBackup || !fs.existsSync(file)) return;
    const target = path.join(this.backupDir, path.relative(this.home, file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(file, target, { recursive: true });
  }

  write(file, content) {
    this.note(`写入 ${path.relative(this.home, file)}`);
    if (this.dryRun) return;
    this.backup(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }

  /** 移走旧文件：先备份再删 */
  retire(file) {
    if (!fs.existsSync(file)) return;
    this.note(`移走 ${path.relative(this.home, file)}（已备份）`);
    if (this.dryRun) return;
    this.backup(file);
    fs.rmSync(file, { recursive: true, force: true });
  }

  removeIfEmpty(dir) {
    if (this.dryRun || !fs.existsSync(dir)) return;
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  }
}

// ---------------- 旧分账号配置 ----------------

/**
 * 某个号在旧版里实际生效的配置：有自己的文件用自己的，没有就是默认那份（目标目录里已经有了）。
 * 把它写进 targetConfigDir 的 config.yaml 和插件模块文件。
 */
function applyAccountConfig(sourceConfigDir, targetConfigDir, selfId, changes) {
  const found = findLegacyAccountConfig(sourceConfigDir, selfId);
  const legacyDefault = path.join(sourceConfigDir, LEGACY_ACCOUNT_DIR, "default.yaml");
  const permissionFile = found.accountFile || (fs.existsSync(legacyDefault) ? legacyDefault : null);

  if (permissionFile) {
    const legacy = readYaml(permissionFile) || {};
    const configPath = path.join(targetConfigDir, "config.yaml");
    const config = readYaml(configPath) || {};
    let touched = false;
    for (const key of PERMISSION_CONFIG_KEYS) {
      if (Array.isArray(legacy[key])) {
        config[key] = legacy[key];
        touched = true;
      }
    }
    if (touched) {
      changes.note(`主人和黑白名单取自 ${path.relative(sourceConfigDir, permissionFile)}`);
      changes.write(configPath, yamlText(config));
    }
  }

  for (const { pluginName, moduleName, file } of found.pluginModules) {
    const target = path.join(targetConfigDir, pluginName, `${moduleName}.yaml`);
    changes.note(`插件配置 ${pluginName}/${moduleName} 取自账号 ${selfId} 的那份`);
    changes.write(target, fs.readFileSync(file, "utf8"));
  }

  return found;
}

/** 这个号的旧配置已经用掉了，从源目录移走；没有别的号剩下时连 default.yaml 和空目录一起清掉 */
function retireAccountConfig(sourceConfigDir, selfId, found, changes) {
  if (found.accountFile) changes.retire(found.accountFile);
  for (const pluginName of new Set(found.pluginModules.map((item) => item.pluginName))) {
    changes.retire(path.join(sourceConfigDir, pluginName, LEGACY_PLUGIN_ACCOUNTS_DIR, selfId));
  }

  const remaining = listLegacyAccountIds(sourceConfigDir).filter((id) => id !== selfId);
  if (remaining.length > 0) {
    changes.note(`还剩账号 ${remaining.join("、")} 的旧配置，给它们各自 create 或 merge 之后会一起清掉`);
    return;
  }
  changes.retire(path.join(sourceConfigDir, LEGACY_ACCOUNT_DIR, "default.yaml"));
  changes.removeIfEmpty(path.join(sourceConfigDir, LEGACY_ACCOUNT_DIR));
  for (const entry of safeReaddir(sourceConfigDir)) {
    changes.removeIfEmpty(path.join(sourceConfigDir, entry, LEGACY_PLUGIN_ACCOUNTS_DIR));
  }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------------- 实例列表 ----------------

function readInstances() {
  if (!fs.existsSync(INSTANCES_FILE)) return null;
  const list = JSON.parse(fs.readFileSync(INSTANCES_FILE, "utf8"));
  if (!Array.isArray(list)) fail("instances.json 必须是数组");
  return list;
}

function instanceHome(item) {
  return path.resolve(PROJECT_ROOT, String(item?.home || "").trim() || ".");
}

/** 所有已知实例的 home（含项目根目录那个），用来避开端口和 Redis db 冲突 */
function knownHomes(extra = []) {
  const list = readInstances() || [{ name: DEFAULT_INSTANCE_NAME }];
  return [...new Set([...list.map(instanceHome), ...extra])];
}

// ---------------- 数据 ----------------

function loadSqlite() {
  const pluginPackage = path.join(PROJECT_ROOT, "plugins", "sakura-plugin", "package.json");
  return createRequire(pluginPackage)("better-sqlite3");
}

async function copyPluginData(fromHome, toHome, selfId, changes) {
  const fromPlugins = path.join(fromHome, "plugins");
  const Database = loadSqlite();

  for (const pluginName of safeReaddir(fromPlugins)) {
    const source = path.join(fromPlugins, pluginName, "data");
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) continue;
    const target = path.join(toHome, "plugins", pluginName, "data");
    changes.note(`复制插件数据 ${pluginName}/data`);
    if (changes.dryRun) continue;

    const sqliteFiles = [];
    fs.cpSync(source, target, {
      recursive: true,
      filter: (src) => {
        if (/\.sqlite(-wal|-shm)?$/.test(src)) {
          if (src.endsWith(".sqlite")) sqliteFiles.push(src);
          return false;
        }
        return true;
      },
    });

    // SQLite 用在线备份复制，源实例开着也能拿到一致的快照
    for (const file of sqliteFiles) {
      const dest = path.join(target, path.relative(source, file));
      const db = new Database(file, { readonly: true, fileMustExist: true });
      try {
        await db.backup(dest);
      } finally {
        db.close();
      }
      fixCopiedDatabase(Database, dest, source, target, selfId, changes);
    }
  }
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/**
 * 复制出来的库只属于新实例：
 * - 数据清理记录的账号只留新号，别的号的群会在下一轮核对时从这份副本里清掉（源实例的库不受影响）
 * - 表情图的绝对路径指向源目录，改成新目录，免得删图时删到源实例的文件
 */
function fixCopiedDatabase(Database, dbFile, sourceDataDir, targetDataDir, selfId, changes) {
  const db = new Database(dbFile);
  try {
    if (hasTable(db, "data_cleanup_accounts")) {
      db.prepare("DELETE FROM data_cleanup_accounts").run();
      db.prepare("INSERT INTO data_cleanup_accounts (self_id) VALUES (?)").run(selfId);
      changes.note(`  ${path.basename(dbFile)}：数据清理只认账号 ${selfId}`);
    }
    if (hasTable(db, "image_metadata")) {
      const result = db.prepare(
        "UPDATE image_metadata SET file_path = ? || substr(file_path, ?) WHERE substr(file_path, 1, ?) = ?"
      ).run(targetDataDir, sourceDataDir.length + 1, sourceDataDir.length, sourceDataDir);
      if (result.changes > 0) changes.note(`  ${path.basename(dbFile)}：改写 ${result.changes} 条图片路径`);
    }
  } finally {
    db.close();
  }
}

function resetCleanupAccounts(home, selfId, changes) {
  const Database = loadSqlite();
  for (const pluginName of safeReaddir(path.join(home, "plugins"))) {
    const dataDir = path.join(home, "plugins", pluginName, "data");
    for (const file of safeReaddir(dataDir).filter((name) => name.endsWith(".sqlite"))) {
      const dbFile = path.join(dataDir, file);
      const db = new Database(dbFile);
      try {
        if (!hasTable(db, "data_cleanup_accounts")) continue;
        const others = db.prepare("SELECT self_id FROM data_cleanup_accounts WHERE self_id != ?").all(selfId);
        if (others.length === 0) continue;
        changes.note(`${pluginName}/data/${file}：数据清理不再等账号 ${others.map((row) => row.self_id).join("、")}`);
        if (!changes.dryRun) {
          db.prepare("DELETE FROM data_cleanup_accounts WHERE self_id != ?").run(selfId);
        }
      } finally {
        db.close();
      }
    }
  }
}

// ---------------- 命令 ----------------

function commandList() {
  const home = resolveHome(null);
  const ids = listLegacyAccountIds(path.join(home, "config"));
  console.log(`实例目录：${home}`);
  console.log(ids.length > 0
    ? `留有旧分账号配置的账号：${ids.join("、")}`
    : "没有旧分账号配置");
  const instances = readInstances();
  if (!instances) {
    console.log(`没有 instances.json：只有一个实例 ${DEFAULT_INSTANCE_NAME}，目录是项目根目录`);
    return;
  }
  console.log("instances.json：");
  for (const item of instances) {
    console.log(`  ${item.name}  →  ${relativeToRoot(instanceHome(item))}`);
  }
}

function commandMerge(options) {
  const selfId = requireSelfId(options);
  const home = resolveHome(options.home);
  const configDir = path.join(home, "config");
  if (!fs.existsSync(path.join(configDir, "config.yaml"))) fail(`${configDir} 下没有 config.yaml`);

  const changes = new Changes(home, options["dry-run"] === true);
  console.log(`把账号 ${selfId} 的旧分账号配置并进 ${home}`);
  const found = applyAccountConfig(configDir, configDir, selfId, changes);
  retireAccountConfig(configDir, selfId, found, changes);
  if (options["reset-cleanup-accounts"] === true) {
    resetCleanupAccounts(home, selfId, changes);
  }

  finish(changes);
}

async function commandCreate(options) {
  const selfId = requireSelfId(options);
  const name = String(options.name ?? "").trim();
  if (!/^[\w.-]+$/.test(name)) fail("需要 --name <实例名>（字母、数字、- _ .）");

  const fromHome = resolveHome(options.from);
  const toHome = path.resolve(PROJECT_ROOT, typeof options.home === "string" ? options.home : path.join("instances", name));
  if (fromHome === toHome) fail("新实例目录不能和源目录相同");
  if (fs.existsSync(toHome) && safeReaddir(toHome).length > 0) fail(`${toHome} 已存在且不为空`);

  const instances = readInstances();
  if (instances?.some((item) => item.name === name)) fail(`instances.json 里已经有实例 ${name}`);
  if (instances?.some((item) => instanceHome(item) === toHome)) fail(`instances.json 里已经有实例用 ${toHome}`);

  const fromConfig = path.join(fromHome, "config");
  const toConfig = path.join(toHome, "config");
  if (!fs.existsSync(path.join(fromConfig, "config.yaml"))) fail(`${fromConfig} 下没有 config.yaml`);

  const dryRun = options["dry-run"] === true;
  const changes = new Changes(toHome, dryRun, { keepBackup: false });
  const sourceChanges = new Changes(fromHome, dryRun);
  console.log(`新建实例 ${name}（账号 ${selfId}）：${toHome}`);

  // 1. 复制源实例的配置，不带旧的分账号目录
  changes.note(`复制配置 ${fromConfig}`);
  if (!dryRun) {
    fs.cpSync(fromConfig, toConfig, {
      recursive: true,
      filter: (src) => {
        const rel = path.relative(fromConfig, src).split(path.sep);
        if (rel[0] === LEGACY_ACCOUNT_DIR) return false;
        return !rel.includes(LEGACY_PLUGIN_ACCOUNTS_DIR);
      },
    });
  }

  // 2. 套上这个号自己的旧配置（预演时目标还不存在，直接读源目录）
  const found = applyAccountConfig(fromConfig, dryRun ? fromConfig : toConfig, selfId, dryRun ? new Changes(fromHome, true) : changes);

  // 3. 避开和其他实例冲突的端口和 Redis db
  const checklist = [];
  if (!dryRun) {
    const configPath = path.join(toConfig, "config.yaml");
    const config = readYaml(configPath) || {};
    const others = knownHomes([fromHome]).map((dir) => readYaml(path.join(dir, "config", "config.yaml")) || {});
    const usedPorts = new Set(others.map((item) => Number(item?.web?.port || 1135)));
    const usedDbs = new Set(others.map((item) => Number(item?.redis?.db || 0)));

    config.web ||= {};
    let port = Number(config.web.port || 1135);
    while (usedPorts.has(port)) port += 1;
    config.web.port = port;

    config.redis ||= {};
    let db = 0;
    while (usedDbs.has(db) && db < 15) db += 1;
    if (usedDbs.has(db)) checklist.push("Redis 的 16 个 db 都被占了，新实例需要单独的 Redis 或手动指定 redis.db");
    config.redis.db = db;

    changes.note(`配置面板端口 → ${port}，Redis db → ${db}`);
    changes.write(configPath, yamlText(config));

    const connections = [
      ...(config.ws?.forward || []).filter((item) => item?.enable !== false).map((item) => `正向 ${item.name || ""} ${item.url || ""}`),
      ...(config.ws?.reverse || []).filter((item) => item?.enable).map((item) => `反向 ${item.name || ""} 端口 ${item.port}`),
      ...(config.ws?.milky || []).filter((item) => item?.enable).map((item) => `Milky ${item.name || ""} ${item.url || ""}`),
    ];
    checklist.push(
      `连接：新实例复制了源实例开着的全部连接（${connections.join("；") || "无"}），` +
      `只保留连账号 ${selfId} 的那条，源实例里删掉它；反向连接的端口两边不能相同`
    );

    const privateChat = readYaml(path.join(toConfig, "sakura-plugin", "PrivateChat.yaml"));
    if (privateChat?.enable) {
      checklist.push(`私聊 AI 设置页面端口 PrivateChat.webPort=${privateChat.webPort ?? 1136} 和源实例相同，要改成别的端口，publicUrl 也要对应`);
    }
  }

  // 4. 数据
  if (options["copy-data"] === true) {
    changes.note("复制数据（建议先停掉源实例，SQLite 走在线备份，其余文件直接复制）");
    const powerState = path.join(fromHome, "data", "power-state.json");
    if (fs.existsSync(powerState) && !dryRun) {
      fs.mkdirSync(path.join(toHome, "data"), { recursive: true });
      fs.copyFileSync(powerState, path.join(toHome, "data", "power-state.json"));
    }
    await copyPluginData(fromHome, toHome, selfId, changes);
  } else {
    checklist.push("没有加 --copy-data：新实例从空数据开始（经济、钓鱼、记忆等都是新的）");
  }

  // 5. 源实例里这个号的旧配置用完了，移走
  retireAccountConfig(fromConfig, selfId, found, sourceChanges);

  // 6. 登记实例
  const nextInstances = instances ? [...instances] : [{ name: DEFAULT_INSTANCE_NAME }];
  nextInstances.push({ name, home: relativeToRoot(toHome) });
  changes.note(`登记到 instances.json：${name} → ${relativeToRoot(toHome)}`);
  if (!dryRun) {
    fs.writeFileSync(INSTANCES_FILE, `${JSON.stringify(nextInstances, null, 2)}\n`, "utf8");
  }

  if (checklist.length > 0) {
    console.log("\n启动前请确认：");
    for (const item of checklist) console.log(`  • ${item}`);
  }
  console.log(`\n启动：pm2 start ecosystem.config.cjs --only ${name}`);
  finish(sourceChanges);
}

function finish(changes) {
  if (changes.dryRun) {
    console.log("\n预演结束，没有改动任何文件。去掉 --dry-run 再执行。");
  } else if (fs.existsSync(changes.backupDir)) {
    console.log(`\n被覆盖或移走的文件备份在 ${changes.backupDir}`);
  }
}

const { command, options } = parseArgs(process.argv.slice(2));
switch (command) {
  case "list":
    commandList();
    break;
  case "merge":
    commandMerge(options);
    break;
  case "create":
    await commandCreate(options);
    break;
  default:
    console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n\/\*\*?/, "").replace(/^ \* ?/gm, ""));
    process.exit(command ? 1 : 0);
}
