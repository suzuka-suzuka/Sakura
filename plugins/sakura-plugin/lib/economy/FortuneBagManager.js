import db from "../Database.js";
import { FISHING_LOCATIONS, normalizeFishingLocation } from "../fishing/rules.js";
import FishingSettlementService from "../fishing/SettlementService.js";
import {
  FORTUNE_BAG_ITEM_ID,
  FORTUNE_BAG_INITIAL_AMOUNT,
  FORTUNE_BAG_INCREMENT,
  FORTUNE_BAG_LEASE_MS,
  FORTUNE_BAG_IMAGE_LIMIT,
  FORTUNE_BAG_WEALTH_CHANCE,
  FORTUNE_BAG_WEALTH_BUFF_ID,
  FORTUNE_BAG_WEALTH_DURATION_MS,
  normalizeFortuneBagMessage,
} from "./fortuneBagRules.js";

class SettlementRollback extends Error {
  constructor(result) { super("福袋结算回滚"); this.result = result; }
}

export default class FortuneBagManager {
  constructor(e) {
    this.groupId = String(e.group_id);
    this.userId = String(e.user_id);
    this.e = e;
  }

  deploy(locationId, message, image = null) {
    if (image !== null && (!Buffer.isBuffer(image) || !image.length || image.length > FORTUNE_BAG_IMAGE_LIMIT)) {
      return { success: false, reason: "invalid_image" };
    }
    const text = image && !String(message || "").trim() ? "" : normalizeFortuneBagMessage(message);
    if (text === null) return { success: false, reason: "invalid_message" };
    if (!FISHING_LOCATIONS[locationId]) return { success: false, reason: "invalid_location" };
    return db.transaction(() => {
      const consumed = db.prepare(`
        UPDATE inventory SET count = count - 1
        WHERE group_id = ? AND user_id = ? AND item_id = ? AND count > 0
      `).run(this.groupId, this.userId, FORTUNE_BAG_ITEM_ID);
      if (consumed.changes !== 1) return { success: false, reason: "no_item" };
      db.prepare("DELETE FROM inventory WHERE group_id = ? AND user_id = ? AND item_id = ? AND count <= 0")
        .run(this.groupId, this.userId, FORTUNE_BAG_ITEM_ID);
      const inserted = db.prepare(`
        INSERT INTO pond_fortune_bags (group_id, owner_id, location, message, image, amount, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(this.groupId, this.userId, locationId, text, image, FORTUNE_BAG_INITIAL_AMOUNT, Date.now());
      return { success: true, id: Number(inserted.lastInsertRowid), amount: FORTUNE_BAG_INITIAL_AMOUNT };
    }).immediate();
  }

  listOwn() {
    this.recoverReservations();
    return db.prepare(`
      SELECT * FROM pond_fortune_bags
      WHERE group_id = ? AND owner_id = ? AND status IN ('active', 'hooked') ORDER BY id DESC
    `).all(this.groupId, this.userId);
  }

  recoverReservations(now = Date.now()) {
    return db.prepare(`
      UPDATE pond_fortune_bags SET status = 'active', session_id = NULL, hook_until = NULL
      WHERE group_id = ? AND status = 'hooked' AND hook_until <= ?
    `).run(this.groupId, now).changes;
  }

  getAvailableCount(locationId) {
    this.recoverReservations();
    return db.prepare(`
      SELECT COUNT(*) AS count FROM pond_fortune_bags
      WHERE group_id = ? AND location = ? AND status = 'active'
    `).get(this.groupId, normalizeFishingLocation(locationId)).count;
  }

  reserve(locationId, sessionId) {
    if (!sessionId) return null;
    return db.transaction(() => {
      this.recoverReservations();
      return db.prepare(`
        UPDATE pond_fortune_bags SET status = 'hooked', session_id = ?, hook_until = ?
        WHERE id = (
          SELECT id FROM pond_fortune_bags
          WHERE group_id = ? AND location = ? AND status = 'active'
          ORDER BY RANDOM() LIMIT 1
        )
        RETURNING *
      `).get(String(sessionId), Date.now() + FORTUNE_BAG_LEASE_MS,
        this.groupId, normalizeFishingLocation(locationId)) || null;
    }).immediate();
  }

  release(sessionId) {
    return db.prepare(`
      UPDATE pond_fortune_bags SET status = 'active', session_id = NULL, hook_until = NULL
      WHERE group_id = ? AND status = 'hooked' AND session_id = ?
    `).run(this.groupId, String(sessionId)).changes;
  }

  getWealthBuff(userId = this.userId, now = Date.now()) {
    const row = db.prepare(`SELECT effect, expire_time FROM user_buffs
      WHERE group_id = ? AND user_id = ? AND buff_id = ? AND expire_time > ?`)
      .get(this.groupId, String(userId), FORTUNE_BAG_WEALTH_BUFF_ID, now);
    return row ? { bonus: JSON.parse(row.effect).value, expiresAt: row.expire_time } : null;
  }

  getWealthBonus(userId = this.userId, now = Date.now()) {
    return this.getWealthBuff(userId, now)?.bonus || 0;
  }

  // 与发钱、福袋消失共用事务，避免只消耗福袋却没有发出祝福。
  grantWealthBuff(ownerId, amount, now = Date.now()) {
    const bonus = Math.max(amount / 2, this.getWealthBonus(ownerId, now));
    const expiresAt = now + FORTUNE_BAG_WEALTH_DURATION_MS;
    db.prepare(`INSERT INTO user_buffs
      (group_id, user_id, buff_id, name, effect, activated_at, expire_time)
      VALUES (?, ?, ?, '财神', ?, ?, ?)
      ON CONFLICT(group_id, user_id, buff_id) DO UPDATE SET
        name = excluded.name, effect = excluded.effect,
        activated_at = excluded.activated_at, expire_time = excluded.expire_time`)
      .run(this.groupId, String(ownerId), FORTUNE_BAG_WEALTH_BUFF_ID,
        JSON.stringify({ type: "fishing_coin_bonus", value: bonus }), now, expiresAt);
    return { bonus, expiresAt };
  }

  settle({ bagId, sessionId, success, rodId = null, expGain = 0, masteryGain = 0, locationId }) {
    try {
      return db.transaction(() => {
        const bag = db.prepare(`
          SELECT * FROM pond_fortune_bags
          WHERE id = ? AND group_id = ? AND status = 'hooked' AND session_id = ?
        `).get(bagId, this.groupId, String(sessionId));
        if (!bag) return { success: false, reason: "not_reserved" };
        const settlement = new FishingSettlementService(this.e);
        const result = success
          ? settlement.settleFortuneBagCatch({ sessionId, bagId, amount: bag.amount,
            ownerId: bag.owner_id, rodId, expGain })
          : settlement.settleAttempt({ sessionId, success: false, rodId, masteryGain, recordCatch: false });
        if (!result.success) throw new SettlementRollback(result);
        const ownCatch = String(bag.owner_id) === this.userId;
        const wealthTriggered = success && !ownCatch && Math.random() < FORTUNE_BAG_WEALTH_CHANCE;
        const wealthBuff = wealthTriggered ? this.grantWealthBuff(bag.owner_id, bag.amount) : null;
        const nextAmount = success && !wealthTriggered
          ? (ownCatch ? FORTUNE_BAG_INITIAL_AMOUNT : bag.amount + FORTUNE_BAG_INCREMENT)
          : bag.amount;
        if (!Number.isSafeInteger(nextAmount)) throw new Error("福袋金额超出整数范围");
        const ended = wealthTriggered;
        const nextLocation = success && FISHING_LOCATIONS[locationId] ? locationId : bag.location;
        db.prepare(`
          UPDATE pond_fortune_bags SET amount = ?, location = ?, status = ?,
            success_count = success_count + ?, total_paid = total_paid + ?,
            session_id = NULL, hook_until = NULL
          WHERE id = ?
        `).run(nextAmount, nextLocation,
          ended ? "ended" : "active", success ? 1 : 0, success ? bag.amount : 0, bag.id);
        return { ...result, amount: bag.amount, nextAmount, ended, ownerId: bag.owner_id,
          ownCatch, wealthBuff };
      }).immediate();
    } catch (error) {
      if (error instanceof SettlementRollback) return error.result;
      throw error;
    }
  }

}
