import db from "../Database.js";
import EconomyManager from "./EconomyManager.js";

export default class EconomyOperations {
  constructor(e) {
    this.e = e;
    this.groupId = String(e.group_id);
    this.userId = String(e.user_id);
    this.economyManager = new EconomyManager(e);
  }

  sellItem({ itemId, price, itemName, equipmentSlot = null }) {
    const safePrice = Number(price);
    const safeEquipmentSlot = ["rod", "line"].includes(equipmentSlot) ? equipmentSlot : null;
    if (!itemId || !Number.isSafeInteger(safePrice) || safePrice < 0) {
      return { success: false, reason: "invalid" };
    }

    this.economyManager.ensureUser(this.e);
    const transaction = db.transaction(() => {
      const removed = db.prepare(`
          UPDATE inventory
          SET count = count - 1
          WHERE group_id = ? AND user_id = ? AND item_id = ? AND count >= 1
      `).run(this.groupId, this.userId, itemId);
      if (removed.changes !== 1) {
        return { success: false, reason: "not_owned" };
      }

      db.prepare(`
          DELETE FROM inventory
          WHERE group_id = ? AND user_id = ? AND item_id = ? AND count <= 0
      `).run(this.groupId, this.userId, itemId);

      const remaining = db.prepare(`
          SELECT count FROM inventory
          WHERE group_id = ? AND user_id = ? AND item_id = ?
      `).get(this.groupId, this.userId, itemId)?.count || 0;

      if (safeEquipmentSlot && remaining === 0) {
        if (safeEquipmentSlot === "rod") {
          db.prepare(`
              DELETE FROM rod_stats
              WHERE group_id = ? AND user_id = ? AND rod_id = ?
          `).run(this.groupId, this.userId, itemId);
        }
        db.prepare(`
            UPDATE fishing_stats
            SET ${safeEquipmentSlot} = CASE
              WHEN ${safeEquipmentSlot} = ? THEN NULL
              ELSE ${safeEquipmentSlot}
            END
            WHERE group_id = ? AND user_id = ?
        `).run(itemId, this.groupId, this.userId);
      }

      if (safePrice > 0) {
        db.prepare(`
            UPDATE economy
            SET coins = coins + ?
            WHERE group_id = ? AND user_id = ?
        `).run(safePrice, this.groupId, this.userId);
        this.economyManager.recordTransaction(this.e, {
          type: "收入",
          amount: safePrice,
          note: `出售 ${itemName || itemId}`,
        });
      }

      return { success: true, price: safePrice };
    });

    return transaction();
  }
}
