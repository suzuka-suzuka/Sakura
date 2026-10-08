// 数据库初始化时执行一次；重置与持久化标记在同一事务内提交。
export const FISHING_LOCATION_RESET_ID = "fishing-location-dex-unlocks-v1";

export function resetFishingLocationsOnce(database, { now = Date.now() } = {}) {
  const reset = database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS fishing_location_resets (
        reset_id TEXT PRIMARY KEY,
        executed_at INTEGER NOT NULL,
        affected_count INTEGER NOT NULL
      )
    `);
    if (database.prepare(
      "SELECT 1 FROM fishing_location_resets WHERE reset_id = ?",
    ).get(FISHING_LOCATION_RESET_ID)) {
      return { skipped: true, affected: 0 };
    }
    const result = database.prepare("UPDATE fishing_stats SET location = 'pond'").run();
    database.prepare(`
      INSERT INTO fishing_location_resets (reset_id, executed_at, affected_count)
      VALUES (?, ?, ?)
    `).run(FISHING_LOCATION_RESET_ID, now, result.changes);
    return { skipped: false, affected: result.changes };
  });
  return reset.immediate();
}
