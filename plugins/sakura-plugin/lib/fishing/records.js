import db from "../Database.js";
import { getFishData } from "./fishData.js";
import { isCrownEligible, isCrownWeight } from "./rules.js";

// 本群纪录：同一鱼种在群内最重的个体，同重量由先创下者保持；旧数据没有创下时间，视为最早。
// 结算判断破纪录和榜单展示必须用同一个排序，否则同重量时两边认定的保持者会对不上。
export const RECORD_ORDER_SQL = "max_weight DESC, COALESCE(max_weight_at, 0) ASC, user_id ASC";

// 纪录和王冠只统计仍在 fish.json 里、且能出王冠的鱼种（宝藏与噩梦不参与）。
const recordFishById = new Map(
  getFishData().filter(isCrownEligible).map((fish) => [fish.id, fish]),
);

export function getRecordFish(fishId) {
  return recordFishById.get(fishId) || null;
}

export function getGroupRecordHolder(groupId, fishId) {
  const row = db.prepare(`
      SELECT user_id AS userId, max_weight AS weight
      FROM fishing_counts
      WHERE group_id = ? AND fish_id = ? AND max_weight > 0
      ORDER BY ${RECORD_ORDER_SQL}
      LIMIT 1
  `).get(String(groupId), String(fishId));
  return row ? { userId: String(row.userId), weight: Number(row.weight) } : null;
}

// 返回 Map<鱼种 id, { userId, weight }>，每个鱼种只取本群保持者。
export function getGroupRecords(groupId) {
  const rows = db.prepare(`
      SELECT fish_id AS fishId, user_id AS userId, max_weight AS weight
      FROM (
        SELECT fish_id, user_id, max_weight,
               ROW_NUMBER() OVER (PARTITION BY fish_id ORDER BY ${RECORD_ORDER_SQL}) AS rn
        FROM fishing_counts
        WHERE group_id = ? AND max_weight > 0
      )
      WHERE rn = 1
  `).all(String(groupId));
  return new Map(
    rows
      .filter((row) => recordFishById.has(row.fishId))
      .map((row) => [row.fishId, { userId: String(row.userId), weight: Number(row.weight) }]),
  );
}

// 鱼王榜：先比保持的本群纪录数，再比点亮王冠的鱼种数；两项都是 0 的不上榜。
export function getFishKingRanking(groupId, limit = 10) {
  const stats = new Map();
  const statOf = (userId) => {
    if (!stats.has(userId)) stats.set(userId, { userId, records: 0, crowns: 0 });
    return stats.get(userId);
  };
  for (const { userId } of getGroupRecords(groupId).values()) statOf(userId).records += 1;
  const crownRows = db.prepare(`
      SELECT user_id AS userId, fish_id AS fishId
      FROM fishing_counts
      WHERE group_id = ? AND crown_count > 0
  `).all(String(groupId));
  for (const row of crownRows) {
    if (recordFishById.has(row.fishId)) statOf(String(row.userId)).crowns += 1;
  }
  return [...stats.values()]
    .sort((left, right) => (
      right.records - left.records ||
      right.crowns - left.crowns ||
      left.userId.localeCompare(right.userId)
    ))
    .slice(0, Math.max(1, Math.floor(Number(limit) || 10)));
}

// 单个鱼种的本群前几名，排第一的就是纪录保持者。
export function getSpeciesRecordRanking(groupId, fishId, limit = 5) {
  return db.prepare(`
      SELECT user_id AS userId, max_weight AS weight, success_count AS successCount
      FROM fishing_counts
      WHERE group_id = ? AND fish_id = ? AND max_weight > 0
      ORDER BY ${RECORD_ORDER_SQL}
      LIMIT ?
  `).all(String(groupId), String(fishId), Math.max(1, Math.floor(Number(limit) || 5)))
    .map((row) => ({
      userId: String(row.userId),
      weight: Number(row.weight),
      successCount: Number(row.successCount) || 0,
    }));
}

const CROWN_BACKFILL_MIGRATION = "fishing_crown_backfill";

// 王冠上线时的一次性补记：最大重量已过王冠线、却没有王冠次数的行记 1 次。
// 补记和完成标记在同一个事务里，做过就不再做。之后王冠只在钓起时按当时的规则判定，
// 重新校准重量区间也不会让老纪录凭空过线拿到王冠。
// 返回补记条数；已经做过返回 null。鱼类数据没加载成功时不记完成，留到下次启动再补。
export function backfillCrownsOnce() {
  if (recordFishById.size === 0) return null;
  return db.transaction(() => {
    const done = db.prepare("SELECT 1 FROM data_migrations WHERE name = ?").get(CROWN_BACKFILL_MIGRATION);
    if (done) return null;
    const rows = db.prepare(`
        SELECT group_id AS groupId, user_id AS userId, fish_id AS fishId, max_weight AS maxWeight
        FROM fishing_counts
        WHERE COALESCE(crown_count, 0) = 0 AND max_weight > 0
    `).all();
    const update = db.prepare(`
        UPDATE fishing_counts
        SET crown_count = 1
        WHERE group_id = ? AND user_id = ? AND fish_id = ? AND COALESCE(crown_count, 0) = 0
    `);
    let changed = 0;
    for (const row of rows) {
      const fish = recordFishById.get(row.fishId);
      if (fish && isCrownWeight(fish, row.maxWeight)) {
        changed += update.run(row.groupId, row.userId, row.fishId).changes;
      }
    }
    db.prepare("INSERT INTO data_migrations (name, applied_at) VALUES (?, ?)")
      .run(CROWN_BACKFILL_MIGRATION, Date.now());
    return changed;
  }).immediate();
}
