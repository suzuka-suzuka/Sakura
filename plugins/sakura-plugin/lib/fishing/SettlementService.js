import db from "../Database.js";
import {
  calculateGhostDebtPayment,
  FISHING_STAMINA_MAX,
  getFishingLevelByExp,
  getFishingStaminaMax,
} from "./rules.js";

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

// 重量是图鉴附加信息，非法值按 0 处理而不阻断结算
function normalizeWeight(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
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
        (group_id, user_id, total_catch, total_earnings, torpedo_hits, profession, profession_level, fishing_stamina, fishing_stamina_updated_at)
        VALUES (?, ?, 0, 0, 0, NULL, 0, ?, 0)
    `).run(this.groupId, this.userId, FISHING_STAMINA_MAX);
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

  _recordCatch({ fishId, success, earnings, rodId, masteryGain, recordCatch, weight, shiny = false }) {
    let newlyRecorded = false;
    let newlyShiny = false;
    if (recordCatch) {
      db.prepare(`
          UPDATE fishing_stats
          SET total_catch = total_catch + 1,
              total_earnings = total_earnings + ?
          WHERE group_id = ? AND user_id = ?
      `).run(earnings, this.groupId, this.userId);

      if (fishId) {
        const successIncrement = success ? 1 : 0;
        // 异色只在成功捕获时计入图鉴
        const shinyIncrement = success && shiny ? 1 : 0;
        // 图鉴口径：仅成功渔获刷新最大重量；新收录 = success_count 首次由 0 变正
        const recordedWeight = success ? normalizeWeight(weight) : 0;
        if (success) {
          const previous = db.prepare(`
              SELECT success_count, shiny_count FROM fishing_counts
              WHERE group_id = ? AND user_id = ? AND fish_id = ?
          `).get(this.groupId, this.userId, fishId);
          newlyRecorded = !(previous?.success_count > 0);
          newlyShiny = shinyIncrement > 0 && !(previous?.shiny_count > 0);
        }
        db.prepare(`
            INSERT INTO fishing_counts (group_id, user_id, fish_id, count, success_count, max_weight, shiny_count)
            VALUES (?, ?, ?, 1, ?, ?, ?)
            ON CONFLICT(group_id, user_id, fish_id)
            DO UPDATE SET count = count + 1,
                          success_count = success_count + ?,
                          max_weight = MAX(COALESCE(max_weight, 0), ?),
                          shiny_count = COALESCE(shiny_count, 0) + ?
        `).run(
          this.groupId,
          this.userId,
          fishId,
          successIncrement,
          recordedWeight,
          shinyIncrement,
          successIncrement,
          recordedWeight,
          shinyIncrement,
        );
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
    return { newlyRecorded, newlyShiny };
  }

  // 发放钓鱼经验并检测升级，仅在成功渔获时由结算方法调用
  _grantExp(expGain) {
    if (!(expGain > 0)) return null;
    const before = db.prepare(`
        SELECT fishing_exp FROM fishing_stats WHERE group_id = ? AND user_id = ?
    `).get(this.groupId, this.userId)?.fishing_exp || 0;
    const after = before + expGain;
    const fromLevel = getFishingLevelByExp(before);
    const toLevel = getFishingLevelByExp(after);
    if (toLevel > fromLevel) {
      const staminaResetTo = getFishingStaminaMax(toLevel);
      db.prepare(`
          UPDATE fishing_stats
          SET fishing_exp = ?,
              fishing_stamina = ?,
              fishing_stamina_updated_at = ?
          WHERE group_id = ? AND user_id = ?
      `).run(after, staminaResetTo, Date.now(), this.groupId, this.userId);
      return { from: fromLevel, to: toLevel, staminaResetTo };
    }
    db.prepare(`
        UPDATE fishing_stats
        SET fishing_exp = ?
        WHERE group_id = ? AND user_id = ?
    `).run(after, this.groupId, this.userId);
    return null;
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
    weight = 0,
    shiny = false,
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
      const { newlyRecorded, newlyShiny } = this._recordCatch({
        fishId,
        success,
        earnings: safeEarnings,
        rodId,
        masteryGain: safeMastery,
        recordCatch: Boolean(recordCatch),
        weight,
        shiny: Boolean(shiny),
      });
      const levelUp = this._grantExp(safeExpGain);
      return { success: true, levelUp, newlyRecorded, newlyShiny };
    })();
  }

  settleCoinCatch({
    sessionId,
    fishId,
    earnings,
    rodId,
    note,
    expGain = 0,
    weight = 0,
    shiny = false,
    rewardItemId = null,
    rewardItemCount = 0,
  }) {
    const safeEarnings = normalizeNonNegativeInteger(earnings);
    const safeExpGain = normalizeNonNegativeInteger(expGain);
    const safeRewardItemCount = normalizeNonNegativeInteger(rewardItemCount);
    const safeRewardItemId = typeof rewardItemId === "string" && rewardItemId.trim()
      ? rewardItemId.trim()
      : null;
    if (
      !sessionId ||
      safeEarnings == null ||
      safeExpGain == null ||
      safeRewardItemCount == null ||
      (safeRewardItemCount > 0 && !safeRewardItemId)
    ) {
      return { success: false, reason: "invalid" };
    }

    return db.transaction(() => {
      this._ensureRows();
      const ghostDebt = db.prepare(`
          SELECT ghost_debt FROM fishing_stats
          WHERE group_id = ? AND user_id = ?
      `).get(this.groupId, this.userId)?.ghost_debt || 0;
      const debtResult = calculateGhostDebtPayment(safeEarnings, ghostDebt);
      if (!this._claimSession({
        sessionId,
        fishId,
        success: true,
        earnings: debtResult.earnings,
      })) {
        return { success: false, reason: "duplicate" };
      }

      if (debtResult.debtPaid > 0) {
        db.prepare(`
            UPDATE fishing_stats
            SET ghost_debt = ?
            WHERE group_id = ? AND user_id = ?
        `).run(debtResult.remainingDebt, this.groupId, this.userId);
      }

      if (debtResult.earnings > 0) {
        db.prepare(`
            UPDATE economy
            SET coins = coins + ?
            WHERE group_id = ? AND user_id = ?
        `).run(debtResult.earnings, this.groupId, this.userId);
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
          debtResult.earnings,
          balance,
          note || `钓鱼出售 ${fishId || "渔获"}`,
          String(sessionId),
          Date.now(),
        );
      }

      // 首领鱼饵在开战时已经消耗一个背包空间；胜利宝箱在同一结算事务中补回。
      if (safeRewardItemId && safeRewardItemCount > 0) {
        db.prepare(`
            INSERT INTO inventory (group_id, user_id, item_id, count)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(group_id, user_id, item_id)
            DO UPDATE SET count = count + excluded.count
        `).run(this.groupId, this.userId, safeRewardItemId, safeRewardItemCount);
      }

      const { newlyRecorded, newlyShiny } = this._recordCatch({
        fishId,
        success: true,
        earnings: debtResult.earnings,
        rodId,
        masteryGain: 1,
        recordCatch: true,
        weight,
        shiny: Boolean(shiny),
      });
      const levelUp = this._grantExp(safeExpGain);
      return {
        success: true,
        ...debtResult,
        levelUp,
        newlyRecorded,
        newlyShiny,
        rewardItemId: safeRewardItemId,
        rewardItemCount: safeRewardItemCount,
      };
    })();
  }

  settleInventoryCatch({ sessionId, fishId, rodId, expGain = 0, weight = 0 }) {
    const safeExpGain = normalizeNonNegativeInteger(expGain);
    if (!sessionId || !fishId || safeExpGain == null) {
      return { success: false, reason: "invalid" };
    }

    return db.transaction(() => {
      this._ensureRows();
      if (!this._claimSession({ sessionId, fishId, success: true, earnings: 0 })) {
        return { success: false, reason: "duplicate" };
      }

      // 钓获的宝藏宝箱属于系统强制奖励，即使背包已满或已经超限也必须入包。
      db.prepare(`
          INSERT INTO inventory (group_id, user_id, item_id, count)
          VALUES (?, ?, ?, 1)
          ON CONFLICT(group_id, user_id, item_id)
          DO UPDATE SET count = count + 1
      `).run(this.groupId, this.userId, fishId);

      const { newlyRecorded, newlyShiny } = this._recordCatch({
        fishId,
        success: true,
        earnings: 0,
        rodId,
        masteryGain: 1,
        recordCatch: true,
        weight,
      });
      const levelUp = this._grantExp(safeExpGain);
      return { success: true, added: true, levelUp, newlyRecorded, newlyShiny };
    })();
  }
}
