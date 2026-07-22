import Setting from "../setting.js";
import InventoryManager from "./InventoryManager.js";
import FishingManager from "./FishingManager.js";
import ShopManager from "./ShopManager.js";

/**
 * 钓点宝箱管理器
 * 宝箱定义在 special_items.yaml（handler: fishing_chest），
 * 掉落表在 treasure_chest.yaml，按权重随机开出奖励。
 */
export default class ChestManager {
  constructor(e) {
    this.e = e;
    this.groupId = String(e.group_id);
    this.userId = String(e.user_id);
    this.inventoryManager = new InventoryManager(e);
    this.fishingManager = new FishingManager(e.group_id);
    this.shopManager = new ShopManager();
  }

  static isChestItem(item) {
    return item?.handler === "fishing_chest";
  }

  getChestItems() {
    return this.shopManager.getAllItems().filter((item) => ChestManager.isChestItem(item));
  }

  findChestByName(name) {
    return this.getChestItems().find((item) => item.name === name) || null;
  }

  listOwnedChests() {
    return this.getChestItems()
      .map((item) => ({ item, count: this.inventoryManager.getItemCount(item.id) }))
      .filter((entry) => entry.count > 0);
  }

  getLootTable(chestId) {
    const config = Setting.getEconomy("treasure_chest");
    const loot = config?.chests?.[chestId]?.loot;
    if (!Array.isArray(loot)) return [];
    const configuredLoot = loot.filter((entry) => (
      entry && typeof entry.type === "string" && Number(entry.weight) > 0
    ));
    return configuredLoot;
  }

  rollLoot(chestId, random = Math.random) {
    const loot = this.getLootTable(chestId);
    if (loot.length === 0) return null;
    const totalWeight = loot.reduce((sum, entry) => sum + Number(entry.weight), 0);
    let roll = Math.max(0, Math.min(0.999999999999, Number(random()) || 0)) * totalWeight;
    for (const entry of loot) {
      roll -= Number(entry.weight);
      if (roll <= 0) return entry;
    }
    return loot.at(-1);
  }

  /**
   * 打开一个宝箱：消耗宝箱并发放奖励。
   * 开箱奖励属于强制入包物品，可以突破背包容量；整个交换仍保持原子性。
   */
  openChest(chestItem) {
    const entry = this.rollLoot(chestItem.id);
    if (!entry) return { success: false, reason: "bad_config" };

    switch (entry.type) {
      case "item": {
        const rewardItem = this.shopManager.findItemById(entry.item_id);
        if (!rewardItem) return { success: false, reason: "bad_config" };
        const count = Math.max(1, Math.floor(Number(entry.count) || 1));
        const exchange = this.inventoryManager.exchangeItem(
          chestItem.id,
          1,
          rewardItem.id,
          count,
          { allowOverflow: true },
        );
        if (!exchange.success) {
          return { success: false, reason: "bag_full", msg: exchange.msg };
        }
        return { success: true, type: "item", item: rewardItem, count };
      }

      case "random_bait": {
        // 首领鱼饵单独掉落。普通随机鱼饵优先选择背包里完全没有的种类；
        // 六种普通鱼饵都已持有时，才在完整普通鱼饵池中真随机。
        const baits = this.fishingManager.getAllBaits().filter((bait) => !bait.boss_bait);
        if (baits.length === 0) return { success: false, reason: "bad_config" };
        const missingBaits = baits.filter(
          (bait) => this.inventoryManager.getItemCount(bait.id) <= 0,
        );
        const candidates = missingBaits.length > 0 ? missingBaits : baits;
        const bait = candidates[Math.floor(Math.random() * candidates.length)];
        const count = Math.max(1, Math.floor(Number(entry.count) || 1));
        const exchange = this.inventoryManager.exchangeItem(
          chestItem.id,
          1,
          bait.id,
          count,
          { allowOverflow: true },
        );
        if (!exchange.success) {
          return { success: false, reason: "bag_full", msg: exchange.msg };
        }
        return { success: true, type: "item", item: bait, count, isRandomBait: true };
      }

      default:
        return { success: false, reason: "bad_config" };
    }
  }
}
