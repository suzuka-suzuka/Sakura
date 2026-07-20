import EconomyManager from "../lib/economy/EconomyManager.js";
import EconomyImageGenerator from "../lib/economy/ImageGenerator.js";
import ShopManager from "../lib/economy/ShopManager.js";
import InventoryManager from "../lib/economy/InventoryManager.js";
import FishingManager from "../lib/economy/FishingManager.js";
import FishingUiImageGenerator from "../lib/economy/FishingUiImageGenerator.js";
import ChestManager from "../lib/economy/ChestManager.js";
import EconomyOperations from "../lib/economy/EconomyOperations.js";
import {
  getShanghaiDateKey,
  getStartOfShanghaiDay,
  getStartOfShanghaiWeek,
  secondsUntilNextShanghaiDay,
} from "../lib/economy/time.js";
import {
  canUseTransfer,
  getReviveCoinPolicy,
  TRANSFER_UNLOCK_FISHING_LEVEL,
} from "../lib/economy/rules.js";
import { FISHING_BENEFIT_DURATION_SECONDS } from "../lib/fishing/rules.js";
import _ from "lodash";
import Setting from "../lib/setting.js";

export default class Economy extends plugin {
  constructor() {
    super({
      name: "经济系统",
      event: "message.group",
      priority: 1135,
    });
  }

  get appconfig() {
    return Setting.getConfig("economy");
  }

  checkWhitelist(e) {
    const config = this.appconfig;
    if (!config) return false;
    const groups = config.gamegroups || [];
    if (groups.length === 0) return false;
    return groups.some((g) => String(g) === String(e.group_id));
  }

  cleanupTransactionLogs = Cron("0 4 * * *", async () => {
    const deleted = EconomyManager.cleanupTransactions(7);
    if (deleted > 0) {
      logger.info(`[经济系统] 已清理 ${deleted} 条 7 天前的流水记录`);
    }
    const deletedClaims = EconomyManager.cleanupDailyClaims(30);
    if (deletedClaims > 0) {
      logger.info(`[经济系统] 已清理 ${deletedClaims} 条过期每日领取记录`);
    }
  });

  getStartOfToday() {
    return getStartOfShanghaiDay();
  }

  getStartOfWeek() {
    return getStartOfShanghaiWeek();
  }

  formatTransactionTime(timestamp) {
    return new Date(Number(timestamp)).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "2-digit",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  formatTransactionAction(row) {
    if (row.note) return row.note;
    if (row.target_user_id) return `${row.type}：${row.target_user_id}`;
    return row.type;
  }

  transactionLog = Command(/^#?(?:查)?流水(?:.*)$/i, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    const targetId = e.at && e.isMaster ? String(e.at) : String(e.user_id);
    const text = String(e.msg || "").replace(/\[CQ:at[^\]]+\]/g, "").trim();
    const pageMatch = text.match(/(?:第)?(\d+)(?:页)?\s*$/);
    const page = Math.max(1, Number(pageMatch?.[1]) || 1);
    const pageSize = 20;

    const economyManager = new EconomyManager(e);
    const rows = economyManager.getTransactions(e, {
      userId: targetId,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    if (rows.length === 0) {
      await e.reply(page > 1 ? `第 ${page} 页没有流水记录。` : "当前没有流水记录。", 10);
      return true;
    }

    let targetName = targetId;
    try {
      const info = await e.getInfo(targetId);
      if (info) {
        targetName = info.card || info.nickname || targetId;
      }
    } catch (err) {}

    const title = String(targetId) === String(e.user_id)
      ? `你的樱花币流水（第 ${page} 页）`
      : `${targetName}的樱花币流水（第 ${page} 页）`;
    const generator = new EconomyImageGenerator();
    const image = await generator.generateTransactionImage({
      title,
      subtitle: "按时间倒序显示，最多 20 条记录",
      footer: "仅保留最近 7 天流水，正数为收入，负数为支出",
      records: rows.map(row => ({
        time: this.formatTransactionTime(row.created_at),
        action: this.formatTransactionAction(row),
        amount: row.amount,
      })),
    });

    await e.reply(segment.image(image));
    return true;
  });

  todayTransactionAnalysis = Command(/^#?今日流水分析$/i, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    return await this.sendTransactionAnalysis(e, "today");
  });

  weekTransactionAnalysis = Command(/^#?本周流水分析$/i, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    return await this.sendTransactionAnalysis(e, "week");
  });

  async sendTransactionAnalysis(e, range) {
    const targetId = e.at && e.isMaster ? String(e.at) : String(e.user_id);
    const since = range === "week" ? this.getStartOfWeek() : this.getStartOfToday();
    const until = Date.now();

    const economyManager = new EconomyManager(e);
    const analysis = economyManager.getTransactionAnalysis(e, {
      userId: targetId,
      since,
      until,
    });

    if (analysis.count === 0) {
      await e.reply(range === "week" ? "本周还没有流水记录。" : "今天还没有流水记录。", 10);
      return true;
    }

    let targetName = targetId;
    try {
      const info = await e.getInfo(targetId);
      if (info) {
        targetName = info.card || info.nickname || targetId;
      }
    } catch (err) {}

    const isSelf = String(targetId) === String(e.user_id);
    const rangeTitle = range === "week" ? "本周流水分析" : "今日流水分析";
    const title = isSelf ? `你的${rangeTitle}` : `${targetName}的${rangeTitle}`;
    const generator = new EconomyImageGenerator();
    const image = await generator.generateTransactionAnalysisImage({
      title,
      subtitle: range === "week" ? "统计本周一至当前时间" : "统计今日 0 点至当前时间",
      ...analysis,
    });

    await e.reply(segment.image(image));
    return true;
  }

  addCoinsToOther = Command(/^\s*#?(添加|增加|给予)[樱桜]花币\s*(\d+)$/i, "master",  async (e) => {
    if (!this.checkWhitelist(e)) return false;

    const targetId = e.at;
    if (!targetId) {
      return false
    }

    const amount = parseInt(e.msg.replace(/[^0-9]/ig, ""), 10);
    if (!amount || amount <= 0) {
      return false;
    }

    const economyManager = new EconomyManager(e);
    const added = economyManager.addCoins(
      { user_id: targetId, group_id: e.group_id },
      amount,
      { type: "收入", note: "主人添加樱花币", targetUserId: e.user_id }
    );
    if (!added) {
      await e.reply("添加失败，金额或账户状态异常。", 10);
      return true;
    }

    let targetName = targetId;
    try {
      if (e.getInfo) {
        const info = await e.getInfo(targetId);
        if (info) {
          targetName = info.card || info.nickname || targetId;
        }
      }
    } catch (err) {}

    await e.reply(`🌸 伟大的神明已恩赐，成功为 ${targetName} 增加了 ${amount} 樱花币！`);
    return true;
  });

  shopList = Command(/^#?(商店|商城|樱神社商店|神社商店)$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    const shopManager = new ShopManager();
    const economyManager = new EconomyManager(e);
    const balance = economyManager.getCoins(e);
    const categories = Object.entries(shopManager.getAllCategories()).map(
      ([id, category]) => ({ id, ...category }),
    );
    const itemCount = categories.reduce(
      (sum, category) => sum + (Array.isArray(category.items) ? category.items.length : 0),
      0,
    );
    const nickname = e.sender?.card || e.sender?.nickname || String(e.user_id);

    try {
      const generator = new FishingUiImageGenerator();
      const pages = await generator.generateShopPages({ nickname, balance, categories });
      await e.sendForwardMsg(
        pages.map((page) => segment.image(page.buffer)),
        {
          prompt: `🏪 查看樱神社商店（${pages.length}页）`,
          news: [
            { text: `💰 当前余额：${balance} 樱花币` },
            { text: `📦 共 ${itemCount} 种商品` },
          ],
          source: "樱神社商店",
        },
      );
    } catch (err) {
      logger.error(`[商店] 生成商店图片失败: ${err.stack || err}`);
      await e.reply("商店图片生成失败，请稍后再试。", 10);
    }
    return true;
  });

  buyItem = Command(/^#?(购买|兑换)\s*(\S+)\s*(\d*)$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    const shopManager = new ShopManager();
    const itemName = e.match[2].trim();
    const count = parseInt(e.match[3]) || 1;
    const result = await shopManager.buyItem(e, itemName, count);
    if (!result.success && !shopManager.findItemByName(itemName)) {
      return false;
    }
    await e.reply(result.msg);
    return true;
  });

  myBag = Command(/^#?(我的)?背包$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    const inventoryManager = new InventoryManager(e);
    const inventory = inventoryManager.getInventory();
    const economyManager = new EconomyManager(e);
    const capacity = economyManager.getBagCapacity(e);
    const currentSize = inventoryManager.getCurrentSize();
    const level = economyManager.getBagLevel(e);

    const shopManager = new ShopManager();
    const fishingManager = new FishingManager(e.group_id);
    const balance = economyManager.getCoins(e);
    const equippedRodId = fishingManager.getEquippedRod(e.user_id);
    const equippedLineId = fishingManager.getEquippedLine(e.user_id);
    const equippedBaitId = fishingManager.getEquippedBait(e.user_id);
    const handlerOrder = [
      "fishing_rod",
      "fishing_line",
      "fishing_bait",
      "fishing_torpedo",
      "fishing_special",
      "fishing_chest",
    ];

    const items = Object.entries(inventory).map(([itemId, count]) => {
      const item = shopManager.findItemById(itemId) || shopManager.findItemByName(itemId);
      let handler = item?.handler;
      if (!handler && itemId.startsWith("rod_")) handler = "fishing_rod";
      else if (!handler && itemId.startsWith("line_")) handler = "fishing_line";
      else if (!handler && itemId.startsWith("bait_")) handler = "fishing_bait";
      else if (!handler && itemId.startsWith("chest_")) handler = "fishing_chest";
      else if (!handler && itemId === "torpedo") handler = "fishing_torpedo";
      else if (!handler) handler = "fishing_special";

      const entry = {
        id: item?.id || itemId,
        name: item?.name || itemId,
        description: item?.description || "尚未收录说明的物品",
        icon: item?.icon,
        type: item?.type,
        handler,
        count,
        bossBait: Boolean(item?.boss_bait),
        equipped: itemId === equippedRodId || itemId === equippedLineId || itemId === equippedBaitId,
      };

      if (itemId.startsWith("rod_")) {
        const durability = fishingManager.getRodDurabilityInfo(e.user_id, itemId);
        entry.kind = "rod";
        entry.mastery = fishingManager.getRodMastery(e.user_id, itemId);
        entry.durability = {
          current: durability.currentDurability,
          max: durability.maxDurability,
        };
      } else if (itemId.startsWith("line_")) {
        const durability = fishingManager.getLineDurabilityInfo(e.user_id, itemId);
        entry.kind = "line";
        entry.durability = {
          current: durability.currentDurability,
          max: durability.maxDurability,
        };
      }
      return entry;
    }).sort((left, right) => {
      if (left.equipped !== right.equipped) return left.equipped ? -1 : 1;
      return handlerOrder.indexOf(left.handler) - handlerOrder.indexOf(right.handler);
    });

    const nickname = e.sender?.card || e.sender?.nickname || String(e.user_id);
    try {
      const generator = new FishingUiImageGenerator();
      const pages = await generator.generateInventoryPages({
        nickname,
        avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${e.user_id}&s=640`,
        balance,
        bagLevel: level,
        currentSize,
        capacity,
        items,
      });
      await e.sendForwardMsg(
        pages.map((page) => segment.image(page.buffer)),
        {
          prompt: `🎒 查看我的背包（${pages.length}页）`,
          news: [
            { text: `📦 ${items.length} 种物品 · 容量 ${currentSize}/${capacity}` },
            { text: `💰 当前余额：${balance} 樱花币` },
          ],
          source: `${nickname} 的背包`,
        },
      );
    } catch (err) {
      logger.error(`[背包] 生成背包图片失败: ${err.stack || err}`);
      await e.reply("背包图片生成失败，请稍后再试。", 10);
    }
    return true;
  });

  upgradeBag = Command(/^#?升级背包$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    const economyManager = new EconomyManager(e);
    const result = economyManager.upgradeBag(e);
    await e.reply(result.msg);
    return true;
  });

  myStatus = Command(/^#?((我|咱)的(信息|等级|资产))$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    const economyManager = new EconomyManager(e);
    const coins = economyManager.getCoins(e);

    const userData = {
      userId: e.user_id,
      nickname: e.sender.card || e.sender.nickname || e.user_id,
      avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${e.user_id}&s=640`,
      coins,
    };

    try {
      const generator = new EconomyImageGenerator();
      const image = await generator.generateStatusImage(userData);
      await e.reply(segment.image(image));
    } catch (err) {
      logger.error(`生成个人信息图片失败: ${err}`);
      await e.reply("Miko正在睡觉，无法生成图片，请稍后再试~", 10);
    }
    return true;
  });

  transfer = Command(/^#?(转账|投喂)\s*(\d+).*$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    const amount = parseInt(e.match[2]);
    const targetId = e.at;

    if (!targetId) {
      return false;
    }

    if (String(targetId) === String(e.user_id)) {
      return false;
    }

    if (amount <= 0) {
      return false;
    }

    const fishingManager = new FishingManager(e.group_id);
    const fishingLevel = fishingManager.getUserFishingLevel(e.user_id);
    if (!canUseTransfer(fishingLevel)) {
      await e.reply(
        `转账功能将在钓鱼 Lv.${TRANSFER_UNLOCK_FISHING_LEVEL} 开放，你当前为 Lv.${fishingLevel}。`,
        10,
      );
      return true;
    }

    const economyManager = new EconomyManager(e);
    const fromCoins = economyManager.getCoins(e);

    if (fromCoins < amount) {
      await e.reply(`余额不足！无法投喂~`, 10);
      return true;
    }

    const feePercent = _.random(0, 10);
    const totalFee = 10 + Math.round(amount * (feePercent / 100));
    
    const actualTransfer = amount - totalFee;
    const actualFee = totalFee;
    
    if (totalFee >= amount) {
      await e.reply("转账金额必须高于本次手续费，请增加金额后重试~", 10);
      return true;
    }

    const creditEntries = [];
    if (actualTransfer > 0) {
      creditEntries.push({
        e: { user_id: targetId, group_id: e.group_id },
        amount: actualTransfer,
      });
    }

    if (actualFee > 0) {
      creditEntries.push({
        e: { user_id: e.self_id, group_id: e.group_id },
        amount: actualFee,
      });
    }

    const transferSuccess = economyManager.spendCoins(e, amount, creditEntries.map((entry) => ({
      ...entry,
      type: String(entry.e.user_id) === String(targetId) ? "转账收入" : "手续费收入",
      note: String(entry.e.user_id) === String(targetId) ? "转账" : "转账手续费",
    })), {
      type: "转账支出",
      note: actualFee > 0 ? `转账，手续费 ${actualFee}` : "转账",
      targetUserId: targetId,
    });
    if (!transferSuccess) {
      await e.reply(`余额不足！无法投喂~`, 10);
      return true;
    }

    const senderCoins = economyManager.getCoins(e);
    const receiverCoins = economyManager.getCoins({ user_id: targetId, group_id: e.group_id });

    let fromNickname = e.sender.card || e.sender.nickname || e.user_id;
    let toNickname = targetId;
    try {
      const info = await e.getInfo(targetId);
      if (info) {
        toNickname = info.card || info.nickname || targetId;
      }
    } catch (err) {}

    const data = {
      sender: {
        id: e.user_id,
        nickname: String(fromNickname),
        avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${e.user_id}&s=640`,
        coins: senderCoins
      },
      receiver: {
        id: targetId,
        nickname: String(toNickname),
        avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${targetId}&s=640`,
        coins: receiverCoins
      },
      amount: actualTransfer,
      fee: actualFee,
      time: new Date().toISOString()
    };

    try {
      const generator = new EconomyImageGenerator();
      const image = await generator.generateTransferImage(data);
      await e.reply(segment.image(image));
    } catch (err) {
      logger.error(`生成转账图片失败: ${err}`);
      await e.reply(`💰 转账${actualTransfer > 0 ? '成功' : '失败'}！\n实际转账：${actualTransfer} 樱花币\n手续费：${actualFee} 樱花币`);
    }
    return true;
  });

  sell = Command(/^#?出售\s*(\S+).*$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    const itemName = e.match[1].trim();
    const shopManager = new ShopManager();
    const inventoryManager = new InventoryManager(e);

    const item = shopManager.findShopItemByName(itemName) || shopManager.findShopItemById(itemName);
    if (!item || item.type !== 'equipment') return false;

    const fishingSessionKey = `sakura:fishing:session:${e.group_id}:${e.user_id}`;
    if (await redis.exists(fishingSessionKey)) {
      await e.reply("钓鱼过程中不能出售装备，请先完成本次钓鱼。", 10);
      return true;
    }

    const itemId = item.id || itemName;
    if (inventoryManager.getItemCount(itemId) < 1) {
      await e.reply(`你没有【${item.name}】，无法出售~`, 10);
      return true;
    }

    let sellPrice = Math.floor(item.price * 0.8);
    let durabilityMsg = "";
    
    const fishingManager = new FishingManager(e.group_id);
    const rodConfig = fishingManager.getRodConfig(itemId);
    const lineConfig = fishingManager.getLineConfig(itemId);

    if (rodConfig) {
      const durabilityInfo = fishingManager.getRodDurabilityInfo(e.user_id, itemId);
      if (durabilityInfo.maxDurability > 0) {
        const ratio = durabilityInfo.currentDurability / durabilityInfo.maxDurability;
        sellPrice = Math.floor(sellPrice * ratio);
        durabilityMsg = `(耐久:${Math.floor(ratio * 100)}%)`;
      }
    } else if (lineConfig) {
      const durabilityInfo = fishingManager.getLineDurabilityInfo(e.user_id, itemId);
      if (durabilityInfo.maxDurability > 0) {
        const ratio = durabilityInfo.currentDurability / durabilityInfo.maxDurability;
        sellPrice = Math.floor(sellPrice * ratio);
        durabilityMsg = `(耐久:${Math.floor(ratio * 100)}%)`;
      }
    }

    const result = new EconomyOperations(e).sellItem({
      itemId,
      price: sellPrice,
      itemName: item.name,
      equipmentSlot: item.handler === "fishing_rod"
        ? "rod"
        : item.handler === "fishing_line" ? "line" : null,
    });
    if (!result.success) {
      await e.reply("出售失败，请稍后再试~", 10);
      return true;
    }

    await e.reply(
      `💰 成功出售【${item.name}】${durabilityMsg}！\n💵 获得 ${sellPrice} 樱花币`
    );
    return true;
  });

  useItem = Command(/^#?使用\s*(\S+)$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    const itemName = e.match[1].trim();
    const shopManager = new ShopManager();
    const item = shopManager.findItemByName(itemName);

    if (!item) return false;

    if (ChestManager.isChestItem(item)) {
      return await this.openChestFlow(e, item);
    }

    const inventoryManager = new InventoryManager(e);
    const fishingManager = new FishingManager(e.group_id);
    const groupId = e.group_id;
    const userId = e.user_id;

    if (!item.activation_message && !item.instant_effect) {
      return false;
    }

    if (inventoryManager.getItemCount(item.id) < 1) {
      await e.reply(`你没有【${itemName}】，无法使用~`, 10);
      return true;
    }

    if (item.instant_effect) {
      return await this.applyInstantItem(e, item, { inventoryManager, fishingManager });
    }

    const buffKey = `sakura:fishing:buff:${item.id}:${groupId}:${userId}`;
    
    if (!inventoryManager.removeItem(item.id, 1)) {
      await e.reply(`你没有【${itemName}】，无法使用~`, 10);
      return true;
    }
    const duration = item.duration || FISHING_BENEFIT_DURATION_SECONDS;
    try {
      await redis.set(buffKey, String(Date.now()), "EX", duration);
    } catch (err) {
      await inventoryManager.forceAddItem(item.id, 1);
      logger.error(`[经济系统] 激活道具失败，已返还物品: ${err.stack || err}`);
      await e.reply("道具激活失败，物品已经返还，请稍后重试。", 10);
      return true;
    }
    
    await e.reply(item.activation_message);
    return true;
  });

  // 即时生效道具：先做前置校验（不满足不消耗），再扣道具、结算效果
  async applyInstantItem(e, item, { inventoryManager, fishingManager }) {
    const userId = e.user_id;

    switch (item.instant_effect) {
      case "restore_stamina": {
        const status = fishingManager.getFishingStaminaStatus(userId);
        if (status.current >= status.max) {
          await e.reply(`⚡ 体力已满，不需要使用【${item.name}】~`, 10);
          return true;
        }
        if (!inventoryManager.removeItem(item.id, 1)) {
          await e.reply(`你没有【${item.name}】，无法使用~`, 10);
          return true;
        }
        const amount = Math.max(1, Math.floor(Number(item.amount) || 1));
        const restored = fishingManager.restoreFishingStamina(userId, amount);
        await e.reply(
          `🍡 使用了【${item.name}】！\n⚡ 体力恢复 ${restored.recovered} 点，当前 ${restored.current}/${restored.max}`,
        );
        return true;
      }

      case "repair_rod": {
        const rodId = fishingManager.getEquippedRod(userId);
        const rodConfig = rodId ? fishingManager.getRodConfig(rodId) : null;
        if (!rodConfig) {
          await e.reply("🎣 还没有装备鱼竿，无法修理~", 10);
          return true;
        }
        const durability = fishingManager.getRodDurabilityInfo(userId, rodId);
        if (durability.damage <= 0) {
          await e.reply(`🔧 【${rodConfig.name}】完好无损，不需要修理~`, 10);
          return true;
        }
        if (!inventoryManager.removeItem(item.id, 1)) {
          await e.reply(`你没有【${item.name}】，无法使用~`, 10);
          return true;
        }
        fishingManager.clearRodDamage(userId, rodId);
        await e.reply(
          `🔧 使用了【${item.name}】！\n🎣 【${rodConfig.name}】焕然一新，耐久完全恢复！`,
        );
        return true;
      }

      case "clear_curse": {
        const afflictions = fishingManager.getCleansableNightmareAfflictions(userId);
        if (afflictions.total <= 0) {
          await e.reply("☀️ 你身上没有诅咒，圣水还是留着以后用吧~", 10);
          return true;
        }
        if (!inventoryManager.removeItem(item.id, 1)) {
          await e.reply(`你没有【${item.name}】，无法使用~`, 10);
          return true;
        }
        const result = fishingManager.clearNightmareCurse(userId);
        const cleared = [
          result.curseLayers > 0 ? `${result.curseLayers} 层噩梦诅咒` : "",
          result.brideThreadLayers > 0 ? `${result.brideThreadLayers} 层冥婚红线` : "",
          result.lostSoul ? "失魂状态" : "",
        ].filter(Boolean).join("、");
        await e.reply(
          `💧 使用了【${item.name}】！\n☀️ ${cleared}被彻底洗净！`,
        );
        return true;
      }

      case "star_wish": {
        const wishKey = `sakura:fishing:wish:${e.group_id}:${userId}`;
        if (await redis.exists(wishKey)) {
          await e.reply("⭐ 你已经许过愿了，先把这一竿钓完吧~", 10);
          return true;
        }
        if (!inventoryManager.removeItem(item.id, 1)) {
          await e.reply(`你没有【${item.name}】，无法使用~`, 10);
          return true;
        }
        try {
          await redis.set(
            wishKey,
            "传说",
            "EX",
            FISHING_BENEFIT_DURATION_SECONDS,
          );
        } catch (err) {
          await inventoryManager.forceAddItem(item.id, 1);
          logger.error(`[经济系统] 写入星愿失败，已返还物品: ${err.stack || err}`);
          await e.reply("许愿失败，物品已经返还，请稍后重试。", 10);
          return true;
        }
        await e.reply(
          `🌠 你对着瓶中的流星许下心愿……\n⭐ 30分钟内的下一竿必定咬钩传说稀有度的鱼！`,
        );
        return true;
      }

      default:
        logger.warn(`[经济系统] 未知的即时道具效果: ${item.id} -> ${item.instant_effect}`);
        await e.reply("这个道具的效果配置有误，请联系管理员。", 10);
        return true;
    }
  }

  openChest = Command(/^#?开(?:启)?宝箱\s*(.*)$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    const chestManager = new ChestManager(e);
    const arg = (e.match[1] || "").trim();

    if (arg) {
      const chestItem = chestManager.findChestByName(arg);
      if (!chestItem) {
        const names = chestManager.getChestItems().map((item) => item.name).join("、");
        await e.reply(`没有叫【${arg}】的宝箱~\n钓点宝箱：${names}`, 10);
        return true;
      }
      return await this.openChestFlow(e, chestItem);
    }

    const owned = chestManager.listOwnedChests();
    if (owned.length === 0) {
      await e.reply("🎒 背包里没有宝箱~\n去各钓点垂钓，钓上宝藏稀有度渔获就是当地专属宝箱！", 10);
      return true;
    }
    if (owned.length === 1) {
      return await this.openChestFlow(e, owned[0].item);
    }

    const list = owned.map(({ item, count }) => `【${item.name}】×${count}`).join("、");
    await e.reply(`🎒 你有多种宝箱：${list}\n发送「#开宝箱 名称」指定要开的箱子~`, 10);
    return true;
  });

  async openChestFlow(e, chestItem) {
    const chestManager = new ChestManager(e);
    if (chestManager.inventoryManager.getItemCount(chestItem.id) < 1) {
      await e.reply(`你没有【${chestItem.name}】~\n去对应钓点钓一个吧！`, 10);
      return true;
    }

    const result = chestManager.openChest(chestItem);
    if (!result.success) {
      if (result.reason === "bag_full") {
        await e.reply(`🎒 ${result.msg || "背包空间不足"}\n先清理背包再开箱吧~`, 10);
      } else if (result.reason === "bad_config") {
        await e.reply("宝箱的掉落配置有误，请联系管理员。", 10);
      } else if (result.reason === "grant_failed") {
        await e.reply("开箱失败，宝箱已放回背包，请稍后再试~", 10);
      } else if (result.reason === "retry") {
        await e.reply("开箱奖励状态刚刚发生变化，请重新开启一次~", 10);
      } else {
        await e.reply(`你没有【${chestItem.name}】~`, 10);
      }
      return true;
    }

    const remaining = chestManager.inventoryManager.getItemCount(chestItem.id);
    const remainMsg = remaining > 0 ? `\n📦 背包里还有 ${remaining} 个【${chestItem.name}】` : "";

    if (result.type === "coins") {
      if (result.treasureName) {
        await e.reply(
          `🗝️ 打开了【${chestItem.name}】！\n` +
          `✨ 开出了【${result.treasureName}】！\n` +
          (result.treasureDescription ? `📝 ${result.treasureDescription}\n` : "") +
          `💰 已变卖入账 ${result.amount} 樱花币${remainMsg}`,
        );
      } else {
        await e.reply(
          `🗝️ 打开了【${chestItem.name}】！\n💰 开出了 ${result.amount} 樱花币！${remainMsg}`,
        );
      }
      return true;
    }

    if (result.type === "item") {
      const prefix = result.isRandomBait
        ? "🪱 摸出一把随机鱼饵——"
        : result.isRandomLine
          ? "🧵 开出了一卷尚未拥有的鱼线——"
          : "✨ 获得了";
      await e.reply(
        `🗝️ 打开了【${chestItem.name}】！\n` +
        `${prefix}【${result.item.name}】×${result.count}！\n` +
        (result.item.description ? `📝 ${result.item.description}` : "") +
        (result.autoEquipped ? "\n🎣 当前没有装备鱼线，已自动装备。" : "") +
        remainMsg,
      );
      return true;
    }

    if (result.type === "curse") {
      await e.reply(
        `🗝️ 打开了【${chestItem.name}】……\n` +
        `😱 咔哒——箱中冲出一团怨灵！\n` +
        `☠️ 噩梦诅咒 +${result.layers} 层！\n` +
        `💰 慌乱中在箱底摸到 ${result.coins} 樱花币压惊${remainMsg}`,
      );
      return true;
    }

    return true;
  }

  reviveCoin = Command(/^#?领取复活币$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;

    const key = `sakura:economy:daily_revive:${e.group_id}:${e.user_id}`;
    const hasReceived = await redis.get(key);

    if (hasReceived) {
      await e.reply("你今天已经领取过复活币了，请明天再来吧~", 10);
      return true;
    }

    const economyManager = new EconomyManager(e);
    const fishingManager = new FishingManager(e.group_id);
    const policy = getReviveCoinPolicy(fishingManager.getUserFishingLevel(e.user_id));
    const now = Date.now();
    const claim = economyManager.claimDailyCoins(e, {
      claimType: "revive_coin",
      claimDate: getShanghaiDateKey(now),
      amount: policy.amount,
      note: "领取复活币",
      maxBalanceExclusive: policy.maxBalanceExclusive,
    });
    if (!claim.success) {
      if (claim.reason === "already_claimed") {
        await e.reply("你今天已经领取过复活币了，请明天再来吧~", 10);
      } else if (claim.reason === "ineligible") {
        await e.reply(
          `你当前钓鱼 Lv.${policy.fishingLevel}，余额低于 ${policy.maxBalanceExclusive} 樱花币时才能领取 ${policy.amount} 樱花币援助~`,
          10,
        );
      } else {
        await e.reply("领取失败，请稍后再试~", 10);
      }
      return true;
    }

    try {
      await redis.set(key, "1", "EX", secondsUntilNextShanghaiDay(now));
    } catch (err) {
      logger.warn(`[经济系统] 写入兼容领取标记失败: ${err.message}`);
    }

    await e.reply(
      `看你囊中羞涩，按钓鱼 Lv.${policy.fishingLevel} 的援助标准，偷偷塞给了你 ${policy.amount} 樱花币，希望能助你东山再起~`,
    );
    return true;
  });

  coinRanking = Command(/^#?(金币|樱花币|富豪|财富)(排行|榜)$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    return await this.generateRanking(e, "coins", "樱花币排行榜");
  });
  levelRanking = Command(/^#?(等级|经验|精英)(排行|榜)$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    return await this.generateRanking(e, "level", "等级排行榜");
  });

  async generateRanking(e, type, title) {
    const economyManager = new EconomyManager(e);
    const rankingList = economyManager.getRanking(type, 10);

    if (rankingList.length === 0) {
      await e.reply("暂时还没有人上榜哦~", 10);
      return true;
    }

    const list = await Promise.all(
      rankingList.map(async (item, index) => {
        let nickname = item.userId;
        try {
          const info = await e.getInfo(item.userId);
          if (info) {
            nickname = info.card || info.nickname || item.userId;
          }
        } catch (err) {}

        return {
          rank: index + 1,
          userId: item.userId,
          nickname: String(nickname),
          avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${item.userId}&s=640`,
          value: item[type],
        };
      })
    );

    const data = {
      title,
      list,
    };

    try {
      const generator = new EconomyImageGenerator();
      const image = await generator.generateRankingImage(data);
      await e.reply(segment.image(image));
    } catch (err) {
      logger.error(`生成排行榜图片失败: ${err}`);
      await e.reply("Miko正在睡觉，无法生成图片，请稍后再试~", 10);
    }
    return true;
  }
}
