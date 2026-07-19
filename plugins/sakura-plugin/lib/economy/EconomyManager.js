import Setting from "../setting.js"
import db from "../Database.js"

export default class EconomyManager {
  constructor(e) {
    this.groupId = e.group_id ? String(e.group_id) : null;
    this.config = Setting.getConfig("economy")
  }

  _initUser(e) {
    const userId = String(e.user_id);
    if (!this.groupId) {
      return userId;
    }

    db.prepare(`
        INSERT OR IGNORE INTO economy (group_id, user_id, coins, experience, level, bag_level)
        VALUES (?, ?, 0, 0, 1, 1)
    `).run(this.groupId, userId);

    return userId;
  }

  ensureUser(e) {
    return this._initUser(e);
  }

  getUserData(userId) {
    if (!this.groupId) return { coins: 0, experience: 0, level: 1, bag_level: 1 };

    let row = db.prepare('SELECT * FROM economy WHERE group_id = ? AND user_id = ?').get(this.groupId, userId);
    if (!row) {
      db.prepare(`
            INSERT OR IGNORE INTO economy (group_id, user_id, coins, experience, level, bag_level)
            VALUES (?, ?, 0, 0, 1, 1)
        `).run(this.groupId, userId);
      row = { coins: 0, experience: 0, level: 1, bag_level: 1 };
    }
    return row;
  }

  getCoins(e) {
    this._initUser(e);
    const data = this.getUserData(String(e.user_id));
    return data.coins;
  }

  getLevel(e) {
    this._initUser(e);
    const data = this.getUserData(String(e.user_id));
    return data.level;
  }

  getExperience(e) {
    this._initUser(e);
    const data = this.getUserData(String(e.user_id));
    return data.experience;
  }

  _normalizeCoinAmount(amount) {
    const value = Number(amount);
    if (!Number.isSafeInteger(value) || value <= 0) {
      return null;
    }
    return value;
  }

  _normalizeRecordOptions(options = {}) {
    if (options === false) {
      return { record: false };
    }
    if (typeof options === "string") {
      return { note: options };
    }
    return options || {};
  }

  recordTransaction(e, { type, amount, targetUserId = null, note = "", relatedId = null } = {}) {
    if (!this.groupId || !e?.user_id) return false;
    const value = Number(amount);
    if (!Number.isSafeInteger(value) || value === 0) return false;

    const userId = String(e.user_id);
    const balanceAfter = this.getUserData(userId).coins;
    db.prepare(`
        INSERT INTO economy_transactions
        (group_id, user_id, target_user_id, type, amount, balance_after, note, related_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.groupId,
      userId,
      targetUserId == null ? null : String(targetUserId),
      type || "其他",
      value,
      balanceAfter,
      note || "",
      relatedId || null,
      Date.now(),
    );
    return true;
  }

  getTransactions(e, { userId = null, limit = 10, offset = 0 } = {}) {
    if (!this.groupId) return [];
    const targetUserId = String(userId || e.user_id);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 30));
    const safeOffset = Math.max(0, Number(offset) || 0);

    return db.prepare(`
        SELECT id, group_id, user_id, target_user_id, type, amount, balance_after, note, related_id, created_at
        FROM economy_transactions
        WHERE group_id = ? AND user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
    `).all(this.groupId, targetUserId, safeLimit, safeOffset);
  }

  getTransactionsInRange(e, { userId = null, since = 0, until = Date.now() } = {}) {
    if (!this.groupId) return [];
    const targetUserId = String(userId || e.user_id);
    return db.prepare(`
        SELECT id, group_id, user_id, target_user_id, type, amount, balance_after, note, related_id, created_at
        FROM economy_transactions
        WHERE group_id = ? AND user_id = ? AND created_at >= ? AND created_at < ?
        ORDER BY created_at DESC, id DESC
    `).all(this.groupId, targetUserId, Number(since) || 0, Number(until) || Date.now());
  }

  getTransactionAnalysis(e, { userId = null, since = 0, until = Date.now() } = {}) {
    if (!this.groupId) {
      return { rows: [], income: 0, expense: 0, net: 0, count: 0, categories: [] };
    }
    const targetUserId = String(userId || e.user_id);
    const safeSince = Number(since) || 0;
    const safeUntil = Number(until) || Date.now();
    const summary = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS income,
          COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS expense,
          COUNT(*) AS count
        FROM economy_transactions
        WHERE group_id = ? AND user_id = ? AND created_at >= ? AND created_at < ?
    `).get(this.groupId, targetUserId, safeSince, safeUntil);

    const categoryList = db.prepare(`
        SELECT
          COALESCE(NULLIF(note, ''), NULLIF(type, ''), '其他') AS name,
          COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS income,
          COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS expense,
          COUNT(*) AS count,
          SUM(ABS(amount)) AS total
        FROM economy_transactions
        WHERE group_id = ? AND user_id = ? AND created_at >= ? AND created_at < ?
        GROUP BY COALESCE(NULLIF(note, ''), NULLIF(type, ''), '其他')
        ORDER BY total DESC
        LIMIT 8
    `).all(this.groupId, targetUserId, safeSince, safeUntil);

    const income = Number(summary.income) || 0;
    const expense = Number(summary.expense) || 0;

    return {
      rows: [],
      income,
      expense,
      net: income - expense,
      count: Number(summary.count) || 0,
      categories: categoryList,
    };
  }

  static cleanupTransactions(retentionDays = 7) {
    const days = Math.max(1, Number(retentionDays) || 7);
    const expireBefore = Date.now() - days * 24 * 60 * 60 * 1000;
    const result = db.prepare(`
        DELETE FROM economy_transactions
        WHERE created_at < ?
    `).run(expireBefore);
    return result.changes || 0;
  }

  static cleanupDailyClaims(retentionDays = 30) {
    const days = Math.max(1, Number(retentionDays) || 30);
    const result = db.prepare(`
        DELETE FROM economy_daily_claims
        WHERE created_at < ?
    `).run(Date.now() - days * 24 * 60 * 60 * 1000);
    return result.changes || 0;
  }

  checkRequirement(e, type, value) {
    this._initUser(e);
    const data = this.getUserData(String(e.user_id));
    if (type === 'coins') {
      return data.coins >= value
    } else if (type === 'level') {
      return data.level >= value
    }
    return false
  }

  addExperience(e, amount) {
    if (!this.groupId) return;
    const userId = this._initUser(e);

    const currentData = this.getUserData(userId);
    const newExp = currentData.experience + amount;
    const newLevel = Math.floor(Math.sqrt(newExp / 100)) + 1;

    db.prepare(`
        UPDATE economy 
        SET experience = ?, level = ?
        WHERE group_id = ? AND user_id = ?
    `).run(newExp, newLevel, this.groupId, userId);
  }

  reduceExperience(e, amount) {
    if (!this.groupId) return;
    const userId = this._initUser(e);

    const currentData = this.getUserData(userId);
    const newExp = Math.max(0, currentData.experience - amount);
    const newLevel = Math.floor(Math.sqrt(newExp / 100)) + 1;

    db.prepare(`
        UPDATE economy 
        SET experience = ?, level = ?
        WHERE group_id = ? AND user_id = ?
    `).run(newExp, newLevel, this.groupId, userId);
  }

  addCoins(e, amount, options = {}) {
    if (!this.groupId) return false;
    const value = this._normalizeCoinAmount(amount);
    if (value == null) return false;
    const recordOptions = this._normalizeRecordOptions(options);

    const userId = this._initUser(e);

    const transaction = db.transaction(() => {
      const result = db.prepare(`
          UPDATE economy
          SET coins = coins + ?
          WHERE group_id = ? AND user_id = ?
      `).run(value, this.groupId, userId);

      if (result.changes > 0 && recordOptions.record !== false) {
        this.recordTransaction(e, {
          type: recordOptions.type || "收入",
          amount: value,
          targetUserId: recordOptions.targetUserId,
          note: recordOptions.note || "",
          relatedId: recordOptions.relatedId,
        });
      }
      return result.changes > 0;
    });

    return transaction();
  }

  reduceCoins(e, amount, options = {}) {
    if (!this.groupId) return false;
    const value = this._normalizeCoinAmount(amount);
    if (value == null) return false;
    const recordOptions = this._normalizeRecordOptions(options);

    const userId = this._initUser(e);

    const transaction = db.transaction(() => {
      const currentData = this.getUserData(userId);
      const actualDeducted = Math.min(value, currentData.coins);
      const result = db.prepare(`
          UPDATE economy
          SET coins = MAX(0, coins - ?)
          WHERE group_id = ? AND user_id = ?
      `).run(value, this.groupId, userId);

      if (result.changes > 0 && actualDeducted > 0 && recordOptions.record !== false) {
        this.recordTransaction(e, {
          type: recordOptions.type || "支出",
          amount: -actualDeducted,
          targetUserId: recordOptions.targetUserId,
          note: recordOptions.note || "",
          relatedId: recordOptions.relatedId,
        });
      }
      return result.changes > 0;
    });

    return transaction.immediate();
  }

  tryReduceCoins(e, amount, options = {}) {
    if (!this.groupId) return false;
    const value = this._normalizeCoinAmount(amount);
    if (value == null) return false;
    const recordOptions = this._normalizeRecordOptions(options);

    const userId = this._initUser(e);

    const transaction = db.transaction(() => {
      const result = db.prepare(`
          UPDATE economy
          SET coins = coins - ?
          WHERE group_id = ? AND user_id = ? AND coins >= ?
      `).run(value, this.groupId, userId, value);

      if (result.changes === 1 && recordOptions.record !== false) {
        this.recordTransaction(e, {
          type: recordOptions.type || "支出",
          amount: -value,
          targetUserId: recordOptions.targetUserId,
          note: recordOptions.note || "",
          relatedId: recordOptions.relatedId,
        });
      }
      return result.changes === 1;
    });

    return transaction();
  }

  claimDailyCoins(
    e,
    { claimType, claimDate, amount, note = "每日领取", maxBalanceExclusive = null } = {},
  ) {
    if (!this.groupId || !claimType || !claimDate) {
      return { success: false, reason: "invalid" };
    }
    const value = this._normalizeCoinAmount(amount);
    if (value == null) return { success: false, reason: "invalid" };
    const userId = this._initUser(e);

    const transaction = db.transaction(() => {
      if (maxBalanceExclusive != null) {
        const balance = this.getUserData(userId).coins;
        if (balance >= Number(maxBalanceExclusive)) {
          return { success: false, reason: "ineligible", balance };
        }
      }

      const claim = db.prepare(`
          INSERT OR IGNORE INTO economy_daily_claims
          (group_id, user_id, claim_type, claim_date, created_at)
          VALUES (?, ?, ?, ?, ?)
      `).run(this.groupId, userId, claimType, claimDate, Date.now());

      if (claim.changes !== 1) {
        return { success: false, reason: "already_claimed" };
      }

      db.prepare(`
          UPDATE economy
          SET coins = coins + ?
          WHERE group_id = ? AND user_id = ?
      `).run(value, this.groupId, userId);

      this.recordTransaction(e, {
        type: "收入",
        amount: value,
        note,
        relatedId: `${claimType}:${claimDate}`,
      });

      return { success: true, amount: value };
    });

    return transaction.immediate();
  }

  spendCoins(e, amount, creditEntries = [], options = {}) {
    if (!this.groupId) return false;
    const value = this._normalizeCoinAmount(amount);
    if (value == null) return false;
    const recordOptions = this._normalizeRecordOptions(options);

    const normalizedCredits = [];
    let totalCredit = 0;
    for (const entry of creditEntries) {
      const creditAmount = this._normalizeCoinAmount(entry?.amount);
      if (creditAmount == null) continue;
      if (!entry?.e?.user_id) return false;
      normalizedCredits.push({
        e: entry.e,
        amount: creditAmount,
        note: entry.note || "",
        type: entry.type || "",
      });
      totalCredit += creditAmount;
    }

    if (totalCredit > value) return false;

    const fromUserId = this._initUser(e);
    const creditUsers = normalizedCredits.map((entry) => ({
      userId: this._initUser(entry.e),
      amount: entry.amount,
      e: entry.e,
      note: entry.note || "",
      type: entry.type || "收入",
    }));

    const transaction = db.transaction(() => {
      const result = db.prepare(`
          UPDATE economy
          SET coins = coins - ?
          WHERE group_id = ? AND user_id = ? AND coins >= ?
      `).run(value, this.groupId, fromUserId, value);

      if (result.changes !== 1) {
        return false;
      }

      for (const entry of creditUsers) {
        db.prepare(`
            UPDATE economy
            SET coins = coins + ?
            WHERE group_id = ? AND user_id = ?
        `).run(entry.amount, this.groupId, entry.userId);
      }

      if (recordOptions.record !== false) {
        const firstCredit = creditUsers[0];
        this.recordTransaction(e, {
          type: recordOptions.type || "支出",
          amount: -value,
          targetUserId: recordOptions.targetUserId || firstCredit?.userId,
          note: recordOptions.note || "",
          relatedId: recordOptions.relatedId,
        });

        for (const entry of creditUsers) {
          this.recordTransaction(entry.e, {
            type: entry.type || recordOptions.creditType || "收入",
            amount: entry.amount,
            targetUserId: fromUserId,
            note: entry.note || recordOptions.creditNote || recordOptions.note || "",
            relatedId: recordOptions.relatedId,
          });
        }
      }

      return true;
    });

    return transaction();
  }

  transferCoins(fromE, toE, amount, options = {}) {
    return this.spendCoins(fromE, amount, [{ e: toE, amount }], {
      type: "转账支出",
      creditType: "转账收入",
      note: "转账",
      ...options,
    });
  }


  getRanking(type, limit = 10) {
    if (!this.groupId) return [];

    const validTypes = ['coins', 'level', 'experience'];
    if (!validTypes.includes(type)) return [];

    const rows = db.prepare(`
        SELECT user_id as userId, coins, experience, level, bag_level
        FROM economy
        WHERE group_id = ?
        ORDER BY ${type} DESC
        LIMIT ?
    `).all(this.groupId, limit);

    return rows;
  }

  getBagLevel(e) {
    this._initUser(e);
    const data = this.getUserData(String(e.user_id));
    return data.bag_level || 1;
  }

  getBagConfig() {
    const config = Setting.getEconomy("bag")
    if (config && Object.keys(config).length > 0) {
      return config
    }
    return { levels: { 1: { capacity: 5, cost: 0 } } }
  }

  getBagCapacity(e) {
    const level = this.getBagLevel(e)
    const config = this.getBagConfig()
    return config.levels[level]?.capacity || 5
  }

  upgradeBag(e) {
    if (!this.groupId) return { success: false, msg: "群聊信息错误" };

    const userId = this._initUser(e);
    const data = this.getUserData(userId);
    const currentLevel = data.bag_level || 1;
    const nextLevel = currentLevel + 1;
    const config = this.getBagConfig();

    if (!config.levels[nextLevel]) {
      return { success: false, msg: "背包已达到最高等级" }
    }

    const cost = this._normalizeCoinAmount(config.levels[nextLevel].cost) || 0
    if (data.coins < cost) {
      return { success: false, msg: `金币不足，升级需要 ${cost} 金币` }
    }

    const transaction = db.transaction(() => {
      const result = db.prepare(`
            UPDATE economy
            SET coins = coins - ?, bag_level = ?
            WHERE group_id = ? AND user_id = ? AND coins >= ? AND COALESCE(bag_level, 1) = ?
        `).run(cost, nextLevel, this.groupId, userId, cost, currentLevel);

      if (result.changes !== 1) return false;

      if (cost > 0) {
        this.recordTransaction(e, {
          type: "支出",
          amount: -cost,
          note: `升级背包至 ${nextLevel} 级`,
        });
      }
      return true;
    });

    try {
      const success = transaction();
      if (!success) {
        return { success: false, msg: "金币不足或背包等级已变化，请重试" };
      }
      return {
        success: true,
        msg: `背包升级成功！当前等级: ${nextLevel}, 容量: ${config.levels[nextLevel].capacity}`,
        newLevel: nextLevel,
        newCapacity: config.levels[nextLevel].capacity
      }
    } catch (err) {
      return { success: false, msg: "升级失败: " + err.message };
    }
  }
}
