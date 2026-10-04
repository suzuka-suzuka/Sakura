// 默认预览；加 --apply 执行一次性重置，可用 --db 指定部署环境的数据库。
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RESET_ID = "abyss-hunter-probability-immunity-v1";
const RESET_TABLE = "fishing_profession_resets";
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function resetAbyssHunterProfessions(database, { dryRun = true, now = Date.now() } = {}) {
  const reset = () => {
    const hasResetTable = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(RESET_TABLE);
    if (hasResetTable && database.prepare(
      `SELECT 1 FROM ${RESET_TABLE} WHERE reset_id = ?`,
    ).get(RESET_ID)) {
      return { dryRun, skipped: true, affected: 0 };
    }

    const columns = new Set(database.prepare("PRAGMA table_info(fishing_stats)").all().map(column => column.name));
    for (const column of ["group_id", "user_id", "profession", "profession_level"]) {
      if (!columns.has(column)) throw new Error(`钓鱼数据缺少 ${column} 字段，无法重置职业`);
    }
    const legacyColumns = ["nightmare_immunity_charges", "nightmare_immunity_updated_at"]
      .filter(column => columns.has(column));
    const selectedColumns = ["group_id", "user_id", "profession", "profession_level", ...legacyColumns];
    const previous = database.prepare(`
      SELECT ${selectedColumns.join(", ")} FROM fishing_stats
      WHERE profession = 'abyss_hunter' ORDER BY group_id, user_id
    `).all();
    if (dryRun) return { dryRun: true, skipped: false, affected: previous.length };

    // 原职业记录与执行标记和重置一起提交，失败会整体回滚；重复执行不会影响新选择。
    database.exec(`
      CREATE TABLE IF NOT EXISTS ${RESET_TABLE} (
        reset_id TEXT PRIMARY KEY,
        executed_at INTEGER NOT NULL,
        affected_count INTEGER NOT NULL,
        previous_professions TEXT NOT NULL
      )
    `);
    const assignments = ["profession = NULL", "profession_level = 0", ...legacyColumns.map(column => `${column} = 0`)];
    const result = database.prepare(`
      UPDATE fishing_stats SET ${assignments.join(", ")}
      WHERE profession = 'abyss_hunter'
    `).run();
    database.prepare(`
      INSERT INTO ${RESET_TABLE} (reset_id, executed_at, affected_count, previous_professions)
      VALUES (?, ?, ?, ?)
    `).run(RESET_ID, now, result.changes, JSON.stringify(previous));
    return { dryRun: false, skipped: false, affected: result.changes };
  };

  return dryRun ? reset() : database.transaction(reset).immediate();
}

function main(args) {
  if (args.includes("--help")) {
    console.log("用法：node plugins/sakura-plugin/scripts/reset-abyss-hunter-professions.mjs [--dry-run | --apply] [--db 数据库路径]");
    console.log("默认只预览。--apply 会取消所有已有深渊猎手职业，并记录一次性执行标记与原职业备份。");
    return;
  }
  let dryRun = true;
  let dbPath = path.join(pluginRoot, "data", "sakura.sqlite");
  if (args.includes("--apply") && args.includes("--dry-run")) throw new Error("--apply 与 --dry-run 不能同时使用");
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--apply") dryRun = false;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--db") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("--db 后必须提供数据库路径");
      dbPath = path.resolve(value);
    } else throw new Error(`未知参数：${arg}`);
  }

  const database = new Database(dbPath, { readonly: dryRun, fileMustExist: true });
  try {
    const result = resetAbyssHunterProfessions(database, { dryRun });
    console.log(`数据库：${dbPath}`);
    if (result.skipped) console.log("此次职业重置已经执行过，已跳过；后续重新选择的职业不会再次被取消。");
    else if (result.dryRun) console.log(`预览：将取消 ${result.affected} 条群内深渊猎手职业记录。加 --apply 执行。`);
    else console.log(`已取消 ${result.affected} 条群内深渊猎手职业记录，玩家可使用 #选择职业 重新选择。`);
  } finally {
    database.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`职业重置失败：${error.message}`);
    process.exitCode = 1;
  }
}
