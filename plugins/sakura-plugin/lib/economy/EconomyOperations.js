import db from "../Database.js";
import EconomyManager from "./EconomyManager.js";
import InventoryManager from "./InventoryManager.js";
import ShopManager from "./ShopManager.js";
import { calculateGhostDebtPayment } from "../fishing/rules.js";

const FISHING_NEWBIE_GIFT_CLAIM_TYPE = "fishing_newbie_gift";
const FISHING_NEWBIE_GIFT_REQUIRED_SPACE = 5;
const FISHING_NEWBIE_GIFT_ITEMS = [
  { itemId: "rod_bamboo", count: 1, skipWhenOwned: true },
  { itemId: "line_basic", count: 1, skipWhenOwned: true },
  { itemId: "bait_worm", count: 3, skipWhenOwned: false },
];

export default class EconomyOperations {
  constructor(e) {
    this.e = e;
    this.groupId = String(e.group_id);
    this.userId = String(e.user_id);
    this.economyManager = new EconomyManager(e);
  }

  claimFishingNewbieGift() {
    const inventoryManager = new InventoryManager(this.e);
    const shopManager = new ShopManager();
    const configuredItems = FISHING_NEWBIE_GIFT_ITEMS.map((giftItem) => {
      const item = shopManager.findShopItemById(giftItem.itemId);
      const unitPrice = Number(item?.price);
      if (!item || !Number.isSafeInteger(unitPrice) || unitPrice < 0) return null;
      return { ...giftItem, item, unitPrice };
    });
    if (configuredItems.some((item) => item == null)) {
      return { success: false, reason: "invalid_config" };
    }

    this.economyManager.ensureUser(this.e);
    const transaction = db.transaction(() => {
      const claim = db.prepare(`
          INSERT OR IGNORE INTO economy_one_time_claims
          (group_id, user_id, claim_type, created_at)
          VALUES (?, ?, ?, ?)
      `).run(
        this.groupId,
        this.userId,
        FISHING_NEWBIE_GIFT_CLAIM_TYPE,
        Date.now(),
      );
      if (claim.changes !== 1) {
        return { success: false, reason: "already_claimed" };
      }

      const skippedItems = [];
      const eligibleItems = configuredItems.filter((giftItem) => {
        if (
          giftItem.skipWhenOwned &&
          inventoryManager.getItemCount(giftItem.itemId) > 0
        ) {
          skippedItems.push(giftItem);
          return false;
        }
        return true;
      });

      const capacity = this.economyManager.getBagCapacity(this.e);
      const currentSize = inventoryManager.getCurrentSize();
      const freeCapacity = Math.max(0, capacity - currentSize);

      if (freeCapacity < FISHING_NEWBIE_GIFT_REQUIRED_SPACE) {
        const coinAmount = eligibleItems.reduce(
          (total, giftItem) => total + giftItem.unitPrice * giftItem.count,
          0,
        );
        if (!Number.isSafeInteger(coinAmount) || coinAmount <= 0) {
          throw new Error("钓鱼新人礼包折现金额异常");
        }

        const credited = db.prepare(`
            UPDATE economy
            SET coins = coins + ?
            WHERE group_id = ? AND user_id = ?
        `).run(coinAmount, this.groupId, this.userId);
        if (credited.changes !== 1) {
          throw new Error("钓鱼新人礼包折现入账失败");
        }
        this.economyManager.recordTransaction(this.e, {
          type: "收入",
          amount: coinAmount,
          note: "领取钓鱼新人礼包（背包不足折现）",
          relatedId: FISHING_NEWBIE_GIFT_CLAIM_TYPE,
        });

        return {
          success: true,
          mode: "coins",
          coinAmount,
          freeCapacity,
          convertedItems: eligibleItems,
          skippedItems,
        };
      }

      for (const giftItem of eligibleItems) {
        if (giftItem.skipWhenOwned) {
          const inserted = db.prepare(`
              INSERT INTO inventory (group_id, user_id, item_id, count)
              VALUES (?, ?, ?, 1)
              ON CONFLICT(group_id, user_id, item_id) DO NOTHING
          `).run(this.groupId, this.userId, giftItem.itemId);
          if (inserted.changes !== 1) {
            throw new Error(`钓鱼新人礼包唯一装备发放失败: ${giftItem.itemId}`);
          }
          continue;
        }

        db.prepare(`
            INSERT INTO inventory (group_id, user_id, item_id, count)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(group_id, user_id, item_id)
            DO UPDATE SET count = count + ?
        `).run(
          this.groupId,
          this.userId,
          giftItem.itemId,
          giftItem.count,
          giftItem.count,
        );
      }

      return {
        success: true,
        mode: "items",
        freeCapacity,
        grantedItems: eligibleItems,
        skippedItems,
      };
    });

    return transaction.immediate();
  }

  sellItem({ itemId, price, itemName, equipmentSlot = null }) {
    const safePrice = Number(price);
    const safeEquipmentSlot = ["rod", "line"].includes(equipmentSlot) ? equipmentSlot : null;
    if (!itemId || !Number.isSafeInteger(safePrice) || safePrice < 0) {
      return { success: false, reason: "invalid" };
    }

    this.economyManager.ensureUser(this.e);
    const transaction = db.transaction(() => {
      const removed = safeEquipmentSlot
        ? db.prepare(`
            DELETE FROM inventory
            WHERE group_id = ? AND user_id = ? AND item_id = ? AND count > 0
        `).run(this.groupId, this.userId, itemId)
        : db.prepare(`
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

      const ghostDebt = db.prepare(`
          SELECT ghost_debt FROM fishing_stats
          WHERE group_id = ? AND user_id = ?
      `).get(this.groupId, this.userId)?.ghost_debt || 0;
      const debtResult = calculateGhostDebtPayment(safePrice, ghostDebt);
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
        this.economyManager.recordTransaction(this.e, {
          type: "收入",
          amount: debtResult.earnings,
          note: `出售 ${itemName || itemId}`,
        });
      }

      return { success: true, price: safePrice, ...debtResult };
    });

    return transaction();
  }
}
