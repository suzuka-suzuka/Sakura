import db from "../Database.js";
import { getFishingLevelByExp } from "./rules.js";

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export default class FishingSettlementService {
  static cleanupAttempts(retentionDays = 2) {
    const days = Math.max(1, Number(retentionDays) || 2);
    const result = db.prepare(`
        DELETE FROM fishing_attempts
        WHERE created_at < ?
    `).run(Date.now() - days * 24 * 60 * 60 * 1000);
    return result.changes || 0;
  }

  constructor(e) {
    this.groupId = String(e.group_id);
    this.userId = String(e.user_id);
  }

  _ensureRows() {
    db.prepare(`
        INSERT OR IGNORE INTO economy (group_id, user_id, coins, experience, level, bag_level)
        VALUES (?, ?, 0, 0, 1, 1)
    `).run(this.groupId, this.userId);
    db.prepare(`
        INSERT OR IGNORE INTO fishing_stats
        (group_id, user_id, total_catch, total_earnings, torpedo_hits, profession, profession_level)
        VALUES (?, ?, 0, 0, 0, NULL, 0)
    `).run(this.groupId, this.userId);
  }

  _claimSession({ sessionId, fishId, success, earnings }) {
    const result = db.prepare(`
        INSERT OR IGNORE INTO fishing_attempts
        (session_id, group_id, user_id, fish_id, success, earnings, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(sessionId),
      this.groupId,
      this.userId,
      fishId || null,
      success ? 1 : 0,
      earnings,
      Date.now(),
    );
    return result.changes === 1;
  }

  _recordCatch({ fishId, success, earnings, rodId, masteryGain, recordCatch }) {
    if (recordCatch) {
      db.prepare(`
          UPDATE fishing_stats
          SET total_catch = total_catch + 1,
              total_earnings = total_earnings + ?
          WHERE group_id = ? AND user_id = ?
      `).run(earnings, this.groupId, this.userId);

      if (fishId) {
        const successIncrement = success ? 1 : 0;
        db.prepare(`
            INSERT INTO fishing_counts (group_id, user_id, fish_id, count, success_count)
            VALUES (?, ?, ?, 1, ?)
            ON CONFLICT(group_id, user_id, fish_id)
            DO UPDATE SET count = count + 1, success_count = success_count + ?
        `).run(this.groupId, this.userId, fishId, successIncrement, successIncrement);
      }
    }

    if (rodId && masteryGain > 0) {
      db.prepare(`
          INSERT INTO rod_stats (group_id, user_id, rod_id, damage, mastery)
          VALUES (?, ?, ?, 0, ?)
          ON CONFLICT(group_id, user_id, rod_id)
          DO UPDATE SET mastery = mastery + ?
      `).run(this.groupId, this.userId, rodId, masteryGain, masteryGain);
    }
  }

  // 发放钓鱼经验并检测升级，仅在成功渔获时由结算方法调用
  _grantExp(expGain) {
    if (!(expGain > 0)) return null;
    const before = db.prepare(`
        SELECT fishing_exp FROM fishing_stats WHERE group_id = ? AND user_id = ?
    `).get(this.groupId, this.userId)?.fishing_exp || 0;
    const after = before + expGain;
    db.prepare(`
        UPDATE fishing_stats
        SET fishing_exp = ?
        WHERE group_id = ? AND user_id = ?
    `).run(after, this.groupId, this.userId);
    const fromLevel = getFishingLevelByExp(before);
    const toLevel = getFishingLevelByExp(after);
    return toLevel > fromLevel ? { from: fromLevel, to: toLevel } : null;
  }

  settleAttempt({
    sessionId,
    fishId,
    success = false,
    earnings = 0,
    rodId = null,
    masteryGain = 0,
    recordCatch = success,
    expGain = 0,
  }) {
    const safeEarnings = normalizeNonNegativeInteger(earnings);
    const safeMastery = normalizeNonNegativeInteger(masteryGain);
    const safeExpGain = normalizeNonNegativeInteger(expGain);
    if (!sessionId || safeEarnings == null || safeMastery == null || safeExpGain == null) {
      return { success: false, reason: "invalid" };
    }

    return db.transaction(() => {
      this._ensureRows();
      if (!this._claimSession({ sessionId, fishId, success, earnings: safeEarnings })) {
        return { success: false, reason: "duplicate" };
      }
      this._recordCatch({
        fishId,
        success,
        earnings: safeEarnings,
        rodId,
        masteryGain: safeMastery,
        recordCatch: Boolean(recordCatch),
      });
      const levelUp = this._grantExp(safeExpGain);
      return { success: true, levelUp };
    })();
  }

  settleCoinCatch({ sessionId, fishId, earnings, rodId, note, expGain = 0 }) {
    const safeEarnings = normalizeNonNegativeInteger(earnings);
    const safeExpGain = normalizeNonNegativeInteger(expGain);
    if (!sessionId || safeEarnings == null || safeExpGain == null) {
      return { success: false, reason: "invalid" };
    }

    return db.transaction(() => {
      this._ensureRows();
      if (!this._claimSession({ sessionId, fishId, success: true, earnings: safeEarnings })) {
        return { success: false, reason: "duplicate" };
      }

      if (safeEarnings > 0) {
        db.prepare(`
            UPDATE economy
            SET coins = coins + ?
            WHERE group_id = ? AND user_id = ?
        `).run(safeEarnings, this.groupId, this.userId);
        const balance = db.prepare(`
            SELECT coins FROM economy WHERE group_id = ? AND user_id = ?
        `).get(this.groupId, this.userId).coins;
        db.prepare(`
            INSERT INTO economy_transactions
            (group_id, user_id, target_user_id, type, amount, balance_after, note, related_id, created_at)
            VALUES (?, ?, NULL, '收入', ?, ?, ?, ?, ?)
        `).run(
          this.groupId,
          this.userId,
          safeEarnings,
          balance,
          note || `钓鱼出售 ${fishId || "渔获"}`,
          String(sessionId),
          Date.now(),
        );
      }

      this._recordCatch({
        fishId,
        success: true,
        earnings: safeEarnings,
        rodId,
        masteryGain: 1,
        recordCatch: true,
      });
      const levelUp = this._grantExp(safeExpGain);
      return { success: true, earnings: safeEarnings, levelUp };
    })();
  }

  settleInventoryCatch({ sessionId, fishId, rodId, capacity, expGain = 0 }) {
    const safeCapacity = normalizeNonNegativeInteger(capacity);
    const safeExpGain = normalizeNonNegativeInteger(expGain);
    if (!sessionId || !fishId || safeCapacity == null || safeExpGain == null) {
      return { success: false, reason: "invalid" };
    }

    return db.transaction(() => {
      this._ensureRows();
      if (!this._claimSession({ sessionId, fishId, success: true, earnings: 0 })) {
        return { success: false, reason: "duplicate" };
      }

      const currentSize = db.prepare(`
          SELECT COALESCE(SUM(count), 0) AS total
          FROM inventory WHERE group_id = ? AND user_id = ?
      `).get(this.groupId, this.userId).total;
      const added = currentSize + 1 <= safeCapacity;
      if (added) {
        db.prepare(`
            INSERT INTO inventory (group_id, user_id, item_id, count)
            VALUES (?, ?, ?, 1)
            ON CONFLICT(group_id, user_id, item_id)
            DO UPDATE SET count = count + 1
        `).run(this.groupId, this.userId, fishId);
      }

      this._recordCatch({
        fishId,
        success: true,
        earnings: 0,
        rodId,
        masteryGain: 1,
        recordCatch: true,
      });
      const levelUp = this._grantExp(safeExpGain);
      return { success: true, added, levelUp };
    })();
  }
}
