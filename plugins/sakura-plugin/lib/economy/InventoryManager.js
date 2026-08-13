import EconomyManager from "./EconomyManager.js";
import db from "../Database.js";
import { isUniqueFishingEquipmentId } from "./inventoryRules.js";

export default class InventoryManager {
  constructor(eOrGroupId, userId) {
    if (typeof eOrGroupId === 'object' && eOrGroupId.group_id) {
      this.e = eOrGroupId;
      this.groupId = String(eOrGroupId.group_id);
      this.userId = String(eOrGroupId.user_id);
    } else {
      this.groupId = String(eOrGroupId);
      this.userId = String(userId);
      this.e = { group_id: this.groupId, user_id: this.userId };
    }

    this.economyManager = new EconomyManager(this.e);
  }

  getInventory() {
    const rows = db.prepare(`
        SELECT item_id, count 
        FROM inventory 
        WHERE group_id = ? AND user_id = ?
    `).all(this.groupId, this.userId);

    const inventory = {};
    for (const row of rows) {
      inventory[row.item_id] = isUniqueFishingEquipmentId(row.item_id)
        ? Math.min(1, row.count)
        : row.count;
    }
    return inventory;
  }

  getItemCount(itemId) {
    const row = db.prepare(`
        SELECT count 
        FROM inventory 
        WHERE group_id = ? AND user_id = ? AND item_id = ?
    `).get(this.groupId, this.userId, itemId);

    if (!row) return 0;
    return isUniqueFishingEquipmentId(itemId) ? Math.min(1, row.count) : row.count;
  }

  getCurrentSize() {
    const rows = db.prepare(`
        SELECT item_id, count
        FROM inventory 
        WHERE group_id = ? AND user_id = ?
    `).all(this.groupId, this.userId);

    return rows.reduce((total, row) => (
      total + (isUniqueFishingEquipmentId(row.item_id) ? Math.min(1, row.count) : row.count)
    ), 0);
  }

  _clearUniqueEquipmentState(itemId) {
    if (String(itemId).startsWith("rod_")) {
      db.prepare(`
          DELETE FROM rod_stats
          WHERE group_id = ? AND user_id = ? AND rod_id = ?
      `).run(this.groupId, this.userId, itemId);
      db.prepare(`
          UPDATE fishing_stats
          SET rod = CASE WHEN rod = ? THEN NULL ELSE rod END
          WHERE group_id = ? AND user_id = ?
      `).run(itemId, this.groupId, this.userId);
    } else if (String(itemId).startsWith("line_")) {
      db.prepare(`
          UPDATE fishing_stats
          SET line = CASE WHEN line = ? THEN NULL ELSE line END
          WHERE group_id = ? AND user_id = ?
      `).run(itemId, this.groupId, this.userId);
    }
  }

  async addItem(itemId, count = 1) {
    const safeCount = Number(count);
    if (!Number.isSafeInteger(safeCount) || safeCount <= 0) {
      return { success: false, msg: "物品数量必须是正整数" };
    }
    const uniqueEquipment = isUniqueFishingEquipmentId(itemId);
    if (uniqueEquipment && safeCount !== 1) {
      return { success: false, msg: "同型号鱼竿或鱼线只能持有一件" };
    }

    const transaction = db.transaction(() => {
      if (uniqueEquipment && this.getItemCount(itemId) > 0) {
        return { success: false, msg: "同型号鱼竿或鱼线只能持有一件" };
      }
      const maxCapacity = this.economyManager.getBagCapacity(this.e);
      const currentSize = this.getCurrentSize();
      if (currentSize + safeCount > maxCapacity) {
        return {
          success: false,
          msg: `背包空间不足！当前剩余空间：${Math.max(0, maxCapacity - currentSize)}，需要空间：${safeCount}`,
        };
      }

      db.prepare(`
          INSERT INTO inventory (group_id, user_id, item_id, count)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(group_id, user_id, item_id)
          DO UPDATE SET count = count + ?
      `).run(this.groupId, this.userId, itemId, safeCount, safeCount);
      return { success: true, msg: "添加成功" };
    });

    return transaction.immediate();
  }

  async forceAddItem(itemId, count = 1) {
    const safeCount = Number(count);
    if (!Number.isSafeInteger(safeCount) || safeCount <= 0) return false;
    if (isUniqueFishingEquipmentId(itemId)) {
      if (safeCount !== 1) return false;
      const inserted = db.prepare(`
          INSERT INTO inventory (group_id, user_id, item_id, count)
          VALUES (?, ?, ?, 1)
          ON CONFLICT(group_id, user_id, item_id) DO NOTHING
      `).run(this.groupId, this.userId, itemId);
      return inserted.changes === 1;
    }
    db.prepare(`
        INSERT INTO inventory (group_id, user_id, item_id, count)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(group_id, user_id, item_id) 
        DO UPDATE SET count = count + ?
    `).run(this.groupId, this.userId, itemId, safeCount, safeCount);

    return true;
  }

  removeItem(itemId, count = 1) {
    const safeCount = Number(count);
    if (!Number.isSafeInteger(safeCount) || safeCount <= 0) return false;
    const uniqueEquipment = isUniqueFishingEquipmentId(itemId);
    if (uniqueEquipment && safeCount !== 1) return false;

    const transaction = db.transaction(() => {
      const result = uniqueEquipment
        ? db.prepare(`
            DELETE FROM inventory
            WHERE group_id = ? AND user_id = ? AND item_id = ? AND count > 0
        `).run(this.groupId, this.userId, itemId)
        : db.prepare(`
            UPDATE inventory
            SET count = count - ?
            WHERE group_id = ? AND user_id = ? AND item_id = ? AND count >= ?
        `).run(safeCount, this.groupId, this.userId, itemId, safeCount);

      if (result.changes !== 1) return false;
      if (uniqueEquipment) {
        this._clearUniqueEquipmentState(itemId);
      } else {
        db.prepare(`
            DELETE FROM inventory
            WHERE group_id = ? AND user_id = ? AND item_id = ? AND count <= 0
        `).run(this.groupId, this.userId, itemId);
      }
      return true;
    });

    return transaction();
  }

  exchangeItem(inputItemId, inputCount, outputItemId, outputCount, { allowOverflow = false } = {}) {
    const safeInputCount = Number(inputCount);
    const safeOutputCount = Number(outputCount);
    if (
      !Number.isSafeInteger(safeInputCount) || safeInputCount <= 0 ||
      !Number.isSafeInteger(safeOutputCount) || safeOutputCount <= 0
    ) {
      return { success: false, msg: "物品数量异常" };
    }
    const uniqueInput = isUniqueFishingEquipmentId(inputItemId);
    const uniqueOutput = isUniqueFishingEquipmentId(outputItemId);
    if ((uniqueInput && safeInputCount !== 1) || (uniqueOutput && safeOutputCount !== 1)) {
      return { success: false, msg: "同型号鱼竿或鱼线只能持有一件" };
    }

    const transaction = db.transaction(() => {
      const owned = this.getItemCount(inputItemId);
      if (owned < safeInputCount) {
        return { success: false, msg: "用于兑换的物品不足" };
      }

      const capacity = this.economyManager.getBagCapacity(this.e);
      const currentSize = this.getCurrentSize();
      const projectedSize = currentSize - safeInputCount + safeOutputCount;
      if (!allowOverflow && projectedSize > capacity) {
        return {
          success: false,
          msg: `背包空间不足！当前剩余空间：${Math.max(0, capacity - currentSize)}`,
        };
      }

      if (
        uniqueOutput &&
        outputItemId !== inputItemId &&
        this.getItemCount(outputItemId) > 0
      ) {
        return { success: false, msg: "同型号鱼竿或鱼线只能持有一件" };
      }

      const removed = uniqueInput
        ? db.prepare(`
            DELETE FROM inventory
            WHERE group_id = ? AND user_id = ? AND item_id = ? AND count > 0
        `).run(this.groupId, this.userId, inputItemId)
        : db.prepare(`
            UPDATE inventory
            SET count = count - ?
            WHERE group_id = ? AND user_id = ? AND item_id = ? AND count >= ?
        `).run(safeInputCount, this.groupId, this.userId, inputItemId, safeInputCount);
      if (removed.changes !== 1) {
        return { success: false, msg: "用于兑换的物品不足" };
      }
      if (uniqueInput) {
        this._clearUniqueEquipmentState(inputItemId);
      } else {
        db.prepare(`
            DELETE FROM inventory
            WHERE group_id = ? AND user_id = ? AND item_id = ? AND count <= 0
        `).run(this.groupId, this.userId, inputItemId);
      }
      if (uniqueOutput) {
        const inserted = db.prepare(`
            INSERT INTO inventory (group_id, user_id, item_id, count)
            VALUES (?, ?, ?, 1)
            ON CONFLICT(group_id, user_id, item_id) DO NOTHING
        `).run(this.groupId, this.userId, outputItemId);
        if (inserted.changes !== 1) {
          throw new Error(`唯一装备重复写入: ${outputItemId}`);
        }
      } else {
        db.prepare(`
            INSERT INTO inventory (group_id, user_id, item_id, count)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(group_id, user_id, item_id)
            DO UPDATE SET count = count + ?
        `).run(this.groupId, this.userId, outputItemId, safeOutputCount, safeOutputCount);
      }

      return { success: true, msg: "兑换成功" };
    });

    return transaction.immediate();
  }

  convertItemRandomly(inputItemId, conversionCount, outputItemIds, random = Math.random) {
    const sourceItemId = String(inputItemId || "").trim();
    const safeConversionCount = Number(conversionCount);
    const requiredInputCount = safeConversionCount * 2;
    if (
      !sourceItemId ||
      !Number.isSafeInteger(safeConversionCount) || safeConversionCount <= 0 ||
      !Number.isSafeInteger(requiredInputCount)
    ) {
      return { success: false, msg: "重铸数量异常" };
    }
    if (isUniqueFishingEquipmentId(sourceItemId)) {
      return { success: false, msg: "鱼竿和鱼线不能重铸" };
    }

    const candidates = [...new Set(
      (Array.isArray(outputItemIds) ? outputItemIds : [])
        .map((itemId) => String(itemId || "").trim())
        .filter((itemId) => itemId && itemId !== sourceItemId),
    )];
    if (
      candidates.length === 0 ||
      candidates.some((itemId) => isUniqueFishingEquipmentId(itemId)) ||
      typeof random !== "function"
    ) {
      return { success: false, msg: "重铸奖池配置异常" };
    }

    const transaction = db.transaction(() => {
      if (this.getItemCount(sourceItemId) < requiredInputCount) {
        return { success: false, msg: "用于重铸的道具不足" };
      }

      const removed = db.prepare(`
          UPDATE inventory
          SET count = count - ?
          WHERE group_id = ? AND user_id = ? AND item_id = ? AND count >= ?
      `).run(
        requiredInputCount,
        this.groupId,
        this.userId,
        sourceItemId,
        requiredInputCount,
      );
      if (removed.changes !== 1) {
        return { success: false, msg: "用于重铸的道具不足" };
      }
      db.prepare(`
          DELETE FROM inventory
          WHERE group_id = ? AND user_id = ? AND item_id = ? AND count <= 0
      `).run(this.groupId, this.userId, sourceItemId);

      const rewards = new Map();
      for (let index = 0; index < safeConversionCount; index++) {
        const rawRoll = Number(random());
        const roll = Number.isFinite(rawRoll)
          ? Math.max(0, Math.min(0.999999999999, rawRoll))
          : 0;
        const rewardItemId = candidates[Math.floor(roll * candidates.length)];
        rewards.set(rewardItemId, (rewards.get(rewardItemId) || 0) + 1);
      }

      const insertReward = db.prepare(`
          INSERT INTO inventory (group_id, user_id, item_id, count)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(group_id, user_id, item_id)
          DO UPDATE SET count = count + ?
      `);
      for (const [rewardItemId, count] of rewards) {
        insertReward.run(this.groupId, this.userId, rewardItemId, count, count);
      }

      // 固定为 2N -> N，总占用必定下降 N；即使重铸前已经超容也应允许自救。
      return {
        success: true,
        msg: "重铸成功",
        inputCount: requiredInputCount,
        outputCount: safeConversionCount,
        outputs: Object.fromEntries(rewards),
      };
    });

    return transaction.immediate();
  }
}
