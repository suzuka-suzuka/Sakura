import EconomyManager from "../lib/economy/EconomyManager.js";
import FishingManager from "../lib/economy/FishingManager.js";
import FishingImageGenerator from "../lib/economy/FishingImageGenerator.js";
import FishingUiImageGenerator from "../lib/economy/FishingUiImageGenerator.js";
import InventoryManager from "../lib/economy/InventoryManager.js";
import ShopManager from "../lib/economy/ShopManager.js";
import _ from "lodash";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pluginresources } from "../lib/path.js";
import Setting from "../lib/setting.js";
import FishingSettlementService from "../lib/fishing/SettlementService.js";
import {
  FISHING_ACTION,
  FishingSessionStore,
  FISHING_PHASE,
  parseFishingAction,
} from "../lib/fishing/session.js";
import {
  BOSS_ATTACK_INTERVAL_MS,
  BOSS_BAIT_ID,
  FISH_FIGHT_STATE,
  FISHING_BENEFIT_DURATION_SECONDS,
  FISHING_COOLDOWN_SECONDS,
  FISHING_LOCATIONS,
  RARITY_CONFIG,
  WEATHER_CONFIG,
  applyFishFightStateModifiers,
  calculateLegacyFishPrice,
  createProgressBar,
  getBossAttackCooldownRemaining,
  getBossFightTimeoutMs,
  getFishFightStateChangeDelay,
  getFishFightStateConfig,
  getFishingLocationConfig,
  getFishingLevelExp,
  getLostSoulRewardMultiplier,
  getWeatherByTime,
  isBossFish,
  isPerfectCatch,
  resolveBossAttack,
  resolveNightmareRarityAfflictions,
  rollFishExp,
  rollFishingBiteWaitMs,
  rollBossPlayerDamage,
  selectNextFishFightState,
  selectBossFromData,
  selectFishFromData,
  validateLegacyFishData,
} from "../lib/fishing/rules.js";
import {
  acquireRedisLock,
  completeFishingAttempt,
  releaseRedisLock,
} from "../lib/economy/redisAtomic.js";
import { getShanghaiHour, secondsUntilNextShanghaiDay } from "../lib/economy/time.js";

const fishingSessions = new FishingSessionStore();

let fishData = [];
try {
  const fishJsonPath = path.join(pluginresources, "fish", "fish.json");
  fishData = JSON.parse(fs.readFileSync(fishJsonPath, "utf8"));
  const validationErrors = validateLegacyFishData(fishData);
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.slice(0, 5).join("；"));
  }
} catch (err) {
  logger.error(`[钓鱼] 加载鱼类数据失败: ${err.message}`);
  fishData = [];
}

function applyRodDamage(fishingManager, userId, rodConfig, damage) {
  const result = fishingManager.damageRod(userId, rodConfig.id, damage);
  if (!result.applied) return { msg: "", isBroken: false };
  if (result.isBroken) {
    return {
      msg: `\n💥 鱼竿也断了！\n🎣 失去了【${rodConfig.name}】`,
      isBroken: true,
    };
  }
  const durabilityPercent = Math.round((result.currentDurability / result.maxDurability) * 100);
  return {
    msg: `\n⚠️ 鱼竿受到了 ${damage} 点损耗，当前耐久 ${durabilityPercent}%`,
    isBroken: false,
  };
}

const fishIdSet = new Set(fishData.map((fish) => fish.id));

// 新收录时统计图鉴进度；只认仍存在于 fish.json 的鱼种，保证分母与图鉴一致
function getDexProgress(fishingManager, userId, settleResult) {
  if (!settleResult?.newlyRecorded || fishData.length === 0) return null;
  try {
    const collected = fishingManager
      .getUserCatchHistory(userId)
      .filter((row) => row.successCount > 0 && fishIdSet.has(row.fishId)).length;
    return { collected, total: fishData.length };
  } catch (err) {
    logger.warn(`[钓鱼] 统计图鉴进度失败: ${err.message}`);
    return null;
  }
}

// 渔获消息统一尾部：完美收竿提示 + 经验数值 + 升级提示 + 图鉴新收录提示
function formatCatchTail(expGain, isPerfect, settleResult, dexProgress) {
  const perfectMsg = isPerfect ? `\n⚡ 完美收竿！经验×2！` : "";
  const levelUp = settleResult?.levelUp;
  const levelUpMsg = levelUp ? `\n🎉 钓鱼等级提升至 Lv.${levelUp.to}` : "";
  const staminaResetMsg = Number.isFinite(levelUp?.staminaResetTo)
    ? `\n⚡ 升级后体力已回满：${levelUp.staminaResetTo}/${levelUp.staminaResetTo}`
    : "";
  const dexMsg = dexProgress
    ? `\n📖 图鉴新收录！(${dexProgress.collected}/${dexProgress.total})`
    : "";
  return `${perfectMsg}\n✨ 经验：+${expGain}${levelUpMsg}${staminaResetMsg}${dexMsg}`;
}

function formatFishFightState(stateId) {
  return getFishFightStateConfig(stateId).name;
}

function formatFishingStamina(status) {
  return `${status.current}/${status.max}`;
}

function formatFishingStaminaUnavailable(status) {
  const costNote = Number(status?.cost) > 1 ? `（深压影响，本竿需要 ${status.cost} 点）` : "";
  return `⚡体力不足：${formatFishingStamina(status)}${costNote}`;
}

function formatBossCombatStatus(state, fishingManager, userId) {
  const hpBar = createProgressBar(state.bossHp, state.bossMaxHp, 10);
  const distanceBar = createProgressBar(state.distance, 100, 10);
  const tensionBar = createProgressBar(state.tension, 100, 10);
  const line = fishingManager.getLineDurabilityInfo(userId, state.lineConfig.id);
  const lineBar = createProgressBar(line.currentDurability, line.maxDurability, 10);
  const rod = fishingManager.getRodDurabilityInfo(userId, state.rodConfig.id);
  const rodBar = createProgressBar(rod.currentDurability, rod.maxDurability, 10);
  return [
    `👑 生命：${hpBar} ${state.bossHp}/${state.bossMaxHp}`,
    `📏 距离：${distanceBar} ${Math.max(0, Math.round(state.distance))}/100`,
    `⚡ 张力：${tensionBar} ${Math.max(0, Math.round(state.tension))}/100`,
    `🧵 鱼线（永久）：${lineBar} ${line.currentDurability}/${line.maxDurability}`,
    `🎣 鱼竿：${rodBar} ${rod.currentDurability}/${rod.maxDurability}`,
  ].join("\n");
}

async function selectRandomFish(
  baitQuality,
  fishingManager = null,
  userId = null,
  weatherName = null,
  location = null,
  {
    forceRarity = null,
    nightmareBonus = 0,
    hasDebuff = false,
    brideThreadActive = false,
  } = {},
) {
  // 星愿强制稀有度时跳过鱼雷拦截，保证“必中传说”兑现
  if (!forceRarity && fishingManager && userId) {
    const torpedoCount = fishingManager.getAvailableTorpedoCount(userId);
    if (torpedoCount > 0) {
      const torpedoWeight = torpedoCount * 5;
      const totalWeight = 100 + torpedoWeight;
      const random = Math.random() * totalWeight;

      if (random < torpedoWeight) {
        return {
          id: "torpedo",
          name: "鱼雷",
          rarity: "危险",
          isTorpedo: true,
          actualWeight: 0,
          weight: [0, 0],
          base_price: 0,
          description: "💥 轰！！！"
        };
      }
    }
  }

  let treasureBonus = 0;
  if (fishingManager && userId) {
    treasureBonus = fishingManager.getTreasureBonus(userId);
  }

  return selectFishFromData(fishData, {
    baitQuality,
    hasDebuff,
    treasureBonus,
    nightmareBonus,
    brideThreadActive,
    forceRarity,
    hour: getShanghaiHour(),
    weather: weatherName || getWeatherByTime().name,
    location: location || undefined,
  });
}

async function calculateFishPrice(fish, fishingManager = null) {
  let torpedoMultiplier = 1;
  if (fishingManager) {
    try {
      torpedoMultiplier = await fishingManager.getFishPriceMultiplier();
    } catch (err) {
      logger.warn(`[钓鱼] 获取全局鱼价加成失败，按原价结算: ${err.message}`);
    }
  }
  return calculateLegacyFishPrice(fish, torpedoMultiplier);
}

function getFishImagePath(fishId) {
  return path.join(pluginresources, "fish", "img", `${fishId}.png`);
}

export default class Fishing extends plugin {
  constructor() {
    super({
      name: "钓鱼系统",
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
    return groups.some(g => String(g) === String(e.group_id));
  }

  cleanupFishingAttempts = Cron("15 4 * * *", () => {
    const deleted = FishingSettlementService.cleanupAttempts(2);
    if (deleted > 0) {
      logger.info(`[钓鱼] 已清理 ${deleted} 条过期结算幂等记录`);
    }
  });

  buildFishingStateKey(groupId, userId) {
    return this.getScopeKey("fishing", groupId, userId);
  }

  buildFishingLockKey(groupId, userId) {
    return `sakura:fishing:session:${groupId}:${userId}`;
  }

  cleanupFishingSession(stateKey, sessionId) {
    const state = fishingSessions.finish(stateKey, sessionId);
    if (state?.lockKey && state?.id) {
      releaseRedisLock(redis, state.lockKey, state.id).catch((err) => {
        logger.warn(`[钓鱼] 释放会话锁失败: ${err.message}`);
      });
    }
    return state;
  }

  scheduleFishFightStateRotation(stateKey, sessionId, delayMs = null) {
    const state = fishingSessions.get(stateKey);
    if (!state || state.id !== sessionId || state.phase !== FISHING_PHASE.fighting || state.settled) {
      return false;
    }

    if (state.fishStateTimer) clearTimeout(state.fishStateTimer);
    const delay = Number.isFinite(delayMs) && delayMs > 0
      ? delayMs
      : getFishFightStateChangeDelay();

    state.fishStateTimer = setTimeout(() => {
      const currentState = fishingSessions.get(stateKey);
      if (!currentState || currentState.id !== sessionId ||
          currentState.phase !== FISHING_PHASE.fighting || currentState.settled) {
        return;
      }
      currentState.fishStateTimer = null;

      // 玩家操作正在结算时稍后再切状态，避免回复内容和实际判定错位。
      if (currentState.processing) {
        this.scheduleFishFightStateRotation(stateKey, sessionId, 500);
        return;
      }

      currentState.fishState = selectNextFishFightState(currentState.fishState);
      currentState.fishStateChangedAt = Date.now();

      const latestState = fishingSessions.get(stateKey);
      if (latestState?.id === sessionId && latestState.phase === FISHING_PHASE.fighting && !latestState.settled) {
        this.scheduleFishFightStateRotation(stateKey, sessionId);
      }
    }, delay);
    return true;
  }

  scheduleBossAttack(e, stateKey, sessionId, delayMs = BOSS_ATTACK_INTERVAL_MS) {
    const state = fishingSessions.get(stateKey);
    if (
      !state ||
      state.id !== sessionId ||
      state.phase !== FISHING_PHASE.fighting ||
      state.settled ||
      !isBossFish(state.fish) ||
      state.bossHp <= 0
    ) {
      return false;
    }

    if (state.bossAttackTimer) clearTimeout(state.bossAttackTimer);
    state.bossAttackTimer = setTimeout(async () => {
      const currentState = fishingSessions.get(stateKey);
      if (
        !currentState ||
        currentState.id !== sessionId ||
        currentState.phase !== FISHING_PHASE.fighting ||
        currentState.settled ||
        currentState.bossHp <= 0
      ) {
        return;
      }
      currentState.bossAttackTimer = null;

      if (!fishingSessions.claimAction(stateKey, sessionId)) {
        this.scheduleBossAttack(e, stateKey, sessionId, 300);
        return;
      }

      try {
        await this.executeBossAttack(e, currentState);
      } catch (err) {
        logger.error(`[钓鱼] 首领攻击结算失败: ${err.stack || err}`);
      } finally {
        fishingSessions.releaseAction(stateKey, sessionId);
        const latestState = fishingSessions.get(stateKey);
        if (
          latestState?.id === sessionId &&
          latestState.phase === FISHING_PHASE.fighting &&
          !latestState.settled &&
          latestState.bossHp > 0
        ) {
          this.scheduleBossAttack(e, stateKey, sessionId);
        }
      }
    }, Math.max(1, Number(delayMs) || BOSS_ATTACK_INTERVAL_MS));
    return true;
  }

  async executeBossAttack(e, state) {
    const fishingManager = new FishingManager(e.group_id);
    const economyManager = new EconomyManager(e);
    const attackResult = resolveBossAttack(state.fish);
    const mechanic = state.fish.boss_mechanic;
    const effectMessages = [];

    state.bossAttackRounds = (state.bossAttackRounds || 0) + 1;
    const lineDamage = fishingManager.damageLine(
      e.user_id,
      state.lineConfig.id,
      attackResult.lineDamage,
      { protectFromBreak: Boolean(state.hasRiverBless) },
    );
    state.bossLineDurability = lineDamage.currentDurability;
    state.bossLineMaxDurability = lineDamage.maxDurability;
    state.distance = Math.min(100, state.distance + attackResult.distanceGain);
    state.tension = Math.min(100, state.tension + attackResult.tensionGain);

    if (lineDamage.applied && !lineDamage.isBroken && !lineDamage.breakPrevented) {
      effectMessages.push(
        `🧵 鱼线永久耐久剩余 ${lineDamage.currentDurability}/${lineDamage.maxDurability}`,
      );
    }

    const rodDamage = applyRodDamage(
      fishingManager,
      e.user_id,
      state.rodConfig,
      attackResult.rodDamage,
    );

    let staminaResult = null;
    if (attackResult.staminaDrain > 0) {
      staminaResult = fishingManager.drainFishingStamina(
        e.user_id,
        attackResult.staminaDrain,
      );
      effectMessages.push(
        `⚡ ${mechanic.name}抽走 ${staminaResult.drained} 点体力，剩余 ${staminaResult.current}/${staminaResult.max}`,
      );
    }

    if (attackResult.coinSteal > 0) {
      const balance = economyManager.getCoins(e);
      const stolen = Math.min(balance, attackResult.coinSteal);
      if (stolen > 0) {
        economyManager.reduceCoins(e, stolen, {
          type: "支出",
          note: `首领战：${state.fish.name}偷窃`,
          relatedId: state.id,
        });
      }
      effectMessages.push(`💸 ${mechanic.name}偷走 ${stolen} 樱花币`);
    }

    if (attackResult.tensionGain > 0) {
      effectMessages.push(`⚡ ${mechanic.name}令张力骤增 ${attackResult.tensionGain} 点`);
    }

    if (attackResult.heal > 0) {
      const before = state.bossHp;
      state.bossHp = Math.min(state.bossMaxHp, state.bossHp + attackResult.heal);
      effectMessages.push(`✨ ${mechanic.name}恢复 ${state.bossHp - before} 点生命`);
    }

    if (attackResult.lineDamage > Math.ceil(state.fish.attack / 2)) {
      effectMessages.push(`🪚 ${mechanic.name}强化了本次鱼线伤害`);
    }
    if (attackResult.rodDamage > Math.ceil(state.fish.attack / 2)) {
      effectMessages.push(`💥 ${mechanic.name}强化了本次鱼竿伤害`);
    }

    const lineDestroyed = lineDamage.isBroken || lineDamage.breakPrevented || (
      !lineDamage.applied && lineDamage.currentDurability <= 0
    );
    const tensionBroken = state.tension >= 100;
    const exhausted = Boolean(staminaResult?.exhausted);
    const rodBroken = rodDamage.isBroken;

    if (lineDestroyed || tensionBroken || exhausted || rodBroken || state.distance >= 100) {
      let lineBreak = null;
      if (lineDamage.breakPrevented) {
        lineBreak = { saved: true };
      } else if (lineDamage.isBroken) {
        lineBreak = { saved: false };
      } else if (tensionBroken) {
        lineBreak = this.breakLineWithBlessing(
          state,
          fishingManager,
          e.user_id,
          state.lineConfig,
        );
      }

      await this.finishFailedAttempt(e, state, {
        recordCatch: true,
        masteryGain: rodBroken ? 0 : 1,
      });
      const reasons = [];
      if (rodBroken) reasons.push(`🎣 【${state.rodConfig.name}】被击断了`);
      if (lineDamage.isBroken) {
        reasons.push(`🧵 永久耐久归零，【${state.lineConfig.name}】当场断裂`);
      } else if (lineDamage.breakPrevented) {
        reasons.push(`🌊 河神将【${state.lineConfig.name}】护在 1 点永久耐久`);
      } else if (lineDestroyed) {
        reasons.push("🧵 当前鱼线已经不可用");
      }
      if (tensionBroken) reasons.push("⚡ 张力达到极限");
      if (exhausted) reasons.push("🥵 体力耗尽");
      if (state.distance >= 100) reasons.push("🌊 首领逃回了深水区");
      if (tensionBroken && !lineDestroyed) {
        if (lineBreak?.saved) reasons.push(`🌊 河神保住了【${state.lineConfig.name}】`);
        else if (lineBreak) reasons.push(`💔 失去了【${state.lineConfig.name}】`);
      }

      await e.reply([
        `👑 【${state.fish.name}】发动了【${mechanic.name}】！\n`,
        `🧵 鱼线永久耐久 -${attackResult.lineDamage}｜🎣 鱼竿 -${attackResult.rodDamage}\n`,
        effectMessages.length > 0 ? `${effectMessages.join("\n")}\n` : "",
        `${reasons.join("\n")}\n❌ 首领挑战失败！`,
      ]);
      return false;
    }

    await e.reply([
      `👑 【${state.fish.name}】发动了【${mechanic.name}】！\n`,
      `🧵 鱼线永久耐久 -${attackResult.lineDamage}｜🎣 鱼竿 -${attackResult.rodDamage}\n`,
      effectMessages.length > 0 ? `${effectMessages.join("\n")}\n` : "",
      formatBossCombatStatus(state, fishingManager, e.user_id),
    ]);
    return true;
  }

  async startFightingPhase(e, state, { boss = false } = {}) {
    const stateKey = this.buildFishingStateKey(e.group_id, e.user_id);
    const fishingManager = new FishingManager(e.group_id);
    state.phase = FISHING_PHASE.fighting;
    state.distance = 50;
    state.tension = 50;
    state.fightingRounds = 0;
    state.fishState = FISH_FIGHT_STATE.calm;
    state.fishStateChangedAt = Date.now();

    if (state.totalTimer) clearTimeout(state.totalTimer);
    const timeoutMs = boss ? getBossFightTimeoutMs(state.fish) : 60 * 1000;
    state.totalTimer = setTimeout(() => {
      void this.handleFishingTimeout(e, stateKey, state.id, {
        expectedPhase: FISHING_PHASE.fighting,
        timerName: "totalTimer",
        message: boss
          ? `⏰ 讨伐超时！【${state.fish.name}】挣脱鱼钩，沉回了水域深处...`
          : "🌊 僵持太久了！鱼儿趁你松懈的瞬间，猛地一甩尾逃回了深水区...",
      });
    }, timeoutMs);

    if (boss) {
      state.bossHp = Math.max(1, Math.floor(Number(state.fish.hp) || 1));
      state.bossMaxHp = state.bossHp;
      const lineDurability = fishingManager.getLineDurabilityInfo(
        e.user_id,
        state.lineConfig.id,
      );
      state.bossLineMaxDurability = lineDurability.maxDurability;
      state.bossLineDurability = lineDurability.currentDurability;
      state.bossLastPlayerAttackAt = 0;
      state.bossAttackRounds = 0;

      await e.reply([
        `👑 首领战开始！【${state.fish.name}】现身！\n`,
        `⚖️ 重量：${state.fish.actualWeight}｜🎯 难度：${state.fish.difficulty}｜⚔️ 攻击力：${state.fish.attack}\n`,
        `🌀 特殊机制【${state.fish.boss_mechanic.name}】：${state.fish.boss_mechanic.description}\n\n`,
        `${formatBossCombatStatus(state, fishingManager, e.user_id)}\n\n`,
        `📝 指令：\n  「拉」拉近距离并增加张力\n  「溜」降低张力但会拉远距离\n  「攻」攻击首领（5秒冷却）\n`,
        `🏆 必须同时把首领生命与距离降到 0；首领每5秒反击一次！\n`,
        `🧵 首领造成的鱼线损伤会永久保留，耐久归零立即断线！\n`,
        `⚠️ 限时 ${Math.floor(timeoutMs / 1000)} 秒，当前为单人挑战。`,
      ]);
      this.scheduleBossAttack(e, stateKey, state.id);
    } else {
      const distanceBar = createProgressBar(state.distance, 100, 10);
      const tensionBar = createProgressBar(state.tension, 100, 10);
      await e.reply([
        `🎮 开始溜鱼！这是一场耐力的较量！\n`,
        `📏 距离：${distanceBar}\n`,
        `⚡ 张力：${tensionBar}\n`,
        `\n📝 你的策略：\n`,
        `  「拉」- 拉近距离 (张力会升高)\n`,
        `  「溜」- 放松鱼线 (距离会变远)\n`,
        `\n⚠️ 只有 60 秒时间，速战速决！`,
      ]);
    }

    this.scheduleFishFightStateRotation(stateKey, state.id);
    this.setContext("handleFishing", true, Math.ceil(timeoutMs / 1000) + 5);
    return true;
  }

  async rejectEquipmentChangeWhileFishing(e) {
    const lockKey = this.buildFishingLockKey(e.group_id, e.user_id);
    if (!await redis.exists(lockKey)) return false;
    await e.reply("钓鱼过程中不能更换装备，请先完成本次钓鱼。", 10);
    return true;
  }

  async handleFishingTimeout(
    e,
    stateKey,
    sessionId,
    { expectedPhase = null, timerName = "confirmTimer", message = "" } = {},
  ) {
    const state = fishingSessions.get(stateKey);
    if (!state || state.id !== sessionId || (expectedPhase && state.phase !== expectedPhase)) {
      return false;
    }
    if (state.processing) {
      state[timerName] = setTimeout(() => {
        void this.handleFishingTimeout(e, stateKey, sessionId, {
          expectedPhase,
          timerName,
          message,
        });
      }, 1000);
      return false;
    }

    try {
      const settled = await this.finishFailedAttempt(e, state);
      if (settled && message) await e.reply(message, false, true);
      return settled;
    } catch (err) {
      logger.error(`[钓鱼] 超时处理失败: ${err.stack || err}`);
      return false;
    }
  }

  // 抛竿瞬间快照所有钓鱼类 buff；溜鱼途中 buff 过期也按快照生效
  async readFishingBuffs(groupId, userId) {
    const buffIds = [
      "item_charm_lucky",
      "item_charm_starlight",
      "item_sign_koi",
      "item_lamp_fog",
      "item_bait_monster",
      "item_charm_river",
      "item_scale_leviathan",
      "item_card_star_double",
    ];
    let values;
    try {
      values = await Promise.all(
        buffIds.map((id) => redis.get(`sakura:fishing:buff:${id}:${groupId}:${userId}`)),
      );
    } catch (err) {
      logger.warn(`[钓鱼] 读取Buff状态失败: ${err.message}`);
      values = buffIds.map(() => null);
    }
    const [lucky, starlight, koi, fog, monster, river, scale, starDouble] = values.map(Boolean);
    return {
      // 星光护符是好运护符的上位品，共用“必上钩”判定
      hasLucky: lucky || starlight,
      hasStarlight: starlight,
      hasKoiSign: koi,
      hasFogLamp: fog,
      hasMonsterBait: monster,
      hasRiverBless: river,
      hasLeviathanScale: scale,
      hasStarDouble: starDouble,
    };
  }

  // 河神垂青期间任何断线事件都只跑鱼不断线
  breakLineWithBlessing(state, fishingManager, userId, lineConfig) {
    if (state.hasRiverBless) {
      return { saved: true };
    }
    fishingManager.breakLine(userId, lineConfig.id);
    return { saved: false };
  }

  startFishing = Command(/^#?钓鱼$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    const groupId = e.group_id;
    const userId = e.user_id;

    const fishingManager = new FishingManager(groupId);

    if (fishData.length === 0) {
      await e.reply("钓鱼数据暂不可用，请联系管理员检查配置。", 10);
      return true;
    }

    if (!fishingManager.hasAnyRod(userId)) {
      await e.reply("🎣 手里空空如也！\n快去「商店」挑根鱼竿吧~", 10);
      return true;
    }

    if (!fishingManager.hasAnyLine(userId)) {
      await e.reply("🧵 还没有鱼线！\n快去「商店」买根鱼线吧~", 10);
      return true;
    }

    const equippedBait = fishingManager.getEquippedBait(userId);
    if (!equippedBait) {
      await e.reply("🪱 鱼饵用光啦！\n没饵可钓不到鱼，去「商店」看看吧~", 10);
      return true;
    }

    const cooldownKey = `sakura:fishing:cooldown:${groupId}:${userId}`;
    let ttl = await redis.ttl(cooldownKey);
    if (ttl > FISHING_COOLDOWN_SECONDS) {
      await redis.expire(cooldownKey, FISHING_COOLDOWN_SECONDS);
      ttl = FISHING_COOLDOWN_SECONDS;
    }
    if (ttl > 0) {
      const remainingTime = ttl < 60
        ? `${Math.max(1, ttl)} 秒`
        : `${Math.ceil(ttl / 60)} 分钟`;
      await e.reply(
        `🎣 歇会儿吧，鱼塘刚被你惊扰过~\n请等待 ${remainingTime}后再来！`,
        10
      );
      return true;
    }

    const staminaStatus = fishingManager.getFishingStaminaStatus(userId);
    if (!staminaStatus.canFish) {
      await e.reply(formatFishingStaminaUnavailable(staminaStatus), 10);
      return true;
    }

    const equippedRodId = fishingManager.getEquippedRod(userId);
    const equippedLineId = fishingManager.getEquippedLine(userId);
    const rodConfig = fishingManager.getRodConfig(equippedRodId);
    const lineConfig = fishingManager.getLineConfig(equippedLineId);
    const baitConfig = fishingManager.getBaitConfig(equippedBait);

    if (!rodConfig || !lineConfig || !baitConfig) {
      await e.reply("装备异常，请重新装备鱼竿、鱼线和鱼饵~", 10);
      return true;
    }

    const stateKey = this.buildFishingStateKey(groupId, userId);
    const lockKey = this.buildFishingLockKey(groupId, userId);
    const sessionId = randomUUID();
    const acquired = await acquireRedisLock(redis, lockKey, sessionId, 7 * 60);
    if (!acquired) {
      await e.reply("一心不可二用！你已经在钓鱼啦，专心盯着浮漂~", 10);
      return true;
    }

    const state = fishingSessions.create(stateKey, {
      id: sessionId,
      lockKey,
      phase: FISHING_PHASE.starting,
      startTime: Date.now(),
    });
    if (!state) {
      await releaseRedisLock(redis, lockKey, sessionId);
      await e.reply("一心不可二用！你已经在钓鱼啦，专心盯着浮漂~", 10);
      return true;
    }
    state.cleanup = () => this.cleanupFishingSession(stateKey, state.id);

    try {
      const staminaResult = fishingManager.consumeFishingStamina(userId);
      if (!staminaResult.success) {
        state.cleanup();
        await e.reply(formatFishingStaminaUnavailable(staminaResult), 10);
        return true;
      }
      state.staminaReserved = true;
      state.staminaCost = staminaResult.cost;
      state.deepPressureConsumed = staminaResult.deepPressureConsumed;

      if (!fishingManager.consumeBait(userId)) {
        throw new Error("鱼饵已被消耗或装备状态发生变化");
      }
      state.baitConsumed = true;
      const baitQuality = baitConfig.quality || 1;
      const isBossBait = baitConfig.boss_bait === true || baitConfig.id === BOSS_BAIT_ID;
      const pondWeather = getWeatherByTime();
      const locationId = fishingManager.getFishingLocation(userId);
      const locationConfig = getFishingLocationConfig(locationId);

      const buffFlags = await this.readFishingBuffs(groupId, userId);
      const nightmareStatus = fishingManager.getNightmareStatus(userId);

      // 持续型噩梦状态按实际抛竿消耗；即使随后钓到鱼雷也照常减少一层。
      // 普通诅咒优先于冥婚红线；二者并存时，本竿红线暂停且不消耗。
      const rarityAfflictions = isBossBait
        ? {
          consumeCurse: false,
          consumeBrideThread: false,
          brideThreadPaused: false,
        }
        : resolveNightmareRarityAfflictions(
          nightmareStatus.curse.actualLayers,
          nightmareStatus.brideThreadLayers,
        );
      const curseResult = rarityAfflictions.consumeCurse
        ? fishingManager.consumeNightmareCurseLayer(userId)
        : { consumed: false, remaining: nightmareStatus.curse.actualLayers };
      const brideThreadResult = rarityAfflictions.consumeBrideThread
        ? fishingManager.consumeBrideThreadLayer(userId)
        : { consumed: false, remaining: nightmareStatus.brideThreadLayers };

      // 星愿一次性生效：抛竿即消耗，本竿必中传说；启动失败会在 catch 中退还
      let hasWish = false;
      try {
        const wishKey = `sakura:fishing:wish:${groupId}:${userId}`;
        hasWish = !isBossBait && Boolean(await redis.get(wishKey));
        if (hasWish) await redis.del(wishKey);
      } catch (err) {
        hasWish = false;
        logger.warn(`[钓鱼] 读取星愿状态失败: ${err.message}`);
      }
      state.wishConsumed = hasWish;

      // 雾灯只改本人选鱼用的天气，不影响全局天气播报
      const effectiveWeather = buffFlags.hasFogLamp ? "雾" : pondWeather.name;
      const selectedFish = isBossBait
        ? selectBossFromData(fishData, { location: locationId })
        : await selectRandomFish(
          baitQuality,
          fishingManager,
          userId,
          effectiveWeather,
          locationId,
          {
            forceRarity: hasWish ? "传说" : null,
            nightmareBonus: buffFlags.hasMonsterBait ? 15 : 0,
            hasDebuff: curseResult.consumed,
            brideThreadActive: brideThreadResult.consumed,
          },
        );
      const fishingLevel = fishingManager.getUserFishingLevel(userId);
      const waitTime = rollFishingBiteWaitMs(fishingLevel);

      const buffNotes = [
        buffFlags.hasStarlight
          ? "\n✨ 星光护符生效中！"
          : buffFlags.hasLucky ? "\n🍀 好运护符生效中！" : "",
        buffFlags.hasKoiSign ? "\n🎏 锦鲤许愿签生效中！" : "",
        buffFlags.hasFogLamp ? "\n🌫️ 雾灯亮着，你的水面雾气弥漫（个人天气：雾）" : "",
        buffFlags.hasMonsterBait ? "\n🩸 怪物诱饵的血腥味在水中扩散……" : "",
        buffFlags.hasRiverBless ? "\n🌊 河神注视着你的鱼线。" : "",
        buffFlags.hasLeviathanScale ? "\n🐉 利维坦的逆鳞微微发烫。" : "",
        brideThreadResult.consumed
          ? `\n💍 冥婚红线缠绕着鱼钩（剩余 ${brideThreadResult.remaining} 层）。`
          : "",
        rarityAfflictions.brideThreadPaused
          ? `\n☠️ 诅咒压过冥婚红线，本竿红线暂停（仍有 ${brideThreadResult.remaining} 层）。`
          : "",
        nightmareStatus.lostSoul
          ? "\n🪞 你的倒影仍留在雾隐湖，本次无法完美收竿且收益、经验降低。"
          : "",
        staminaResult.deepPressureConsumed
          ? `\n🔔 深压回响令本竿额外消耗 1 点体力（剩余 ${staminaResult.deepPressureLayers} 层）。`
          : "",
        hasWish ? "\n🌠 星愿闪耀！这一竿将迎来传说！" : "",
        isBossBait ? `\n👑 首领鱼饵正在呼唤【${selectedFish.name}】！` : "",
      ].join("");

      Object.assign(state, {
        fish: selectedFish,
        rodConfig,
        lineConfig,
        baitConfig,
        phase: FISHING_PHASE.waiting,
        hasLucky: buffFlags.hasLucky,
        hasStarlight: buffFlags.hasStarlight,
        hasKoiSign: buffFlags.hasKoiSign,
        hasFogLamp: buffFlags.hasFogLamp,
        hasMonsterBait: buffFlags.hasMonsterBait,
        hasRiverBless: buffFlags.hasRiverBless,
        hasLeviathanScale: buffFlags.hasLeviathanScale,
        hasStarDouble: buffFlags.hasStarDouble,
        hasLostSoul: nightmareStatus.lostSoul,
        locationId,
        isBossBait,
      });

      await e.reply(
        `🎣 在${locationConfig.emoji}【${locationConfig.name}】挥动【${rodConfig.name}】挂上【${baitConfig.name}】伴随着优美的抛物线，鱼钩落入水中...耐心等待浮漂的动静吧...\n🌤️ 当前天气：${pondWeather.emoji}${pondWeather.name}\n⚡体力：${formatFishingStamina(staminaResult)}${buffNotes}`
      );

      state.totalTimer = setTimeout(() => {
        void this.handleFishingTimeout(e, stateKey, state.id, {
          timerName: "totalTimer",
          message: "⏰ 本次钓鱼已经超时，鱼儿悄悄溜走了...",
        });
      }, 5 * 60 * 1000);

      state.waitingTimer = setTimeout(async () => {
        const currentState = fishingSessions.get(stateKey);
        if (
          !currentState ||
          currentState.id !== state.id ||
          currentState.phase !== FISHING_PHASE.waiting
        ) {
          return;
        }

        const fish = currentState.fish;
        const fishWeight = fish.actualWeight;
        const lineBonus = fishingManager.getLineBonusFromMastery(userId, rodConfig.id);
        const lineCapacity = lineConfig.capacity + lineBonus;

        currentState.phase = FISHING_PHASE.weightCheck;
        currentState.isOverweight = !fish.isTorpedo && fishWeight > lineCapacity;
        if (isBossFish(fish) && currentState.isOverweight) {
          await e.reply([
            `👑 水面轰然炸开，【${fish.name}】吞下了首领鱼饵！\n`,
            `⚖️ 这股力量远超鱼线承重……回复「收竿」迎战，回复「放弃」保住装备！`,
          ], false, true);
        } else if (isBossFish(fish)) {
          await e.reply([
            `👑 水面轰然炸开，【${fish.name}】吞下了首领鱼饵！\n`,
            `⚔️ 快回复「收竿」完成重量判定并进入首领战！`,
          ], false, true);
        } else if (currentState.isOverweight) {
          await e.reply([
            `🌊 浮漂猛地沉下去了！\n`,
            `😨 这条鱼太大了！鱼线可能撑不住...\n`,
            `📝 回复「收竿」拼了，回复「放弃」保平安`,
          ], false, true);
        } else {
          await e.reply([
            `🌊 浮漂动了！有鱼上钩啦！\n`,
            `🤩 快！回复「收竿」把它拉上来！`,
          ], false, true);
        }

        // 完美收竿窗口从提示送达后起算，避免发送延迟吃掉反应时间
        currentState.biteTime = Date.now();

        this.setContext("handleFishing", true, 60);
        currentState.confirmTimer = setTimeout(() => {
          void this.handleFishingTimeout(e, stateKey, state.id, {
            expectedPhase: FISHING_PHASE.weightCheck,
            message: isBossFish(fish)
              ? `⏰ 犹豫太久了……【${fish.name}】撕碎鱼饵，沉回了水底！`
              : currentState.isOverweight
                ? "⏰ 犹豫太久了... 鱼挣脱跑掉了！"
                : "⏰ 错过时机了... 鱼跑掉了！",
          });
        }, 60 * 1000);
      }, waitTime);
      state.staminaReserved = false;
    } catch (err) {
      if (state.baitConsumed) {
        try {
          const inventoryManager = new InventoryManager(groupId, userId);
          await inventoryManager.forceAddItem(equippedBait, 1);
          fishingManager.equipBait(userId, equippedBait);
        } catch (refundErr) {
          logger.error(`[钓鱼] 启动失败后退还鱼饵异常: ${refundErr.stack || refundErr}`);
        }
      }
      if (state.staminaReserved) {
        try {
          fishingManager.restoreFishingStamina(userId, state.staminaCost || 1);
          if (state.deepPressureConsumed) {
            fishingManager.restoreDeepPressureLayer(userId);
          }
          state.staminaReserved = false;
        } catch (refundErr) {
          logger.error(`[钓鱼] 启动失败后退还体力异常: ${refundErr.stack || refundErr}`);
        }
      }
      if (state.wishConsumed) {
        try {
          await redis.set(
            `sakura:fishing:wish:${groupId}:${userId}`,
            "传说",
            "EX",
            FISHING_BENEFIT_DURATION_SECONDS,
          );
          state.wishConsumed = false;
        } catch (refundErr) {
          logger.error(`[钓鱼] 启动失败后退还星愿异常: ${refundErr.stack || refundErr}`);
        }
      }
      state.cleanup();
      logger.error(`[钓鱼] 创建会话失败: ${err.stack || err}`);
      await e.reply(`钓鱼失败：${err.message}`, 10);
    }

    return true;
  });


  async handleFishing() {
    const e = this.e;
    const groupId = e.group_id;
    const userId = e.user_id;
    const msg = e.msg?.trim();

    const stateKey = this.buildFishingStateKey(groupId, userId);
    const state = fishingSessions.get(stateKey);
    if (!state) {
      return;
    }

    const action = parseFishingAction(state.phase, msg);
    if (!action) {
      return;
    }
    if (!fishingSessions.claimAction(stateKey, state.id)) {
      if (
        state.processing &&
        !state.settled &&
        state.phase === FISHING_PHASE.fighting &&
        isBossFish(state.fish)
      ) {
        await e.reply("⏳ 首领正在结算反击，这条指令没有被消耗，请立即重发一次。", 5);
      }
      return;
    }

    try {
      const { fish, rodConfig, lineConfig } = state;
      const fishingManager = new FishingManager(groupId);
      const rodMastery = fishingManager.getRodMastery(userId, rodConfig.id);
      const fishDifficulty = fish.difficulty;

    if (state.phase === FISHING_PHASE.weightCheck) {
      if (action === FISHING_ACTION.abandon) {
        await this.finishFailedAttempt(e, state);
        await e.reply(`🎣 放生了这条鱼，期待下次相遇~`);
        return;
      }

      if (state.confirmTimer) {
        clearTimeout(state.confirmTimer);
        state.confirmTimer = null;
      }

      if (fish.isTorpedo) {
        const ownerId = fishingManager.triggerTorpedo(userId);

        if (!ownerId) {
          await this.finishFailedAttempt(e, state);
          await e.reply("💨 钩上的鱼雷已经被人抢先拆走了，这次有惊无险。", 10);
          return;
        }

        fishingManager.recordTorpedoHit(userId);
        let priceBoostApplied = true;
        try {
          await fishingManager.setFishPriceBoost();
        } catch (err) {
          priceBoostApplied = false;
          logger.warn(`[钓鱼] 鱼雷鱼价加成写入失败: ${err.message}`);
        }

        const lineBreak = this.breakLineWithBlessing(state, fishingManager, userId, lineConfig);

        const damageResult = applyRodDamage(fishingManager, userId, rodConfig, 20);

        await this.finishFailedAttempt(e, state);

        await e.reply([
          `💥💥💥 轰！！！\n`,
          `😱 钓到了`,
          segment.at(ownerId),
          `的鱼雷！\n`,
          lineBreak.saved
            ? `🌊 河神的祝福护住了鱼线，只有耳朵嗡嗡作响！`
            : `🧵 鱼线被炸断了！`,
          `${damageResult.msg}\n`,
          priceBoostApplied
            ? `😱 鱼雷爆炸引发恐慌！接下来30分钟内鱼价1.5倍！`
            : `😱 鱼雷爆炸了，但鱼价加成暂时没有生效。`,
        ]);

        return;
      }

      // 完美收竿：5 秒内操作，并且装备足以通过重量与难度判定，
      // 或有好运护符/锦鲤许愿签兜底。仅满足反应时间不会跳过正常判定。
      const lineBonus = fishingManager.getLineBonusFromMastery(userId, rodConfig.id);
      const lineCapacity = lineConfig.capacity + lineBonus;
      const effectiveControl = fishingManager.getRodControl(userId, rodConfig.id) + rodMastery;
      const qualifiesForPerfect = !isBossFish(fish) && isPerfectCatch({
        reelDelayMs: state.biteTime ? Date.now() - state.biteTime : Number.NaN,
        fishWeight: fish.actualWeight,
        fishDifficulty,
        lineCapacity,
        effectiveControl,
        hasAssist: state.hasLucky || state.hasKoiSign,
      });

      if (qualifiesForPerfect && !state.hasLostSoul) {
        state.isPerfect = true;
        await this.finishSuccess(e, state, fishingManager);
        return;
      }

      if (qualifiesForPerfect && state.hasLostSoul) {
        await e.reply("🪞 水面映不出你的身影……失魂状态阻止了完美收竿！");
      }

      if (!isBossFish(fish) && state.hasLucky) {
        await e.reply(
          state.hasStarlight
            ? `✨ 星光护符发挥了作用！轻松把鱼拉了上来！`
            : `🍀 好运护符发挥了作用！轻松把鱼拉了上来！`,
        );
        await this.finishSuccess(e, state, fishingManager);
        return;
      }

      if (state.isOverweight) {
        const fishWeight = fish.actualWeight;

        if (fishWeight > lineCapacity * 2) {
          const lineBreak = this.breakLineWithBlessing(state, fishingManager, userId, lineConfig);

          const damageResult = applyRodDamage(fishingManager, userId, rodConfig, 10);

          await this.finishFailedAttempt(e, state, { recordCatch: true, masteryGain: 1 });

          await e.reply([
            `🌊 巨大的力量传来！\n`,
            `😱 这到底是个什么庞然大物！？(${fishWeight})\n`,
            lineBreak.saved
              ? `💥 鱼线发出濒死的悲鸣，却奇迹般撑住了！\n🌊 河神的祝福护住了【${lineConfig.name}】，但鱼还是跑了...${damageResult.msg}`
              : `💥 啪！鱼线瞬间崩断了！\n🧵 【${lineConfig.name}】牺牲了...${damageResult.msg}`,
          ]);

          return;
        }

        const successRate = 1 - (fishWeight - lineCapacity) / lineCapacity;
        const isSuccess = Math.random() < successRate;

        if (!isSuccess) {
          const lineBreak = this.breakLineWithBlessing(state, fishingManager, userId, lineConfig);

          const damageResult = applyRodDamage(fishingManager, userId, rodConfig, 5);

          await this.finishFailedAttempt(e, state, { recordCatch: true, masteryGain: 1 });

          await e.reply([
            `💥 崩！\n`,
            `😫 还是没能坚持住，鱼脱钩了...\n`,
            `👋 鱼大摇大摆地游走了(${fishWeight})\n`,
            lineBreak.saved
              ? `🌊 河神的祝福护住了【${lineConfig.name}】！${damageResult.msg}`
              : `🧵 失去了【${lineConfig.name}】${damageResult.msg}`,
          ]);

          return;
        }

        const damageResult = applyRodDamage(fishingManager, userId, rodConfig, 5);

        if (damageResult.isBroken) {
          await this.finishFailedAttempt(e, state);
          await e.reply([
            `⚡ 鱼线竟然没断！但是...\n`,
            `💥 咔嚓一声！鱼竿承受不住压力折断了！\n`,
            `😭 你的【${rodConfig.name}】...`,
          ]);

          return;
        }

        await e.reply(`⚡ 鱼线紧绷！勉强撑住了！${damageResult.msg}`);
      }

      // 首领只复用重量判定；通过后跳过普通鱼的难度判定，直接进入战斗。
      if (isBossFish(fish)) {
        await this.startFightingPhase(e, state, { boss: true });
        return;
      }

      state.phase = FISHING_PHASE.difficultyCheck;
      const updatedControl = fishingManager.getRodControl(userId, rodConfig.id) + rodMastery;

      if (fishDifficulty > updatedControl) {
        await e.reply([
          `😵 这条鱼劲好大！完全拉不动！\n`,
          `⚠️ 看来是条暴脾气的鱼！\n`,
          `📝 怎么处理？\n`,
          `  「强拉」- 大力出奇迹！\n`,
          `  「溜鱼」- 和它比拼耐力！`,
        ]);

        this.setContext("handleFishing", true, 30);
        state.confirmTimer = setTimeout(() => {
          void this.handleFishingTimeout(e, stateKey, state.id, {
            expectedPhase: FISHING_PHASE.difficultyCheck,
            message: "⏰ 犹豫太久... 鱼挣脱了！",
          });
        }, 30 * 1000);
      } else {
        await this.finishSuccess(e, state, fishingManager);
      }
      return;
    }

    if (state.phase === FISHING_PHASE.difficultyCheck) {
      if (state.confirmTimer) {
        clearTimeout(state.confirmTimer);
        state.confirmTimer = null;
      }

      if (action === FISHING_ACTION.forcePull) {
        const updatedControl = fishingManager.getRodControl(userId, rodConfig.id) + rodMastery;
        const successRate = Math.max(0, 1 - (fishDifficulty - updatedControl) / 100);
        const isSuccess = Math.random() < successRate;

        if (!isSuccess) {
          const lineBreak = this.breakLineWithBlessing(state, fishingManager, userId, lineConfig);
          await this.finishFailedAttempt(e, state, { recordCatch: true, masteryGain: 1 });

          await e.reply([
            `💥 啪！用力过猛了！\n`,
            `😫 鱼挣脱了，大力没能出奇迹...\n`,
            lineBreak.saved
              ? `🌊 河神的祝福护住了【${lineConfig.name}】！`
              : `🧵 鱼线应声而断，失去了【${lineConfig.name}】`,
          ]);
          return;
        }

        await e.reply(`💪 强行拉了上来！`);
        await this.finishSuccess(e, state, fishingManager);
        return;
      }

      if (action === FISHING_ACTION.startTug) {
        await this.startFightingPhase(e, state);
        return;
      }

      return;
    }

    if (state.phase === FISHING_PHASE.fighting) {
      const updatedControl = fishingManager.getRodControl(userId, rodConfig.id) + rodMastery;
      const fishStateLabel = formatFishFightState(state.fishState);
      const bossFight = isBossFish(fish);
      const contextSeconds = bossFight ? Math.ceil(getBossFightTimeoutMs(fish) / 1000) + 5 : 65;

      if (action === FISHING_ACTION.attack) {
        if (!bossFight) {
          await e.reply("🐟 普通渔获没有血条，用「拉」和「溜」就能应对。", 10);
          this.setContext("handleFishing", true, contextSeconds, false);
          return;
        }

        if (state.bossHp <= 0) {
          await e.reply(
            `💫 【${fish.name}】已经失去反抗能力，不需要继续攻击；发送「拉」完成捕获。\n` +
            formatBossCombatStatus(state, fishingManager, userId),
          );
          this.setContext("handleFishing", true, contextSeconds, false);
          return;
        }

        const now = Date.now();
        const cooldownRemaining = getBossAttackCooldownRemaining(
          state.bossLastPlayerAttackAt,
          now,
        );
        if (cooldownRemaining > 0) {
          await e.reply(
            `⏳ 「攻」还在冷却，请等待 ${(cooldownRemaining / 1000).toFixed(1)} 秒。\n` +
            formatBossCombatStatus(state, fishingManager, userId),
          );
          this.setContext("handleFishing", true, contextSeconds, false);
          return;
        }

        state.bossLastPlayerAttackAt = now;
        state.fightingRounds += 1;
        const damage = rollBossPlayerDamage(updatedControl);
        state.bossHp = Math.max(0, state.bossHp - damage);

        if (state.bossHp <= 0 && state.bossAttackTimer) {
          clearTimeout(state.bossAttackTimer);
          state.bossAttackTimer = null;
        }
        if (state.bossHp <= 0 && state.distance <= 0) {
          await e.reply(`⚔️ 最后一击造成 ${damage} 点伤害，首领轰然倒下！`);
          await this.finishSuccess(e, state, fishingManager);
          return;
        }

        const defeatHint = state.bossHp <= 0
          ? "\n💫 首领已经失去反抗能力！继续用「拉」把它拖到岸边。"
          : "\n⏳ 「攻」进入5秒冷却，期间继续兼顾距离和张力。";
        await e.reply(
          `⚔️ 你对【${fish.name}】造成 ${damage} 点伤害！\n` +
          formatBossCombatStatus(state, fishingManager, userId) +
          defeatHint,
        );
        this.setContext("handleFishing", true, contextSeconds, false);
        return;
      }

      if (action === FISHING_ACTION.pull) {
        state.fightingRounds++;

        // 除数 6：保证碳素级控制力在首领战里也有正向距离收益，Boss 门槛不至于全卡在拉力上
        const pullPower = Math.max(8, Math.floor(updatedControl / 6));
        const fishResist = Math.max(3, Math.floor(fishDifficulty / 20));
        const effects = applyFishFightStateModifiers({
          stateId: state.fishState,
          action: FISHING_ACTION.pull,
          distanceEffect: pullPower - fishResist + _.random(0, 3),
          tensionEffect: Math.floor(fishDifficulty / 12) + _.random(4, 9),
        });

        state.distance -= effects.distanceEffect;
        state.tension += effects.tensionEffect;

        let damageHint = "";
        if (state.isOverweight) {
          const damageResult = applyRodDamage(fishingManager, userId, rodConfig, 1);
          damageHint = damageResult.msg;

          if (damageResult.isBroken) {
            await this.finishFailedAttempt(e, state, { recordCatch: true });
            await e.reply([
              `💥 鱼竿断了！\n`,
              `🎣 失去了【${rodConfig.name}】\n`,
              `❌ 溜鱼失败... 鱼跑掉了`,
            ]);
            return;
          }
        }

        if (state.tension >= 100) {
          const lineBreak = this.breakLineWithBlessing(state, fishingManager, userId, lineConfig);
          await this.finishFailedAttempt(e, state, { recordCatch: true, masteryGain: 1 });

          await e.reply([
            `💥 崩！\n`,
            `⚡ 线绷得太紧，鱼趁机挣脱了！\n`,
            `😓 下次记得适时放松哦...\n`,
            lineBreak.saved
              ? `🌊 河神的祝福护住了【${lineConfig.name}】！`
              : `🧵 鱼线断掉了，失去了【${lineConfig.name}】`,
          ]);
          return;
        }

        if (state.distance <= 0) {
          if (bossFight && state.bossHp > 0) {
            state.distance = 5;
            await e.reply(
              `👑 已经把【${fish.name}】逼到岸边，但它仍有 ${state.bossHp} 点生命，猛地撑住了！\n` +
              `⚔️ 用「攻」削减生命，同时继续控制张力。\n` +
              formatBossCombatStatus(state, fishingManager, userId),
            );
            this.setContext("handleFishing", true, contextSeconds, false);
            return;
          }
          if (bossFight) {
            state.distance = 0;
            await e.reply(`🏆 成功击败并拖回了【${fish.name}】！`);
            await this.finishSuccess(e, state, fishingManager);
            return;
          }
          await e.reply(`🎉 成功把鱼拉上来了！溜了 ${state.fightingRounds} 回合！`);
          await this.finishSuccess(e, state, fishingManager);
          return;
        }

        if (state.distance >= 100) {
          await this.finishFailedAttempt(e, state, { recordCatch: true, masteryGain: 1 });
          await e.reply([
            bossFight ? `🌊 首领冲回了水域深处！\n` : `🌊 鱼跑得太远了！\n`,
            `👋 只能目送它离开了...\n`,
            bossFight ? `❌ 首领挑战失败` : `❌ 鱼逃走了`,
          ]);

          return;
        }

        if (bossFight) {
          await e.reply([
            `💪 用力一拉！首领状态：${fishStateLabel}\n`,
            `${formatBossCombatStatus(state, fishingManager, userId)}${damageHint}`,
          ]);
        } else {
          const distanceBar = createProgressBar(state.distance, 100, 10);
          const tensionBar = createProgressBar(state.tension, 100, 10);
          await e.reply([
            `💪 用力一拉！\n`,
            `🐟状态：${fishStateLabel}\n`,
            `📏 距离：${distanceBar}\n`,
            `⚡ 张力：${tensionBar}${damageHint}`,
          ]);
        }

        this.setContext("handleFishing", true, contextSeconds, false);
        return;
      }

      if (action === FISHING_ACTION.loosen) {
        state.fightingRounds++;

        const effects = applyFishFightStateModifiers({
          stateId: state.fishState,
          action: FISHING_ACTION.loosen,
          distanceEffect: Math.max(2, Math.floor(fishDifficulty / 30)) + _.random(1, 4),
          tensionEffect: _.random(20, 35),
        });

        state.tension = Math.max(0, state.tension - effects.tensionEffect);
        state.distance += effects.distanceEffect;

        if (state.distance >= 100) {
          await this.finishFailedAttempt(e, state, { recordCatch: true });
          await e.reply([
            bossFight ? `🌊 首领冲回了水域深处！\n` : `🌊 鱼跑得太远了！\n`,
            `👋 只能目送它离开了...\n`,
            bossFight ? `❌ 首领挑战失败` : `❌ 鱼逃走了`,
          ]);

          return;
        }

        if (bossFight) {
          await e.reply([
            `🌊 放松鱼线... 首领状态：${fishStateLabel}\n`,
            formatBossCombatStatus(state, fishingManager, userId),
          ]);
        } else {
          const distanceBar = createProgressBar(state.distance, 100, 10);
          const tensionBar = createProgressBar(state.tension, 100, 10);
          await e.reply([
            `🌊 放松鱼线...\n`,
            `🐟状态：${fishStateLabel}\n`,
            `📏 距离：${distanceBar}\n`,
            `⚡ 张力：${tensionBar}`,
          ]);
        }

        this.setContext("handleFishing", true, contextSeconds, false);
        return;
      }

      return;
    }
    } finally {
      fishingSessions.releaseAction(stateKey, state.id);
    }
  }

  async finishFailedAttempt(e, state, { recordCatch = false, masteryGain = 0 } = {}) {
    const groupId = e.group_id;
    const userId = e.user_id;
    const stateKey = this.buildFishingStateKey(groupId, userId);
    if (!fishingSessions.beginSettlement(stateKey, state.id)) return false;

    try {
      const settlement = new FishingSettlementService(e);
      const result = settlement.settleAttempt({
        sessionId: state.id,
        fishId: state.fish?.id,
        success: false,
        earnings: 0,
        rodId: state.rodConfig?.id,
        masteryGain,
        recordCatch,
      });
      if (!result.success && result.reason !== "duplicate") {
        logger.warn(`[钓鱼] 失败结算未完成: ${result.reason}`);
      }
    } catch (err) {
      logger.error(`[钓鱼] 失败结算异常: ${err.stack || err}`);
    } finally {
      this.finish("handleFishing", true);
      try {
        await this.setCooldownAndIncrement(groupId, userId);
      } catch (err) {
        logger.error(`[钓鱼] 写入冷却失败: ${err.stack || err}`);
      } finally {
        if (state.cleanup) state.cleanup();
      }
    }
    return true;
  }

  async setCooldownAndIncrement(groupId, userId) {
    const cooldownKey = `sakura:fishing:cooldown:${groupId}:${userId}`;
    const dailyKey = `sakura:economy:daily_fishing_count:${groupId}:${userId}`;
    const now = Date.now();
    return await completeFishingAttempt(redis, {
      cooldownKey,
      dailyKey,
      nowSeconds: Math.floor(now / 1000),
      cooldownSeconds: FISHING_COOLDOWN_SECONDS,
      dailyTtlSeconds: secondsUntilNextShanghaiDay(now),
    });
  }

  destroy() {
    for (const [stateKey, state] of fishingSessions.entries()) {
      this.cleanupFishingSession(stateKey, state.id);
    }
    super.destroy();
  }

  async devourFishingBuff(groupId, userId, durationSeconds, random = Math.random) {
    const safeDuration = Math.max(1, Math.floor(Number(durationSeconds) || 1));
    const buffItems = new ShopManager().getAllItems().filter((item) => (
      item.type === "buff" && item.id !== "item_scale_leviathan"
    ));
    const candidates = [];
    for (const item of buffItems) {
      const key = `sakura:fishing:buff:${item.id}:${groupId}:${userId}`;
      const ttl = await redis.ttl(key);
      if (ttl > 0) candidates.push({ item, key, ttl });
    }
    if (candidates.length === 0) return null;

    const roll = Math.max(0, Math.min(0.999999999999, Number(random()) || 0));
    const selected = candidates[Math.floor(roll * candidates.length)];
    const remaining = Math.max(0, selected.ttl - safeDuration);
    if (remaining > 0) {
      await redis.expire(selected.key, remaining);
    } else {
      await redis.del(selected.key);
    }
    return {
      item: selected.item,
      erodedSeconds: selected.ttl - remaining,
      remainingSeconds: remaining,
    };
  }

  async applyNightmareEffect({
    e,
    state,
    fishingManager,
    economyManager,
    professionEffects,
    expGain,
  }) {
    const { fish, rodConfig, baitConfig } = state;
    const effect = fish.nightmare_effect || {};
    const reducePenalty = (value) => Math.max(
      1,
      Math.round(Number(value) * professionEffects.penaltyMultiplier),
    );
    const fallbackRodDamage = (amount, prefix) => {
      const damage = reducePenalty(amount);
      const result = applyRodDamage(fishingManager, e.user_id, rodConfig, damage);
      return `${prefix}${result.msg}`;
    };
    let nextExpGain = expGain;
    let message = "💥 这是一个噩梦般的生物！";

    switch (effect.type) {
      case "rod_damage": {
        message = fallbackRodDamage(
          effect.amount || 20,
          "💥 它疯狂挣扎，严重损坏了你的鱼竿！",
        );
        break;
      }

      case "steal_coins_flat": {
        const currentCoins = economyManager.getCoins(e);
        if (currentCoins <= 0) {
          message = fallbackRodDamage(
            effect.fallback_rod_damage || 20,
            "💸 它想偷你的钱，却发现你身无分文，恼羞成怒地攻击了鱼竿！",
          );
          break;
        }
        const min = Math.max(1, Math.floor(Number(effect.min) || 1));
        const max = Math.max(min, Math.floor(Number(effect.max) || min));
        const baseAmount = Math.min(_.random(min, max), currentCoins);
        const stolenAmount = Math.min(reducePenalty(baseAmount), currentCoins);
        economyManager.reduceCoins(e, stolenAmount, {
          type: "支出",
          note: `钓鱼事件：${fish.name}`,
        });
        message = `💸 趁你手忙脚乱之时，它偷走了你 ${stolenAmount} 樱花币！`;
        break;
      }

      case "steal_coins_percent": {
        const currentCoins = economyManager.getCoins(e);
        if (currentCoins <= 0) {
          message = fallbackRodDamage(
            effect.fallback_rod_damage || 20,
            "🌑 它想吞噬你的财富，却发现你空空如也，愤怒地破坏了鱼竿！",
          );
          break;
        }
        const minPercent = Math.max(1, Math.floor(Number(effect.min_percent) || 1));
        const maxPercent = Math.max(minPercent, Math.floor(Number(effect.max_percent) || minPercent));
        const percent = _.random(minPercent, maxPercent);
        const baseAmount = Math.max(1, Math.min(currentCoins, Math.round(currentCoins * percent / 100)));
        const stolenAmount = Math.min(reducePenalty(baseAmount), currentCoins);
        economyManager.reduceCoins(e, stolenAmount, {
          type: "支出",
          note: `钓鱼事件：${fish.name}`,
        });
        message = `🌑 它吞噬了你的财富……你丢失了 ${stolenAmount} 樱花币！`;
        break;
      }

      case "curse": {
        const layers = reducePenalty(effect.layers || 5);
        fishingManager.addNightmareCurseLayers(e.user_id, layers);
        message = `☠️ 诅咒附身！噩梦诅咒增加了 ${layers} 层。`;
        break;
      }

      case "bride_thread": {
        const layers = reducePenalty(effect.layers || 4);
        const result = fishingManager.addBrideThreadLayers(
          e.user_id,
          layers,
          effect.max_layers || 8,
        );
        message = result.added > 0
          ? `💍 冰冷的红线缠上手腕！冥婚红线增加 ${result.added} 层，当前 ${result.total} 层。`
          : `💍 冥婚红线已经缠至上限 ${result.total} 层，花嫁仍不肯松手。`;
        break;
      }

      case "steal_bait": {
        if (
          professionEffects.penaltyReduction > 0 &&
          Math.random() < professionEffects.penaltyReduction
        ) {
          message = "🗡️ 深渊猎手看穿了水猴的小动作，鱼饵安然无恙！";
          break;
        }
        const result = fishingManager.stealBait(e.user_id, baitConfig?.id);
        if (result.stolen) {
          message = `🐒 水猴顺手摸走了 1 个【${baitConfig.name}】，剩余 ${result.remaining} 个！`;
        } else {
          message = fallbackRodDamage(
            effect.fallback_rod_damage || 10,
            "🐒 水猴没摸到鱼饵，恼怒地抓伤了鱼竿！",
          );
        }
        break;
      }

      case "lost_soul": {
        if (state.hasFogLamp) {
          message = "🌫️ 雾灯照出了回岸的路，捞尸人没能夺走你的倒影！";
          break;
        }
        fishingManager.applyLostSoul(e.user_id);
        const destination = fishingManager.moveToRandomUnlockedLocation(e.user_id, "lake");
        const destinationText = destination
          ? `${destination.emoji}【${destination.name}】`
          : "湖岸之外";
        message = `🪞 捞尸人把你的倒影留在湖底，并将你拖到了${destinationText}！\n` +
          "👻 你陷入失魂：无法完美收竿，金币与经验减半。返回雾隐湖并成功钓起一条非噩梦渔获才能恢复。";
        break;
      }

      case "ghost_debt": {
        const amount = reducePenalty(effect.amount || 120);
        const result = fishingManager.addGhostDebt(e.user_id, amount, effect.max_debt || 360);
        message = result.added > 0
          ? `🚢 幽灵船留下了一张亡者船票，新增 ${result.added} 樱花币债务，当前债务 ${result.total}！`
          : `🚢 亡者船票上的债务已经达到上限 ${result.total}，幽灵仍在催债……`;
        break;
      }

      case "deep_pressure": {
        const layers = reducePenalty(effect.layers || 4);
        const result = fishingManager.addDeepPressureLayers(
          e.user_id,
          layers,
          effect.max_layers || 8,
        );
        message = result.added > 0
          ? `🔔 潜水钟敲响，深压增加 ${result.added} 层，当前 ${result.total} 层！之后每竿额外消耗 1 点体力。`
          : `🔔 深压已经达到上限 ${result.total} 层，潜水钟的回响仍未停歇！`;
        break;
      }

      case "devour_buff": {
        const duration = reducePenalty(effect.duration_seconds || 1800);
        try {
          const result = await this.devourFishingBuff(e.group_id, e.user_id, duration);
          if (result) {
            const erodedMinutes = Math.max(1, Math.ceil(result.erodedSeconds / 60));
            const remainingText = result.remainingSeconds > 0
              ? `，还剩约 ${Math.ceil(result.remainingSeconds / 60)} 分钟`
              : "，Buff 已熄灭";
            message = `🌑 它吞掉了【${result.item.name}】${erodedMinutes} 分钟的星光${remainingText}！`;
          } else {
            nextExpGain = professionEffects.active
              ? Math.max(1, Math.round(expGain * professionEffects.penaltyReduction))
              : 0;
            message = nextExpGain > 0
              ? `🌑 找不到可吞噬的星光，它转而吞噬经验；深渊猎手保住了 ${nextExpGain} 点！`
              : "🌑 找不到可吞噬的星光，它转而吃掉了本次获得的全部经验！";
          }
        } catch (err) {
          logger.warn(`[钓鱼] 食星之影削减 Buff 失败: ${err.message}`);
          message = "🌑 星光剧烈闪烁，食星之影的力量没能稳定下来。";
        }
        break;
      }

      default:
        break;
    }

    return { message, expGain: nextExpGain };
  }

  recoverLostSoulAfterCatch(userId, state, fish, fishingManager, settleResult) {
    if (
      !state.hasLostSoul ||
      state.locationId !== "lake" ||
      fish.rarity === "噩梦" ||
      !settleResult?.success
    ) {
      return false;
    }
    return fishingManager.clearLostSoul(userId);
  }

  async finishSuccess(e, state, fishingManager) {
    const groupId = e.group_id;
    const userId = e.user_id;
    const stateKey = this.buildFishingStateKey(groupId, userId);
    const { fish, rodConfig, lineConfig } = state;

    if (!fishingSessions.beginSettlement(stateKey, state.id)) return false;
    this.finish("handleFishing", true);

    const rarity = RARITY_CONFIG[fish.rarity] || { color: "⚪", level: 0 };
    const fishWeight = fish.actualWeight;
    const fishImagePath = getFishImagePath(fish.id);
    // 图片资源尚未就位的鱼先不带图，避免整条渔获消息发送失败
    const fishImageSegment = fs.existsSync(fishImagePath)
      ? segment.image(`file:///${fishImagePath}`)
      : "";
    const economyManager = new EconomyManager(e);
    const settlement = new FishingSettlementService(e);
    const isPerfect = Boolean(state.isPerfect) && !state.hasLostSoul;
    const professionEffects = fishingManager.getNightmareProfessionEffects(userId);
    const nightmareEffects = fish.rarity === "噩梦"
      ? professionEffects
      : null;
    const lostSoulMultiplier = state.hasLostSoul
      ? getLostSoulRewardMultiplier(professionEffects.penaltyReduction)
      : 1;
    let expGain = Math.max(1, Math.round(
      rollFishExp(fish.rarity) *
      (isPerfect ? 2 : 1) *
      (isBossFish(fish) ? 3 : 1) *
      (nightmareEffects?.expMultiplier || 1) *
      (state.hasStarDouble ? 2 : 1) *
      (state.hasMonsterBait && fish.rarity === "噩梦" ? 2 : 1) *
      lostSoulMultiplier,
    ));
    const lostSoulPenaltyMsg = state.hasLostSoul
      ? `🪞 失魂影响：金币与经验 -${Math.round((1 - lostSoulMultiplier) * 100)}%\n`
      : "";
    const weatherTag = Array.isArray(fish.weather) && fish.weather.length > 0
      ? `（${fish.weather.map((name) => `${WEATHER_CONFIG[name]?.emoji || ""}${name}`).join("/")}限定）`
      : "";

    try {
      if (fish.rarity === "噩梦") {
        // 利维坦的逆鳞完全免疫噩梦惩罚；否则深渊猎手/河神垂青仍可单独保线
        const scaleShielded = Boolean(state.hasLeviathanScale);
        const abyssSaved = !scaleShielded &&
          nightmareEffects.lineSaveChance > 0 &&
          Math.random() < nightmareEffects.lineSaveChance;
        const lineSaved = scaleShielded || abyssSaved || Boolean(state.hasRiverBless);
        if (!lineSaved) {
          fishingManager.breakLine(userId, lineConfig.id);
        }

        let punishmentMsg = "";
        if (!scaleShielded) {
          const effectResult = await this.applyNightmareEffect({
            e,
            state,
            fishingManager,
            economyManager,
            professionEffects: nightmareEffects,
            expGain,
          });
          punishmentMsg = effectResult.message;
          expGain = effectResult.expGain;
        }

        const lineResultMsg = scaleShielded
          ? `🛡️ 利维坦的逆鳞震颤着吞噬了噩梦的恶意，你毫发无伤！\n`
          : lineSaved
            ? (abyssSaved
              ? `🗡️ 深渊猎手识破了噩梦的袭击，鱼线保住了！\n`
              : `🌊 河神的祝福护住了鱼线！\n`)
            : `💥 崩！鱼线被扯断了！\n🧵 失去了【${lineConfig.name}】\n`;
        const professionBonusMsg = nightmareEffects.active
          ? `🗡️ 深渊猎手：噩梦经验 +${Math.round((nightmareEffects.expMultiplier - 1) * 100)}%，惩罚降低 ${Math.round(nightmareEffects.penaltyReduction * 100)}%\n`
          : "";

        const settleResult = settlement.settleAttempt({
          sessionId: state.id,
          fishId: fish.id,
          success: true,
          earnings: 0,
          rodId: rodConfig.id,
          masteryGain: 1,
          expGain,
          weight: fish.actualWeight,
        });
        const dexProgress = getDexProgress(fishingManager, userId, settleResult);

        await e.reply([
          `😱 钓到了... 糟糕！是【${fish.name}】！\n`,
          fishImageSegment,
          `📝 ${fish.description}\n`,
          `📊 稀有度：${rarity.color}${fish.rarity}${weatherTag}\n`,
          lineResultMsg,
          professionBonusMsg,
          lostSoulPenaltyMsg,
          punishmentMsg + formatCatchTail(expGain, isPerfect, settleResult, dexProgress),
        ]);
        return true;
      }

      // 宝藏稀有度渔获＝钓点专属宝箱，整箱放进背包，之后用「#开宝箱」开启
      if (fish.isTreasure || fish.rarity === "宝藏") {
        const addResult = settlement.settleInventoryCatch({
          sessionId: state.id,
          fishId: fish.id,
          rodId: rodConfig.id,
          capacity: economyManager.getBagCapacity(e),
          expGain,
          weight: fish.actualWeight,
        });
        const dexProgress = getDexProgress(fishingManager, userId, addResult);
        const newMastery = fishingManager.getRodMastery(userId, rodConfig.id);
        const soulRecovered = this.recoverLostSoulAfterCatch(
          userId,
          state,
          fish,
          fishingManager,
          addResult,
        );
        const soulRecoveryMsg = soulRecovered
          ? "\n🪞 水面重新映出了你的身影，失魂状态已经解除！"
          : "";

        if (addResult.added) {
          await e.reply([
            `🎉 钓到了【${fish.name}】！\n`,
            fishImageSegment,
            `📝 ${fish.description}\n`,
            `📊 稀有度：${rarity.color}${fish.rarity}${weatherTag}\n`,
            `📈 熟练度：${newMastery}\n`,
            lostSoulPenaltyMsg,
            `🗝️ 宝箱已放入背包，发送「#开宝箱」开启它！${formatCatchTail(expGain, isPerfect, addResult, dexProgress)}${soulRecoveryMsg}`,
          ]);
        } else {
          await e.reply([
            `🎉 钓到了【${fish.name}】！\n`,
            fishImageSegment,
            `📝 ${fish.description}\n`,
            `📊 稀有度：${rarity.color}${fish.rarity}${weatherTag}\n`,
            `📈 熟练度：${newMastery}\n`,
            lostSoulPenaltyMsg,
            `❌ 背包已满，无法放入！宝箱掉回水里了...${formatCatchTail(expGain, isPerfect, addResult, dexProgress)}${soulRecoveryMsg}`,
          ]);
        }
        return true;
      }

      const price = await calculateFishPrice(fish, fishingManager);

      const buffMultiplier = await this.getFishSellBuffMultiplier(groupId, userId);
      const merchantMultiplier = fishingManager.getMerchantCoinMultiplier(userId);
      const priceBeforeLostSoul = Math.round(price * buffMultiplier * merchantMultiplier);
      const finalPrice = Math.round(priceBeforeLostSoul * lostSoulMultiplier);

      const settleResult = settlement.settleCoinCatch({
        sessionId: state.id,
        fishId: fish.id,
        earnings: finalPrice,
        rodId: rodConfig.id,
        note: `钓鱼出售 ${fish.name}`,
        expGain,
        weight: fish.actualWeight,
      });
      const dexProgress = getDexProgress(fishingManager, userId, settleResult);
      const newMastery = fishingManager.getRodMastery(userId, rodConfig.id);
      const soulRecovered = this.recoverLostSoulAfterCatch(
        userId,
        state,
        fish,
        fishingManager,
        settleResult,
      );

      let priceBoostMsg = "";
      try {
        if (await fishingManager.isFishPriceBoostActive()) {
          priceBoostMsg = `😱 鱼雷恐慌中，鱼价1.5倍！\n`;
        }
      } catch (err) {
        logger.warn(`[钓鱼] 获取鱼雷鱼价状态失败: ${err.message}`);
      }

      let buffMsg = "";
      if (buffMultiplier > 1) {
        buffMsg = `✨ 金币加成：×${buffMultiplier}！\n`;
      }

      let merchantMsg = "";
      if (merchantMultiplier > 1) {
        const bonusPercent = Math.round((merchantMultiplier - 1) * 100);
        merchantMsg = `💰 商人加成：+${bonusPercent}%！\n`;
      }

      const debtMsg = settleResult.debtPaid > 0
        ? `👻 亡者船票扣走 ${settleResult.debtPaid} 樱花币，剩余债务 ${settleResult.remainingDebt}\n`
        : "";
      const soulRecoveryMsg = soulRecovered
        ? `🪞 水面重新映出了你的身影，失魂状态已经解除！\n`
        : "";
      const earningsMsg = settleResult.debtPaid > 0
        ? `💰 价值：${finalPrice} 樱花币｜实际到账：${settleResult.earnings} 樱花币`
        : `💰 价值：${finalPrice} 樱花币`;

      const bossVictory = isBossFish(fish);
      const resultMsg = [
        bossVictory
          ? `🏆 单人讨伐成功！击败了${state.locationId ? "当前钓点的" : ""}首领【${fish.name}】！\n`
          : `🎉 钓到了【${fish.name}】！\n`,
        fishImageSegment,
        `📝 ${fish.description}\n`,
        bossVictory
          ? `👑 类型：钓点首领｜⚔️ 攻击力：${fish.attack}｜🌀 ${fish.boss_mechanic.name}\n`
          : `📊 稀有度：${rarity.color}${fish.rarity}${weatherTag}\n`,
        `⚖️ 重量：${fishWeight}\n`,
        bossVictory
          ? `🎮 玩家操作：${state.fightingRounds} 次｜承受反击：${state.bossAttackRounds || 0} 次\n`
          : "",
        `📈 熟练度：${newMastery}\n`,
        priceBoostMsg,
        buffMsg,
        merchantMsg,
        lostSoulPenaltyMsg,
        debtMsg,
        soulRecoveryMsg,
        `${earningsMsg}${formatCatchTail(expGain, isPerfect, settleResult, dexProgress)}`,
      ];
      await e.reply(resultMsg);
      return true;
    } finally {
      try {
        await this.setCooldownAndIncrement(groupId, userId);
      } catch (err) {
        logger.error(`[钓鱼] 写入冷却失败: ${err.stack || err}`);
      } finally {
        if (state.cleanup) state.cleanup();
      }
    }
  }

  async getFishSellBuffMultiplier(groupId, userId) {
    // 双倍金币卡与双倍星辉卡同为 2 倍，同时生效不叠加
    const doubleKeys = [
      `sakura:fishing:buff:item_card_double_coin:${groupId}:${userId}`,
      `sakura:fishing:buff:item_card_star_double:${groupId}:${userId}`,
    ];
    try {
      const values = await Promise.all(doubleKeys.map((key) => redis.get(key)));
      if (values.some(Boolean)) return 2;
    } catch (err) {
      logger.warn(`[钓鱼] 获取金币加成失败，按原价结算: ${err.message}`);
    }
    return 1;
  }


  pondWeatherForecast = Command(/^#?(鱼塘|钓鱼)天气$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    const now = Date.now();
    const current = getWeatherByTime(now);
    const next = getWeatherByTime(now + 60 * 60 * 1000);
    const minutesLeft = Math.ceil((60 * 60 * 1000 - (now % (60 * 60 * 1000))) / 60000);

    await e.reply([
      `🌤️ 鱼塘天气预报\n`,
      `当前：${current.emoji}${current.name}（约 ${minutesLeft} 分钟后轮换）\n`,
      `下一小时：${next.emoji}${next.name}\n`,
      `🐟 某些鱼儿只在特定天气出没...`,
    ]);
    return true;
  });

  locationList = Command(/^#?钓点(列表)?$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    const fishingManager = new FishingManager(e.group_id);
    const currentId = fishingManager.getFishingLocation(e.user_id);
    const fishingLevel = fishingManager.getUserFishingLevel(e.user_id);

    const lines = Object.entries(FISHING_LOCATIONS).map(([id, config]) => {
      const currentMark = id === currentId ? "（当前）" : "";
      const lockMark = fishingLevel < config.unlockLevel
        ? ` 🔒 Lv.${config.unlockLevel} 解锁`
        : "";
      const boss = fishData.find((fish) => (
        isBossFish(fish) && fish.locations?.includes(id)
      ));
      return `${config.emoji}【${config.name}】${currentMark}${lockMark}\n` +
        `   ${config.description}` +
        (boss
          ? `\n   👑 首领：${boss.name}（难度 ${boss.difficulty}｜生命 ${boss.hp}｜攻击 ${boss.attack}）`
          : "");
    });

    await e.reply(
      `🗺️ 钓点一览\n━━━━━━━━━━━━━━━━\n` +
      lines.join("\n") +
      `\n━━━━━━━━━━━━━━━━\n` +
      `🎓 当前钓鱼等级：Lv.${fishingLevel}\n` +
      `📝 发送「#前往钓点 钓点名」切换`
    );
    return true;
  });

  gotoLocation = Command(/^#?(前往|切换)钓点\s*(.+)$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    const targetName = e.msg.match(/^#?(前往|切换)钓点\s*(.+)$/)[2].trim();
    const fishingManager = new FishingManager(e.group_id);

    const entry = Object.entries(FISHING_LOCATIONS).find(
      ([, config]) => config.name === targetName,
    );
    if (!entry) {
      const validNames = Object.values(FISHING_LOCATIONS).map((config) => config.name).join("、");
      await e.reply(`找不到钓点【${targetName}】\n可选钓点：${validNames}`, 10);
      return true;
    }

    const [locationId, locationConfig] = entry;
    if (fishingManager.getFishingLocation(e.user_id) === locationId) {
      await e.reply(`你已经在${locationConfig.emoji}【${locationConfig.name}】了~`, 10);
      return true;
    }

    const fishingLevel = fishingManager.getUserFishingLevel(e.user_id);
    if (fishingLevel < locationConfig.unlockLevel) {
      await e.reply(
        `🔒 ${locationConfig.emoji}【${locationConfig.name}】尚未解锁\n` +
        `需要钓鱼等级 Lv.${locationConfig.unlockLevel}，当前 Lv.${fishingLevel}\n` +
        `继续钓鱼提升等级吧~`,
        10
      );
      return true;
    }

    const lockKey = this.buildFishingLockKey(e.group_id, e.user_id);
    if (await redis.exists(lockKey)) {
      await e.reply("钓鱼过程中不能切换钓点，请先完成本次钓鱼。", 10);
      return true;
    }

    fishingManager.setFishingLocation(e.user_id, locationId);
    const localBoss = fishData.find((fish) => (
      isBossFish(fish) && fish.locations?.includes(locationId)
    ));
    await e.reply(
      `🚶 收拾好装备，来到了${locationConfig.emoji}【${locationConfig.name}】\n` +
      `${locationConfig.description}\n` +
      (localBoss
        ? `👑 此地首领：【${localBoss.name}】（难度 ${localBoss.difficulty}｜生命 ${localBoss.hp}｜攻击 ${localBoss.attack}）\n`
        : "") +
      `🎣 发送「钓鱼」开始垂钓吧~`
    );
    return true;
  });

  equipRod = Command(/^#?装备鱼竿\s*(.+)$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    if (await this.rejectEquipmentChangeWhileFishing(e)) return true;
    const rodName = e.msg.match(/^#?装备鱼竿\s*(.+)$/)[1].trim();
    const fishingManager = new FishingManager(e.group_id);

    const rod = fishingManager.getAllRods().find((r) => r.name === rodName);
    if (!rod) {
      await e.reply(`找不到【${rodName}】，请检查名称~`, 10);
      return true;
    }

    if (!fishingManager.hasRod(e.user_id, rod.id)) {
      await e.reply(`您还没有【${rod.name}】，请先购买~`, 10);
      return true;
    }

    fishingManager.equipRod(e.user_id, rod.id);
    await e.reply(`🎣 装备更替！当前使用【${rod.name}】，祝满载而归！`);
    return true;
  });

  equipBait = Command(/^#?装备鱼饵\s*(.+)$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    if (await this.rejectEquipmentChangeWhileFishing(e)) return true;
    const baitName = e.msg.match(/^#?装备鱼饵\s*(.+)$/)[1].trim();
    const fishingManager = new FishingManager(e.group_id);

    const bait = fishingManager.getAllBaits().find((b) => b.name === baitName);
    if (!bait) {
      await e.reply(`找不到【${baitName}】，请检查名称~`, 10);
      return true;
    }

    const count = fishingManager.getBaitCount(e.user_id, bait.id);
    if (count <= 0) {
      await e.reply(`背包里没有【${bait.name}】了，请先补充库存~`, 10);
      return true;
    }

    fishingManager.equipBait(e.user_id, bait.id);
    await e.reply(
      `🪱 饵料挂好啦！当前使用【${bait.name}】，库存 ${count} 个。` +
      (bait.boss_bait ? "\n👑 下一竿将直接挑战当前钓点首领，请确认装备与体力！" : "")
    );
    return true;
  });

  equipLine = Command(/^#?装备鱼线\s*(.+)$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    if (await this.rejectEquipmentChangeWhileFishing(e)) return true;
    const lineName = e.msg.match(/^#?装备鱼线\s*(.+)$/)[1].trim();
    const fishingManager = new FishingManager(e.group_id);

    const line = fishingManager.getAllLines().find((l) => l.name === lineName);
    if (!line) {
      await e.reply(`找不到【${lineName}】，请检查名称~`, 10);
      return true;
    }

    if (!fishingManager.hasLine(e.user_id, line.id)) {
      await e.reply(`您还没有【${line.name}】，请先购买~`, 10);
      return true;
    }

    fishingManager.equipLine(e.user_id, line.id);
    const durability = fishingManager.getLineDurabilityInfo(e.user_id, line.id);
    await e.reply(
      `🧵 鱼线换好啦！当前使用【${line.name}】。\n` +
      `耐久：${durability.currentDurability}/${durability.maxDurability}`,
    );
    return true;
  });

  fishingStatus = Command(/^#?钓鱼(状态|信息)$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    const groupId = e.group_id;
    const userId = e.user_id;
    const fishingManager = new FishingManager(groupId);
    const locationConfig = getFishingLocationConfig(fishingManager.getFishingLocation(userId));
    let weather = getWeatherByTime();
    const staminaStatus = fishingManager.getFishingStaminaStatus(userId);
    const equippedRodId = fishingManager.getEquippedRod(userId);
    const equippedLineId = fishingManager.getEquippedLine(userId);
    const equippedBaitId = fishingManager.getEquippedBait(userId);
    const equipment = [];

    const rodConfig = equippedRodId ? fishingManager.getRodConfig(equippedRodId) : null;
    if (rodConfig) {
      const mastery = fishingManager.getRodMastery(userId, equippedRodId);
      const durability = fishingManager.getRodDurabilityInfo(userId, equippedRodId);
      equipment.push({
        id: equippedRodId,
        name: rodConfig.name,
        handler: "fishing_rod",
        details: [
          `熟练度 ${mastery}`,
          `耐久 ${durability.currentDurability}/${durability.maxDurability}`,
        ],
      });
    } else {
      equipment.push({ name: "未装备鱼竿", handler: "fishing_rod", details: [] });
    }

    const lineConfig = equippedLineId ? fishingManager.getLineConfig(equippedLineId) : null;
    if (lineConfig) {
      const durability = fishingManager.getLineDurabilityInfo(userId, equippedLineId);
      equipment.push({
        id: equippedLineId,
        name: lineConfig.name,
        handler: "fishing_line",
        details: [`耐久 ${durability.currentDurability}/${durability.maxDurability}`],
      });
    } else {
      equipment.push({ name: "未装备鱼线", handler: "fishing_line", details: [] });
    }

    const baitConfig = equippedBaitId ? fishingManager.getBaitConfig(equippedBaitId) : null;
    if (baitConfig) {
      const baitCount = fishingManager.getBaitCount(userId, equippedBaitId);
      equipment.push({
        id: equippedBaitId,
        name: baitConfig.name,
        handler: "fishing_bait",
        details: [
          `库存 ${baitCount} 个`,
          baitConfig.boss_bait ? "下一竿挑战当前钓点首领" : "已准备就绪",
        ],
      });
    } else {
      equipment.push({ name: "未装备鱼饵", handler: "fishing_bait", details: [] });
    }

    const effects = [];
    const formatEffectTime = (ttl) => {
      const minutes = Math.max(1, Math.ceil(ttl / 60));
      if (minutes < 60) return `${minutes} 分钟`;
      const hours = Math.floor(minutes / 60);
      const remainingMinutes = minutes % 60;
      return remainingMinutes > 0
        ? `${hours} 小时 ${remainingMinutes} 分钟`
        : `${hours} 小时`;
    };

    // 所有限时道具 buff 都来自 special_items.yaml 中 type: buff 的条目
    const buffItems = new ShopManager().getAllItems().filter((item) => item.type === "buff");
    const buffTtls = await Promise.all(
      buffItems.map((item) =>
        redis.ttl(`sakura:fishing:buff:${item.id}:${groupId}:${userId}`).catch(() => 0),
      ),
    );
    for (const [index, item] of buffItems.entries()) {
      const ttl = buffTtls[index];
      if (ttl > 0) {
        if (item.id === "item_lamp_fog") {
          weather = { name: "雾", ...WEATHER_CONFIG["雾"] };
        }
        effects.push({
          icon: item.icon || "✨",
          name: item.name,
          detail: `剩余 ${formatEffectTime(ttl)}`,
          tone: "positive",
        });
      }
    }

    const wishTtl = await redis.ttl(`sakura:fishing:wish:${groupId}:${userId}`).catch(() => 0);
    if (wishTtl > 0) {
      effects.push({
        icon: "🌠",
        name: "星愿",
        detail: `下一竿必中传说 · 剩余 ${formatEffectTime(wishTtl)}`,
        tone: "positive",
      });
    }

    const nightmareStatus = fishingManager.getNightmareStatus(userId);
    const curseStatus = nightmareStatus.curse;
    if (curseStatus.actualLayers > 0) {
      effects.push({
        icon: "☠️",
        name: "诅咒",
        detail: curseStatus.isPranked
          ? `显示 ${curseStatus.displayedLayers} 层 · 诅咒其实还在`
          : `剩余 ${curseStatus.displayedLayers} 层`,
        tone: "danger",
      });
    }
    if (nightmareStatus.brideThreadLayers > 0) {
      effects.push({
        icon: "💍",
        name: "冥婚红线",
        detail: curseStatus.actualLayers > 0
          ? `${nightmareStatus.brideThreadLayers} 层 · 当前被普通诅咒压制`
          : `${nightmareStatus.brideThreadLayers} 层 · 下一竿偏向噩梦`,
        tone: "danger",
      });
    }
    if (nightmareStatus.lostSoul) {
      effects.push({
        icon: "🪞",
        name: "失魂",
        detail: "无法完美收竿，金币与经验降低",
        tone: "danger",
      });
    }
    if (nightmareStatus.ghostDebt > 0) {
      effects.push({
        icon: "🚢",
        name: "亡者船票",
        detail: `尚欠 ${nightmareStatus.ghostDebt} 樱花币`,
        tone: "warning",
      });
    }
    if (nightmareStatus.deepPressureLayers > 0) {
      effects.push({
        icon: "🔔",
        name: "深压回响",
        detail: `${nightmareStatus.deepPressureLayers} 层 · 下竿体力消耗增加`,
        tone: "warning",
      });
    }

    const dailyKey = `sakura:economy:daily_fishing_count:${groupId}:${userId}`;
    const dailyCount = await redis.get(dailyKey);
    const todayCount = dailyCount ? parseInt(dailyCount) : 0;
    const userData = fishingManager.getUserData(userId);
    const fishingLevel = fishingManager.getUserFishingLevel(userId);
    const fishingExp = Math.max(0, Number(userData.fishing_exp) || 0);
    const professionInfo = fishingManager.getUserProfession(userId);
    const professionConfig = professionInfo.profession
      ? FishingManager.getProfessionConfig(professionInfo.profession)
      : null;
    const professionLevelConfig = professionConfig?.levels?.[professionInfo.level];
    const economyManager = new EconomyManager(e);
    const balance = economyManager.getCoins(e);

    const dangerousTorpedoes = fishingManager.getAvailableTorpedoCount(userId);
    const deployedTorpedo = fishingManager.getUserTorpedoCount(userId) > 0;
    const torpedoRemainingMinutes = deployedTorpedo
      ? fishingManager.getUserTorpedoRemainingMinutes(userId)
      : 0;
    const totalTorpedoes = fishingManager.getTotalTorpedoCount();
    let priceBoostActive = false;
    let priceBoostRemainingMinutes = 0;
    try {
      priceBoostActive = await fishingManager.isFishPriceBoostActive();
      priceBoostRemainingMinutes = priceBoostActive
        ? await fishingManager.getFishPriceBoostRemainingMinutes()
        : 0;
    } catch (err) {
      logger.warn(`[钓鱼状态] 读取鱼价加成失败: ${err.message}`);
    }

    try {
      const generator = new FishingUiImageGenerator();
      const image = await generator.generateFishingStatusImage({
        userId,
        nickname: e.sender?.card || e.sender?.nickname || String(userId),
        avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=640`,
        balance,
        location: locationConfig,
        weather,
        level: fishingLevel,
        exp: {
          current: fishingExp,
          levelStart: getFishingLevelExp(fishingLevel),
          levelEnd: getFishingLevelExp(fishingLevel + 1),
        },
        profession: professionConfig
          ? {
            icon: professionConfig.icon,
            name: professionConfig.name,
            title: professionLevelConfig?.title || `Lv.${professionInfo.level}`,
          }
          : { icon: "🎓", name: "尚未选择职业", title: "发送 #钓鱼职业 查看" },
        stamina: staminaStatus,
        equipment,
        effects,
        torpedo: {
          dangerousCount: dangerousTorpedoes,
          deployed: deployedTorpedo,
          remainingMinutes: torpedoRemainingMinutes,
          totalCount: totalTorpedoes,
          priceBoostActive,
          priceBoostRemainingMinutes,
        },
        stats: {
          todayCount,
          totalCatch: userData.total_catch || 0,
          totalEarnings: userData.total_earnings || 0,
          torpedoHits: userData.torpedo_hits || 0,
        },
      });
      await e.reply(segment.image(image));
    } catch (err) {
      logger.error(`[钓鱼状态] 生成状态图片失败: ${err.stack || err}`);
      await e.reply("钓鱼状态图片生成失败，请稍后再试。", 10);
    }

    return true;
  });

  fishingDex = Command(/^#?钓鱼(图鉴|记录)\s*(.*)$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;

    if (fishData.length === 0) {
      await e.reply("钓鱼数据暂不可用，请联系管理员检查配置。", 10);
      return true;
    }

    // 可选钓点参数：筛选该钓点可见的鱼（通用+交叉+独占）；纯数字是旧版页码参数，忽略
    const dexArg = e.msg.replace(/^#?钓鱼(图鉴|记录)/, "").trim();
    let dexLocationId = null;
    if (dexArg && !/^\d+$/.test(dexArg)) {
      const entry = Object.entries(FISHING_LOCATIONS).find(
        ([, config]) => config.name === dexArg,
      );
      if (!entry) {
        const validNames = Object.values(FISHING_LOCATIONS).map((config) => config.name).join("、");
        await e.reply(`找不到钓点【${dexArg}】\n可选钓点：${validNames}`, 10);
        return true;
      }
      dexLocationId = entry[0];
    }
    const dexLocationConfig = dexLocationId ? getFishingLocationConfig(dexLocationId) : null;
    const dexFishData = dexLocationId
      ? fishData.filter((fish) => !fish.locations?.length || fish.locations.includes(dexLocationId))
      : fishData;

    const targetId = e.user_id;
    const fishingManager = new FishingManager(e.group_id);
    const history = fishingManager.getUserCatchHistory(targetId);

    if (history.length === 0) {
      await e.reply("空空如也... 图鉴一片空白，快去钓第一条鱼吧！", 10);
      return true;
    }

    let targetName = targetId;
    try {
      const info = await e.getInfo(targetId);
      if (info) {
        targetName = info.card || info.nickname || targetId;
      }
    } catch (err) { }

    // 按稀有度分区组装三态条目：未发现 / 目击（搏斗过但从未钓上）/ 已收录
    const historyMap = new Map(history.map((row) => [row.fishId, row]));
    const sections = Object.keys(RARITY_CONFIG)
      .map((rarity) => {
        const entries = dexFishData
          .filter((fish) => fish.rarity === rarity)
          .map((fish) => {
            const record = historyMap.get(fish.id);
            const successCount = record?.successCount || 0;
            const encounterCount = record?.count || 0;
            let status = "unknown";
            if (successCount > 0) status = "collected";
            else if (encounterCount > 0) status = "sighted";
            return {
              fishId: fish.id,
              name: isBossFish(fish) ? `👑${fish.name}` : fish.name,
              rarity,
              status,
              successCount,
              escapeCount: Math.max(0, encounterCount - successCount),
              maxWeight: record?.maxWeight || 0,
            };
          });
        return {
          rarity,
          collected: entries.filter((entry) => entry.status === "collected").length,
          total: entries.length,
          entries,
        };
      })
      .filter((section) => section.total > 0);

    const collected = sections.reduce((sum, section) => sum + section.collected, 0);
    const sighted = sections.reduce(
      (sum, section) =>
        sum + section.entries.filter((entry) => entry.status === "sighted").length,
      0,
    );
    const userData = fishingManager.getUserData(targetId);

    try {
      const generator = new FishingImageGenerator();
      const dexImageData = {
        targetName,
        targetId,
        userData,
        sections,
        collected,
        sighted,
        total: dexFishData.length,
        locationLabel: dexLocationConfig
          ? `${dexLocationConfig.emoji}${dexLocationConfig.name}`
          : null,
      };

      if (dexLocationConfig) {
        const image = await generator.generateFishDex(dexImageData);
        await e.reply(segment.image(image));
      } else {
        const images = await generator.generateFishDexPages(dexImageData);
        await e.sendForwardMsg(
          images.map((image) => segment.image(image)),
          {
            source: `${targetName} 的钓鱼图鉴`,
            prompt: `📖 点击查看钓鱼图鉴（共 ${images.length} 页）`,
            news: [
              { text: `📖 已收录 ${collected}/${dexFishData.length}` },
              { text: `👀 目击 ${sighted}` },
              { text: `📚 共 ${images.length} 页` },
            ],
          },
        );
      }
    } catch (err) {
      logger.error(`生成钓鱼图鉴图片失败: ${err.stack || err}`);
    }

    return true;
  });

  deployTorpedo = Command(/^#?(投放|放置)鱼雷$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    const groupId = e.group_id;
    const userId = e.user_id;

    const fishingManager = new FishingManager(groupId);
    const result = fishingManager.deployTorpedo(userId);

    if (result.success) {
      const totalTorpedoes = fishingManager.getTotalTorpedoCount();
      const durationHours = Math.ceil(fishingManager.getTorpedoDurationSeconds() / 3600);
      await e.reply([
        `💣 嘿嘿嘿... 鱼雷已悄悄投放到鱼塘中！\n`,
        `🎯 静待猎物上钩...\n`,
        `⏳ ${durationHours} 小时后未触发将自动失效\n`,
        `📊 当前鱼塘共有 ${totalTorpedoes} 个鱼雷潜伏中~`
      ]);
    } else {
      const message = result.reason === "not_owned"
        ? "💣 你背包里没有鱼雷！\n快去「商店」购买吧~"
        : "💣 你已经在鱼塘里投放了一个鱼雷！\n一个人最多只能投放一个鱼雷哦~";
      await e.reply(message, 10);
    }

    return true;
  });

  fishingRanking = Command(/^#?钓鱼(排行|榜)$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    const fishingManager = new FishingManager(e.group_id);
    const rankingList = fishingManager.getFishingRanking(10);

    if (rankingList.length === 0) {
      await e.reply("暂时还没有人上榜哦~ 快去钓鱼吧！", 10);
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
        } catch (err) { }

        return {
          rank: index + 1,
          userId: item.userId,
          nickname: String(nickname),
          avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${item.userId}&s=640`,
          totalEarnings: item.totalEarnings,
          totalCatch: item.totalCatch,
        };
      })
    );

    const data = {
      title: "🎣 钓鱼排行榜",
      list,
    };

    try {
      const generator = new FishingImageGenerator();
      const image = await generator.generateFishingRankingImage(data);
      await e.reply(segment.image(image));
    } catch (err) {
      logger.error(`生成钓鱼排行榜图片失败: ${err}`);
    }
    return true;
  });


  viewProfession = Command(/^#?(钓鱼)?职业(列表|一览)?$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    const fishingManager = new FishingManager(e.group_id);
    const professionInfo = fishingManager.getUserProfession(e.user_id);
    const requirements = FishingManager.getUnlockRequirements();
    const professions = FishingManager.getAllProfessions();
    const fishingLevel = fishingManager.getUserFishingLevel(e.user_id);

    const msgs = [];

    if (!professionInfo.profession) {
      const canChoose = fishingManager.canChooseProfession(e.user_id);

      if (canChoose) {
        msgs.push([
          `🎓 你还没有选择职业！\n`,
          `📊 钓鱼等级: Lv.${fishingLevel} (已满足解锁条件)\n\n`,
          `📝 发送「#选择职业 职业名」来选择\n`,
          `   例如: #选择职业 宝藏猎人`
        ].join(''));
      } else {
        const remaining = requirements.choose_fishing_level - fishingLevel;
        msgs.push([
          `🎓 你还没有职业\n`,
          `📊 钓鱼等级: Lv.${fishingLevel}/Lv.${requirements.choose_fishing_level}\n`,
          `🔒 还需要提升 ${remaining} 级才能解锁职业选择！`
        ].join(''));
      }
    } else {
      const professionConfig = FishingManager.getProfessionConfig(professionInfo.profession);
      const currentLevel = professionInfo.level;
      const levelConfig = professionConfig.levels[currentLevel];
      const canAdvance = fishingManager.canAdvanceProfession(e.user_id);

      let advanceInfo = "";
      if (currentLevel < 2) {
        if (canAdvance) {
          const nextLevelConfig = professionConfig.levels[2];
          advanceInfo = `\n\n🆙 可以进阶到「${nextLevelConfig.title}」！发送「#进阶职业」`;
        } else {
          const remaining = requirements.advance_fishing_level - fishingLevel;
          advanceInfo = `\n\n📊 进阶需要: 钓鱼 Lv.${requirements.advance_fishing_level} (还差${remaining}级)`;
        }
      } else {
        advanceInfo = `\n\n🏆 已达到最高等级！`;
      }

      let bonusInfo = "";
      switch (professionInfo.profession) {
        case 'treasure_hunter':
          const treasureBonus = fishingManager.getTreasureBonus(e.user_id);
          bonusInfo = `\n💎 当前宝藏概率加成: +${treasureBonus}权重`;
          break;
        case 'fishing_master':
          const equippedRod = fishingManager.getEquippedRod(e.user_id);
          if (equippedRod) {
            const mastery = fishingManager.getRodMastery(e.user_id, equippedRod);
            bonusInfo = `\n🎣 当前鱼竿熟练度: ${mastery}，职业强化已生效`;
          } else {
            bonusInfo = `\n🎣 装备鱼竿后，职业强化会随熟练度生效`;
          }
          break;
        case 'merchant':
          const coinMultiplier = fishingManager.getMerchantCoinMultiplier(e.user_id);
          const bonusPercent = Math.round((coinMultiplier - 1) * 100);
          bonusInfo = `\n💰 当前金币收益加成: +${bonusPercent}%`;
          break;
        case 'abyss_hunter': {
          const effects = fishingManager.getNightmareProfessionEffects(e.user_id);
          const expBonus = Math.round((effects.expMultiplier - 1) * 100);
          const penaltyReduction = Math.round(effects.penaltyReduction * 100);
          const lineSaveChance = Math.round(effects.lineSaveChance * 100);
          bonusInfo = `\n🗡️ 噩梦经验: +${expBonus}%｜惩罚降低: ${penaltyReduction}%｜保住鱼线: ${lineSaveChance}%`;
          break;
        }
      }

      msgs.push([
        `🎓 我的职业\n\n`,
        `${professionConfig.icon}【${professionConfig.name}】\n`,
        `🏅 称号: ${levelConfig.title}\n`,
        `📝 ${professionConfig.description}\n`,
        bonusInfo,
        advanceInfo
      ].join(''));
    }

    for (const p of professions) {
      const level1 = p.levels[1];
      const level2 = p.levels[2];
      const isCurrentProfession = professionInfo.profession === p.id;
      const currentMark = isCurrentProfession ? ' ✅ 当前职业' : '';

      msgs.push([
        `${p.icon}【${p.name}】${currentMark}\n`,
        `📝 ${p.description}\n\n`,
        `⭐ 1级「${level1.title}」\n`,
        `   效果: ${level1.description}\n\n`,
        `⭐ 2级「${level2.title}」\n`,
        `   效果: ${level2.description}`
      ].join(''));
    }

    msgs.push([
      `📌 解锁条件\n\n`,
      `🔓 钓鱼 Lv.${requirements.choose_fishing_level} → 可选择1级职业\n`,
      `🆙 钓鱼 Lv.${requirements.advance_fishing_level} → 可进阶到2级\n\n`,
      `⚠️ 每人只能选择一个职业，选择后不可更换！`
    ].join(''));

    let statusText = "未选择职业";
    if (professionInfo.profession) {
      const config = FishingManager.getProfessionConfig(professionInfo.profession);
      const levelConfig = config.levels[professionInfo.level];
      statusText = `${config.icon}${levelConfig.title}`;
    }

    await e.sendForwardMsg(msgs, {
      prompt: "🎣 钓鱼职业系统",
      source: "钓鱼系统",
      news: [
        { text: `当前职业: ${statusText}` },
        { text: `可选职业: ${professions.length}个` }
      ]
    });

    return true;
  });

  chooseProfession = Command(/^#?选择职业\s*(.+)$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    const professionName = e.msg.match(/^#?选择职业\s*(.+)$/)[1].trim();
    const fishingManager = new FishingManager(e.group_id);

    const professions = FishingManager.getAllProfessions();
    const targetProfession = professions.find(p => p.name === professionName);

    if (!targetProfession) {
      const validNames = professions.map(p => p.name).join('、');
      await e.reply(`❌ 找不到职业【${professionName}】\n可选职业: ${validNames}`, 10);
      return true;
    }

    const result = fishingManager.chooseProfession(e.user_id, targetProfession.id);

    if (result.success) {
      const levelConfig = targetProfession.levels[1];
      const requirements = FishingManager.getUnlockRequirements();
      await e.reply([
        `🎉 ${result.msg}\n\n`,
        `${targetProfession.icon}【${targetProfession.name}】\n`,
        `🏅 称号: ${levelConfig.title}\n`,
        `📝 ${targetProfession.description}\n`,
        `⭐ 效果: ${levelConfig.description}\n\n`,
        `💡 钓鱼达到 Lv.${requirements.advance_fishing_level} 后可以进阶！`
      ]);
    } else {
      await e.reply(`❌ ${result.msg}`, 10);
    }
    return true;
  });

  advanceProfession = Command(/^#?进阶职业$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    const fishingManager = new FishingManager(e.group_id);

    const result = fishingManager.advanceProfession(e.user_id);

    if (result.success) {
      const professionConfig = result.profession;
      const levelConfig = professionConfig.levels[2];
      await e.reply([
        `🎉 ${result.msg}\n\n`,
        `${professionConfig.icon}【${professionConfig.name}】\n`,
        `🏅 称号: ${levelConfig.title}\n`,
        `📝 ${professionConfig.description}\n`,
        `⭐ 效果: ${levelConfig.description}\n\n`,
        `🏆 已达到最高等级！`
      ]);
    } else {
      await e.reply(`❌ ${result.msg}`, 10);
    }
    return true;
  });
}
