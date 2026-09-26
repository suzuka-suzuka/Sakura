// 启动时删除旧暗伤列；列不存在时无需重复迁移。
export function clearLegacyRodControlLoss(database) {
  const migrate = database.transaction(() => {
    const columns = database.prepare("PRAGMA table_info(rod_stats)").all();
    if (!columns.some((column) => column.name === "control_loss")) return false;
    database.exec("ALTER TABLE rod_stats DROP COLUMN control_loss");
    return true;
  });

  return migrate.immediate();
}
