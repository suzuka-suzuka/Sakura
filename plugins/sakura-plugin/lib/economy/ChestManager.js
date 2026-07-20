import _ from "lodash";
import Setting from "../setting.js";
import InventoryManager from "./InventoryManager.js";
import EconomyManager from "./EconomyManager.js";
import FishingManager from "./FishingManager.js";
import ShopManager from "./ShopManager.js";
import {
  getUnownedFishingLines,
  resolveRandomLineLootWeight,
  selectRandomUnownedLine,
} from "./chestRules.js";

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
    this.economyManager = new EconomyManager(e);
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
    return resolveRandomLineLootWeight(
      configuredLoot,
      this.getUnownedLines().length > 0,
    );
  }

  getUnownedLines() {
    const ownedItemIds = new Set(Object.keys(this.inventoryManager.getInventory()));
    return getUnownedFishingLines(this.fishingManager.getAllLines(), ownedItemIds);
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
   * 任何失败分支都不消耗宝箱（金币入账失败时会把宝箱放回背包）。
   */
  openChest(chestItem) {
    const entry = this.rollLoot(chestItem.id);
    if (!entry) return { success: false, reason: "bad_config" };

    switch (entry.type) {
      case "coins": {
        const min = Math.max(0, Math.floor(Number(entry.min) || 0));
        const max = Math.max(min, Math.floor(Number(entry.max) || min));
        const amount = _.random(min, max);
        if (!this.inventoryManager.removeItem(chestItem.id, 1)) {
          return { success: false, reason: "no_chest" };
        }
        const added = this.economyManager.addCoins(this.e, amount, {
          type: "收入",
          note: `开启${chestItem.name}`,
        });
        if (!added) {
          this.inventoryManager.forceAddItem(chestItem.id, 1);
          return { success: false, reason: "grant_failed" };
        }
        return {
          success: true,
          type: "coins",
          amount,
          treasureName: entry.name || null,
          treasureDescription: entry.description || null,
        };
      }

      case "item": {
        const rewardItem = this.shopManager.findItemById(entry.item_id);
        if (!rewardItem) return { success: false, reason: "bad_config" };
        const count = Math.max(1, Math.floor(Number(entry.count) || 1));
        const exchange = this.inventoryManager.exchangeItem(chestItem.id, 1, rewardItem.id, count);
        if (!exchange.success) {
          return { success: false, reason: "bag_full", msg: exchange.msg };
        }
        return { success: true, type: "item", item: rewardItem, count };
      }

      case "random_bait": {
        // 首领鱼饵有独立掉落权重，避免被“随机鱼饵”再次稀释概率口径。
        const baits = this.fishingManager.getAllBaits().filter((bait) => !bait.boss_bait);
        if (baits.length === 0) return { success: false, reason: "bad_config" };
        const bait = baits[_.random(0, baits.length - 1)];
        const count = Math.max(1, Math.floor(Number(entry.count) || 1));
        const exchange = this.inventoryManager.exchangeItem(chestItem.id, 1, bait.id, count);
        if (!exchange.success) {
          return { success: false, reason: "bag_full", msg: exchange.msg };
        }
        return { success: true, type: "item", item: bait, count, isRandomBait: true };
      }

      case "random_line": {
        const ownedItemIds = new Set(Object.keys(this.inventoryManager.getInventory()));
        const line = selectRandomUnownedLine(
          this.fishingManager.getAllLines(),
          ownedItemIds,
        );
        // 正常情况下，全收集时该权重已在 rollLoot 前并入金币；这里防御并发获得鱼线。
        if (!line) return { success: false, reason: "retry" };
        const exchange = this.inventoryManager.exchangeItem(chestItem.id, 1, line.id, 1);
        if (!exchange.success) {
          return { success: false, reason: "bag_full", msg: exchange.msg };
        }
        let autoEquipped = false;
        if (!this.fishingManager.getEquippedLine(this.userId)) {
          autoEquipped = this.fishingManager.equipLine(this.userId, line.id);
        }
        return {
          success: true,
          type: "item",
          item: line,
          count: 1,
          isRandomLine: true,
          autoEquipped,
        };
      }

      case "curse": {
        const layers = Math.max(1, Math.floor(Number(entry.layers) || 1));
        const coins = Math.max(0, Math.floor(Number(entry.coins) || 0));
        if (!this.inventoryManager.removeItem(chestItem.id, 1)) {
          return { success: false, reason: "no_chest" };
        }
        this.fishingManager.addNightmareCurseLayers(this.userId, layers);
        if (coins > 0) {
          this.economyManager.addCoins(this.e, coins, {
            type: "收入",
            note: `开启${chestItem.name}：压惊费`,
          });
        }
        return { success: true, type: "curse", layers, coins };
      }

      default:
        return { success: false, reason: "bad_config" };
    }
  }
}
