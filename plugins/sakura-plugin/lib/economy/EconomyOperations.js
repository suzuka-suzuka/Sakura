import db from "../Database.js";
import EconomyManager from "./EconomyManager.js";
import InventoryManager from "./InventoryManager.js";
import ShopManager from "./ShopManager.js";
import {
  FISHING_LEVEL_REWARD_ITEMS,
  getDexLocationRewardClaimType,
  getDexLocationRewardTiers,
  getFishingLevelRewardClaimType,
  getFishingLevelRewardSlotCost,
  getNextFishingLevelRewardMilestone,
  getReachedFishingLevelRewardMilestones,
} from "./rules.js";

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

  // 等级奖励按档位分别记账，跨档补领时一次性把欠着的档位全部结清。
  claimFishingLevelRewards(fishingLevel) {
    const safeLevel = Math.max(1, Math.floor(Number(fishingLevel) || 1));
    const shopManager = new ShopManager();
    const rewardItems = FISHING_LEVEL_REWARD_ITEMS.map((reward) => {
      const item = shopManager.findItemById(reward.itemId);
      return item ? { ...reward, item } : null;
    });
    if (rewardItems.some((reward) => reward == null)) {
      return { success: false, reason: "invalid_config" };
    }

    const nextLevel = getNextFishingLevelRewardMilestone(safeLevel);
    const reachedLevels = getReachedFishingLevelRewardMilestones(safeLevel);
    if (reachedLevels.length === 0) {
      return { success: false, reason: "level_not_reached", fishingLevel: safeLevel, nextLevel };
    }

    const inventoryManager = new InventoryManager(this.e);
    this.economyManager.ensureUser(this.e);
    const transaction = db.transaction(() => {
      const claimTypes = reachedLevels.map((milestone) => getFishingLevelRewardClaimType(milestone));
      const claimedRows = db.prepare(`
          SELECT claim_type
          FROM economy_one_time_claims
          WHERE group_id = ? AND user_id = ?
            AND claim_type IN (${claimTypes.map(() => "?").join(", ")})
      `).all(this.groupId, this.userId, ...claimTypes);
      const claimed = new Set(claimedRows.map((row) => row.claim_type));
      const pendingLevels = reachedLevels.filter(
        (milestone) => !claimed.has(getFishingLevelRewardClaimType(milestone)),
      );
      if (pendingLevels.length === 0) {
        return { success: false, reason: "already_claimed", fishingLevel: safeLevel, nextLevel };
      }

      // 背包不够就整体不发，避免记了账却只发出半套道具。
      const requiredSpace = getFishingLevelRewardSlotCost() * pendingLevels.length;
      const capacity = this.economyManager.getBagCapacity(this.e);
      const freeCapacity = Math.max(0, capacity - inventoryManager.getCurrentSize());
      if (freeCapacity < requiredSpace) {
        return {
          success: false,
          reason: "no_space",
          fishingLevel: safeLevel,
          freeCapacity,
          requiredSpace,
          pendingLevels,
        };
      }

      for (const milestone of pendingLevels) {
        const claim = db.prepare(`
            INSERT OR IGNORE INTO economy_one_time_claims
            (group_id, user_id, claim_type, created_at)
            VALUES (?, ?, ?, ?)
        `).run(
          this.groupId,
          this.userId,
          getFishingLevelRewardClaimType(milestone),
          Date.now(),
        );
        if (claim.changes !== 1) {
          throw new Error(`钓鱼等级奖励重复领取: Lv.${milestone}`);
        }
      }

      const grantedItems = rewardItems.map((reward) => {
        const totalCount = reward.count * pendingLevels.length;
        db.prepare(`
            INSERT INTO inventory (group_id, user_id, item_id, count)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(group_id, user_id, item_id)
            DO UPDATE SET count = count + ?
        `).run(this.groupId, this.userId, reward.itemId, totalCount, totalCount);
        return { item: reward.item, count: totalCount };
      });

      return {
        success: true,
        fishingLevel: safeLevel,
        grantedLevels: pendingLevels,
        grantedItems,
        nextLevel,
      };
    });

    return transaction.immediate();
  }

  /**
   * 钓点专属图鉴奖励。progressList 由指令层给出，每项为
   * { locationId, locationName, collected, total }（collected/total 只统计该钓点专属鱼）。
   * 多个钓点的待领档位一次性结清，任一钓点空间不够就整体不发。
   */
  claimDexLocationRewards(progressList) {
    const shopManager = new ShopManager();
    const itemCache = new Map();
    const resolveItem = (itemId) => {
      if (!itemCache.has(itemId)) itemCache.set(itemId, shopManager.findItemById(itemId));
      return itemCache.get(itemId);
    };

    const candidateTiers = [];
    for (const progress of Array.isArray(progressList) ? progressList : []) {
      const collected = Math.max(0, Math.floor(Number(progress?.collected) || 0));
      const total = Math.max(0, Math.floor(Number(progress?.total) || 0));
      for (const tier of getDexLocationRewardTiers(progress?.locationId, total)) {
        if (collected < tier.threshold) continue;
        const items = tier.items.map((reward) => {
          const item = resolveItem(reward.itemId);
          return item ? { ...reward, item } : null;
        });
        if (items.some((item) => item == null)) {
          return { success: false, reason: "invalid_config" };
        }
        candidateTiers.push({
          locationId: progress.locationId,
          locationName: progress.locationName || progress.locationId,
          tierKey: tier.key,
          threshold: tier.threshold,
          coins: Math.max(0, Math.floor(Number(tier.coins) || 0)),
          items,
        });
      }
    }
    if (candidateTiers.length === 0) {
      return { success: false, reason: "nothing_to_claim" };
    }

    const inventoryManager = new InventoryManager(this.e);
    this.economyManager.ensureUser(this.e);
    const transaction = db.transaction(() => {
      const claimTypes = candidateTiers.map(
        (tier) => getDexLocationRewardClaimType(tier.locationId, tier.tierKey),
      );
      const claimedRows = db.prepare(`
          SELECT claim_type
          FROM economy_one_time_claims
          WHERE group_id = ? AND user_id = ?
            AND claim_type IN (${claimTypes.map(() => "?").join(", ")})
      `).all(this.groupId, this.userId, ...claimTypes);
      const claimed = new Set(claimedRows.map((row) => row.claim_type));
      const pendingTiers = candidateTiers.filter(
        (tier) => !claimed.has(getDexLocationRewardClaimType(tier.locationId, tier.tierKey)),
      );
      if (pendingTiers.length === 0) {
        return { success: false, reason: "nothing_to_claim" };
      }

      const requiredSpace = pendingTiers.reduce(
        (total, tier) => total + tier.items.reduce((sum, reward) => sum + reward.count, 0),
        0,
      );
      const capacity = this.economyManager.getBagCapacity(this.e);
      const freeCapacity = Math.max(0, capacity - inventoryManager.getCurrentSize());
      if (freeCapacity < requiredSpace) {
        return { success: false, reason: "no_space", freeCapacity, requiredSpace, pendingTiers };
      }

      for (const tier of pendingTiers) {
        const claim = db.prepare(`
            INSERT OR IGNORE INTO economy_one_time_claims
            (group_id, user_id, claim_type, created_at)
            VALUES (?, ?, ?, ?)
        `).run(
          this.groupId,
          this.userId,
          getDexLocationRewardClaimType(tier.locationId, tier.tierKey),
          Date.now(),
        );
        if (claim.changes !== 1) {
          throw new Error(`图鉴奖励重复领取: ${tier.locationId} ${tier.tierKey}`);
        }

        for (const reward of tier.items) {
          db.prepare(`
              INSERT INTO inventory (group_id, user_id, item_id, count)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(group_id, user_id, item_id)
              DO UPDATE SET count = count + ?
          `).run(this.groupId, this.userId, reward.itemId, reward.count, reward.count);
        }
      }

      const totalCoins = pendingTiers.reduce((sum, tier) => sum + tier.coins, 0);
      if (totalCoins > 0) {
        const credited = db.prepare(`
            UPDATE economy
            SET coins = coins + ?
            WHERE group_id = ? AND user_id = ?
        `).run(totalCoins, this.groupId, this.userId);
        if (credited.changes !== 1) {
          throw new Error("图鉴奖励金币入账失败");
        }
        this.economyManager.recordTransaction(this.e, {
          type: "收入",
          amount: totalCoins,
          note: "领取钓点图鉴全收录奖励",
          relatedId: "dex_location_reward",
        });
      }

      return { success: true, grantedTiers: pendingTiers, totalCoins };
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

      // 亡者高利贷与抽成印记都只作用于垂钓所得，出售收入原封不动进账。
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

      return { success: true, price: safePrice, earnings: safePrice };
    });

    return transaction();
  }
}
