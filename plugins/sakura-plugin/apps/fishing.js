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
  shouldRecordFishEncounter,
} from "../lib/fishing/session.js";
import {
  BOSS_ATTACK_INTERVAL_MS,
  BOSS_BAIT_ID,
  FISH_FIGHT_STATE,
  FISHING_BENEFIT_DURATION_SECONDS,
  FISHING_COOLDOWN_SECONDS,
  FISHING_TIME_SAND_COOLDOWN_SECONDS,
  FISHING_LOCATIONS,
  PERFECT_EXP_MULTIPLIER,
  RARITY_CONFIG,
  SHINY_DIFFICULTY_MULTIPLIER,
  SHINY_EXP_MULTIPLIER,
  SHINY_PRICE_MULTIPLIER,
  TORPEDO_HOOK_WEIGHT_PER_ITEM,
  TORPEDO_PRICE_BOOST_MULTIPLIER,
  TORPEDO_ROD_DAMAGE,
  WEATHER_CONFIG,
  calculateBossLineDurability,
  calculateBossCatchReward,
  calculateCorpseFisherRodDamage,
  calculateForcePullSuccessRate,
  calculateLegacyFishPrice,
  calculateNormalTugActionEffects,
  createProgressBar,
  getBrideMarkLayers,
  getBossAttackCooldownRemaining,
  getBossFightTimeoutMs,
  getFishFightStateChangeDelay,
  getFishFightStateConfig,
  getFishingLocationConfig,
  getFishingEnvironmentModifiers,
  getFishingLevelExp,
  getWeatherByTime,
  isBossFish,
  isPerfectCatch,
  resolveBossAttack,
  resolveBossLineDamage,
  resolveNightmareRarityAfflictions,
  rollFishExp,
  rollFishingBiteWaitMs,
  rollBossPlayerDamage,
  rollNormalTugPressure,
  rollShiny,
  selectNextFishFightState,
  selectBossFromData,
  selectFishFromData,
  validateLegacyFishData,
} from "../lib/fishing/rules.js";
import { getShinyFishImagePath } from "../lib/fishing/shinyImage.js";
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
  const perfectMsg = isPerfect ? `\n⚡ 完美收竿！经验×${PERFECT_EXP_MULTIPLIER}！` : "";
  const levelUp = settleResult?.levelUp;
  const levelUpMsg = levelUp ? `\n🎉 钓鱼等级提升至 Lv.${levelUp.to}` : "";
  const staminaResetMsg = Number.isFinite(levelUp?.staminaForcedTo)
    ? `\n🪝 捞尸人的力量压过升级恢复，体力仍被强制为 ${levelUp.staminaForcedTo}`
    : Number.isFinite(levelUp?.staminaResetTo)
      ? `\n⚡ 升级后体力已回满：${levelUp.staminaResetTo}/${levelUp.staminaResetTo}`
      : "";
  const dexMsg = dexProgress
    ? `\n📖 图鉴新收录！(${dexProgress.collected}/${dexProgress.total})`
    : "";
  const shinyDexMsg = settleResult?.newlyShiny ? `\n🌈 图鉴异色标记点亮！` : "";
  return `${perfectMsg}\n✨ 经验：+${expGain}${levelUpMsg}${staminaResetMsg}${dexMsg}${shinyDexMsg}`;
}

// 异色个体逃走时的专属惋惜提示
function formatShinyEscape(fish) {
  return fish?.isShiny ? `\n🌈 那抹奇异的虹光一闪，消失在水底…` : "";
}

function formatFishFightState(stateId) {
  return getFishFightStateConfig(stateId).name;
}

function formatFishingStamina(status) {
  return `${status.current}/${status.max}`;
}

function formatFishingStaminaUnavailable(status) {
  return `⚡体力不足：${formatFishingStamina(status)}`;
}

function formatDurationMs(durationMs) {
  const minutes = Math.max(1, Math.ceil((Number(durationMs) || 0) / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0
    ? `${hours} 小时 ${remainingMinutes} 分钟`
    : `${hours} 小时`;
}

function formatNightmareImmunityDetail(status) {
  if (!status?.active) return "";
  const capacity = `${status.charges}/${status.maxCharges} 次`;
  return status.nextRecoveryMs > 0
    ? `${capacity} · ${formatDurationMs(status.nextRecoveryMs)}后恢复1次`
    : `${capacity} · 已充满（每${status.rechargeHours}小时恢复1次）`;
}

function getEffectiveRodControl(fishingManager, userId, state, rodMastery = 0) {
  const multiplier = state.deepPressureActive ? 0.5 : 1;
  return fishingManager.getRodControl(userId, state.rodConfig.id) * multiplier + rodMastery;
}

function formatBossCombatStatus(state, fishingManager, userId) {
  const hpBar = createProgressBar(state.bossHp, state.bossMaxHp, 10);
  const distanceBar = createProgressBar(state.distance, 100, 10);
  const tensionBar = createProgressBar(state.tension, 100, 10);
  const lineCurrent = Math.max(0, Number(state.bossLineDurability) || 0);
  const lineMax = Math.max(1, Number(state.bossLineMaxDurability) || 1);
  const lineBar = createProgressBar(lineCurrent, lineMax, 10);
  const rod = fishingManager.getRodDurabilityInfo(userId, state.rodConfig.id);
  const rodBar = createProgressBar(rod.currentDurability, rod.maxDurability, 10);
  return [
    `👑 生命：${hpBar} ${state.bossHp}/${state.bossMaxHp}`,
    `📏 距离：${distanceBar} ${Math.max(0, Math.round(state.distance))}/100`,
    `⚡ 张力：${tensionBar} ${Math.max(0, Math.round(state.tension))}/100`,
    `🧵 鱼线（本场）：${lineBar} ${lineCurrent}/${lineMax}`,
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
    nightmareWeightMultiplier = 1,
    zeroWeightRarities = [],
  } = {},
) {
  // 星愿强制稀有度时跳过鱼雷拦截，保证“必中传说”兑现
  if (!forceRarity && fishingManager && userId) {
    const torpedoCount = fishingManager.getAvailableTorpedoCount(userId);
    if (torpedoCount > 0) {
      const torpedoWeight = torpedoCount * TORPEDO_HOOK_WEIGHT_PER_ITEM;
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
    nightmareWeightMultiplier,
    zeroWeightRarities,
    forceRarity,
    hour: getShanghaiHour(),
    weather: weatherName || getWeatherByTime().name,
    location: location || undefined,
  });
}

async function calculateFishPrice(fish, fishingManager = null, environmentMultiplier = 1) {
  let torpedoMultiplier = 1;
  if (fishingManager) {
    try {
      torpedoMultiplier = await fishingManager.getFishPriceMultiplier();
    } catch (err) {
      logger.warn(`[钓鱼] 获取全局鱼价加成失败，按原价结算: ${err.message}`);
    }
  }
  return calculateLegacyFishPrice(
    fish,
    torpedoMultiplier * Math.max(0.1, Number(environmentMultiplier) || 1),
  );
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
    const lineDamage = resolveBossLineDamage({
      currentDurability: state.bossLineDurability,
      maxDurability: state.bossLineMaxDurability,
      damage: attackResult.lineDamage,
      protectFromBreak: Boolean(state.hasRiverBless),
    });
    state.bossLineDurability = lineDamage.currentDurability;
    state.bossLineMaxDurability = lineDamage.maxDurability;
    if (lineDamage.isBroken) {
      fishingManager.breakLine(e.user_id, state.lineConfig.id);
    }
    state.distance = Math.min(100, state.distance + attackResult.distanceGain);
    state.tension = Math.min(100, state.tension + attackResult.tensionGain);

    if (lineDamage.applied && !lineDamage.isBroken && !lineDamage.breakPrevented) {
      effectMessages.push(
        `🧵 鱼线本场耐久剩余 ${lineDamage.currentDurability}/${lineDamage.maxDurability}`,
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
        reasons.push(`🧵 本场耐久归零，【${state.lineConfig.name}】当场断裂`);
      } else if (lineDamage.breakPrevented) {
        reasons.push(`🌊 河神在最后一刻护住了【${state.lineConfig.name}】，鱼线没有断裂`);
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
        `🧵 鱼线本场耐久 -${attackResult.lineDamage}｜🎣 鱼竿 -${attackResult.rodDamage}\n`,
        effectMessages.length > 0 ? `${effectMessages.join("\n")}\n` : "",
        `${reasons.join("\n")}\n❌ 首领挑战失败！`,
        formatShinyEscape(state.fish),
      ]);
      return false;
    }

    await e.reply([
      `👑 【${state.fish.name}】发动了【${mechanic.name}】！\n`,
      `🧵 鱼线本场耐久 -${attackResult.lineDamage}｜🎣 鱼竿 -${attackResult.rodDamage}\n`,
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
    state.normalTugPressure = rollNormalTugPressure();

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
      state.bossLineMaxDurability = calculateBossLineDurability(state.lineConfig.capacity);
      state.bossLineDurability = state.bossLineMaxDurability;
      state.bossLastPlayerAttackAt = 0;
      state.bossAttackRounds = 0;

      await e.reply([
        `👑 首领战开始！【${state.fish.name}】现身！\n`,
        `🌀 特殊机制【${state.fish.boss_mechanic.name}】：${state.fish.boss_mechanic.description}\n\n`,
        `${formatBossCombatStatus(state, fishingManager, e.user_id)}\n\n`,
        `📝 指令：\n  「拉」拉近距离并增加张力\n  「溜」降低张力但会拉远距离\n  「攻」发起攻击（5秒冷却）\n`,
        `🏆 必须同时把首领生命与距离降到 0；首领每5秒反击一次！\n`,
        `🧵 鱼线按承重生成本场临时耐久，归零立即断线；战斗结束后不保留损伤！\n`,
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

    // 结算会清理会话，异色标记先取出用于逃走文案
    const shinyEscapeMsg = formatShinyEscape(state.fish);
    try {
      const settled = await this.finishFailedAttempt(e, state);
      if (settled && message) await e.reply(`${message}${shinyEscapeMsg}`, false, true);
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
      "item_lamp_fog",
      "item_bait_monster",
      "item_charm_river",
      "item_card_double_coin",
      "item_card_double_exp",
      "item_sand_time",
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
    const [lucky, fog, monster, river, doubleCoin, doubleExp, timeSand] = values.map(Boolean);
    return {
      hasLucky: lucky,
      hasFogLamp: fog,
      hasMonsterBait: monster,
      hasRiverBless: river,
      hasDoubleCoin: doubleCoin,
      hasDoubleExp: doubleExp,
      hasTimeSand: timeSand,
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

    const buffFlags = await this.readFishingBuffs(groupId, userId);
    const cooldownSeconds = buffFlags.hasTimeSand
      ? FISHING_TIME_SAND_COOLDOWN_SECONDS
      : FISHING_COOLDOWN_SECONDS;
    const cooldownKey = `sakura:fishing:cooldown:${groupId}:${userId}`;
    let ttl = await redis.ttl(cooldownKey);
    if (ttl > cooldownSeconds) {
      await redis.expire(cooldownKey, cooldownSeconds);
      ttl = cooldownSeconds;
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

      const nightmareStatus = fishingManager.getNightmareStatus(userId);

      // 骷髅诅咒与深压按实际抛竿消耗；即使随后钓到鱼雷也照常减少一层。
      // 权重严格按花嫁连乘 → 骷髅诅咒 → 怪物诱饵 → 雾灯结算。
      const rarityAfflictions = isBossBait
        ? { consumeCurse: false }
        : resolveNightmareRarityAfflictions(nightmareStatus.curse.actualLayers);
      const curseResult = rarityAfflictions.consumeCurse
        ? fishingManager.consumeNightmareCurseLayer(userId)
        : { consumed: false, remaining: nightmareStatus.curse.actualLayers };

      // 星愿一次性生效：抛竿即消耗所选品质；启动失败会在 catch 中原样退还。
      let wishRarity = null;
      try {
        const wishKey = `sakura:fishing:wish:${groupId}:${userId}`;
        const storedWish = await redis.get(wishKey);
        wishRarity = !isBossBait && RARITY_CONFIG[storedWish] ? storedWish : null;
        if (wishRarity) await redis.del(wishKey);
      } catch (err) {
        wishRarity = null;
        logger.warn(`[钓鱼] 读取星愿状态失败: ${err.message}`);
      }
      state.wishConsumed = Boolean(wishRarity);
      state.wishRarity = wishRarity;

      // 雾灯只改本人选鱼用的天气，不影响全局天气播报
      const effectiveWeather = buffFlags.hasFogLamp ? "雾" : pondWeather.name;
      const environment = getFishingEnvironmentModifiers(locationId, effectiveWeather);
      const selectedFish = isBossBait
        ? selectBossFromData(fishData, { location: locationId })
        : await selectRandomFish(
          baitQuality,
          fishingManager,
          userId,
          effectiveWeather,
          locationId,
          {
            forceRarity: wishRarity,
            nightmareBonus: buffFlags.hasMonsterBait ? 50 : 0,
            hasDebuff: curseResult.consumed,
            nightmareWeightMultiplier: nightmareStatus.brideNightmareMultiplier,
            // 最后判定雾灯：即使花嫁、诅咒与怪物诱饵先抬高噩梦，最终仍归零。
            zeroWeightRarities: buffFlags.hasFogLamp ? ["垃圾", "噩梦"] : [],
          },
        );
      // 首领保持固定的传说级基准，天气不改变其重量与困难度。
      if (!selectedFish.isTorpedo && !isBossFish(selectedFish)) {
        selectedFish.actualWeight = Math.round(
          selectedFish.actualWeight * environment.weightMultiplier * 100,
        ) / 100;
        selectedFish.difficulty = Math.max(
          0,
          Math.round(selectedFish.difficulty * environment.difficultyMultiplier),
        );
      }
      // 异色判定在选鱼时完成并随会话流转；溜掉即失去，咬钩提示会预告虹光。
      // selectedFish 是浅拷贝副本，直接抬高难度不会污染 fish.json，且下游搏斗判定与展示统一读它。
      selectedFish.isShiny = rollShiny(selectedFish);
      if (selectedFish.isShiny) {
        selectedFish.difficulty = Math.round(selectedFish.difficulty * SHINY_DIFFICULTY_MULTIPLIER);
      }
      const fishingLevel = fishingManager.getUserFishingLevel(userId);
      const waitTime = rollFishingBiteWaitMs(fishingLevel);
      const displayedCurseLayers = curseResult.consumed
        ? fishingManager.getNightmareCurseStatus(userId).displayedLayers
        : 0;
      const brideMarkLayers = getBrideMarkLayers(
        nightmareStatus.brideNightmareMultiplier,
      );

      const buffNotes = [
        buffFlags.hasLucky ? "\n🍀 好运护符生效中" : "",
        buffFlags.hasFogLamp
          ? "\n🌫️ 雾灯生效中"
          : "",
        buffFlags.hasMonsterBait
          ? "\n🩸 怪物诱饵生效中"
          : "",
        buffFlags.hasRiverBless ? "\n🌊 河神注视着你的鱼线。" : "",
        buffFlags.hasDoubleCoin ? "\n💰 双倍金币卡生效中。" : "",
        buffFlags.hasDoubleExp ? "\n📚 双倍经验卡生效中。" : "",
        buffFlags.hasTimeSand ? "\n⏳ 时之沙生效中" : "",
        nightmareStatus.brideNightmareMultiplier > 1
          ? `\n💍 ${brideMarkLayers} 层花嫁印记生效中，噩梦出现概率变为 ${nightmareStatus.brideNightmareMultiplier} 倍。`
          : "",
        curseResult.consumed
          ? `\n☠️ 诅咒生效中，剩余 ${displayedCurseLayers} 层。`
          : "",
        staminaResult.deepPressureConsumed
          ? `\n🔔 深压回响生效中，这一竿会更加吃力（剩余 ${staminaResult.deepPressureLayers} 层）。`
          : "",
        wishRarity ? `\n🌠 星愿闪耀！这一竿将迎来【${wishRarity}】品质！` : "",
        isBossBait ? `\n👑 首领鱼饵的气息正在水中扩散，当地首领正向鱼钩逼近……` : "",
      ].join("");

      Object.assign(state, {
        fish: selectedFish,
        rodConfig,
        lineConfig,
        baitConfig,
        phase: FISHING_PHASE.waiting,
        hasLucky: buffFlags.hasLucky,
        hasFogLamp: buffFlags.hasFogLamp,
        hasMonsterBait: buffFlags.hasMonsterBait,
        hasRiverBless: buffFlags.hasRiverBless,
        hasDoubleCoin: buffFlags.hasDoubleCoin,
        hasDoubleExp: buffFlags.hasDoubleExp,
        hasTimeSand: buffFlags.hasTimeSand,
        deepPressureActive: Boolean(staminaResult.deepPressureConsumed),
        locationId,
        environment,
        isBossBait,
      });

      await e.reply(
        `🎣 在${locationConfig.emoji}【${locationConfig.name}】挥动【${rodConfig.name}】挂上【${baitConfig.name}】，鱼钩落入水中...\n` +
        `🌤️ 当前天气：${pondWeather.emoji}${pondWeather.name}${buffFlags.hasFogLamp ? "（个人天气：🌫️雾）" : ""}\n` +
        `⚡体力：${formatFishingStamina(staminaResult)}${buffNotes}`
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
        currentState.isOverweight = !fish.isTorpedo &&
          fishWeight > lineCapacity &&
          !currentState.hasLucky;
        const shinyHint = fish.isShiny ? `🌈 水面泛起一层奇异的虹光…！\n` : "";
        if (isBossFish(fish) && currentState.isOverweight) {
          await e.reply([
            shinyHint,
            `👑 水面轰然炸开，【${fish.name}】吞下了首领鱼饵！\n`,
            `⚖️ 这股力量远超鱼线承重……回复「收竿」迎战，回复「放弃」保住装备！`,
          ], false, true);
        } else if (isBossFish(fish)) {
          await e.reply([
            shinyHint,
            `👑 水面轰然炸开，【${fish.name}】吞下了首领鱼饵！\n`,
            `⚔️ 快回复「收竿」完成重量判定并进入首领战！`,
          ], false, true);
        } else if (currentState.isOverweight) {
          await e.reply([
            shinyHint,
            `🌊 浮漂猛地沉下去了！\n`,
            `😨 这条鱼太大了！鱼线可能撑不住...\n`,
            `📝 回复「收竿」拼了，回复「放弃」保平安`,
          ], false, true);
        } else {
          await e.reply([
            shinyHint,
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
            state.wishRarity,
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
        const shinyReleaseMsg = fish.isShiny
          ? `\n🌈 你亲手放走了一抹罕见的虹光…忍痛割爱。`
          : "";
        await this.finishFailedAttempt(e, state);
        await e.reply(`🎣 放生了这条鱼，期待下次相遇~${shinyReleaseMsg}`);
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

        const damageResult = applyRodDamage(
          fishingManager,
          userId,
          rodConfig,
          TORPEDO_ROD_DAMAGE,
        );

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
            ? `😱 鱼雷爆炸引发恐慌！接下来${Math.round(FISHING_BENEFIT_DURATION_SECONDS / 60)}分钟内鱼价×${TORPEDO_PRICE_BOOST_MULTIPLIER}！`
            : `😱 鱼雷爆炸了，但鱼价加成暂时没有生效。`,
        ]);

        return;
      }

      // 完美收竿：5 秒内操作，并且装备足以通过重量与难度判定，
      // 好运护符会跳过重量与困难度判定，但仍需在5秒内操作才算完美收竿。
      const lineBonus = fishingManager.getLineBonusFromMastery(userId, rodConfig.id);
      const lineCapacity = lineConfig.capacity + lineBonus;
      const effectiveControl = getEffectiveRodControl(fishingManager, userId, state, rodMastery);
      const qualifiesForPerfect = !isBossFish(fish) && isPerfectCatch({
        reelDelayMs: state.biteTime ? Date.now() - state.biteTime : Number.NaN,
        fishWeight: fish.actualWeight,
        fishDifficulty,
        lineCapacity,
        effectiveControl,
        hasAssist: state.hasLucky,
      });

      if (qualifiesForPerfect) {
        state.isPerfect = true;
        await this.finishSuccess(e, state, fishingManager);
        return;
      }

      if (!isBossFish(fish) && state.hasLucky) {
        await e.reply(`🍀 好运护符跳过了重量与困难度判断，轻松把鱼拉了上来！`);
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
            formatShinyEscape(fish),
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
      const updatedControl = getEffectiveRodControl(fishingManager, userId, state, rodMastery);

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
        const updatedControl = getEffectiveRodControl(fishingManager, userId, state, rodMastery);
        const successRate = calculateForcePullSuccessRate(fishDifficulty, updatedControl);
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
            formatShinyEscape(fish),
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
      const updatedControl = getEffectiveRodControl(fishingManager, userId, state, rodMastery);
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
        // 「攻」只读取当前鱼竿实际控制力，不叠加钓鱼等级隐藏战力。
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

        // 首领的「拉」与普通精准溜鱼完全共用同一套数值，只额外拥有血条和「攻」。
        const effects = calculateNormalTugActionEffects({
          fishDifficulty,
          effectiveControl: updatedControl,
          pressure: state.normalTugPressure,
          stateId: state.fishState,
          action: FISHING_ACTION.pull,
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
            formatShinyEscape(fish),
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

        const effects = calculateNormalTugActionEffects({
          fishDifficulty,
          effectiveControl: updatedControl,
          pressure: state.normalTugPressure,
          stateId: state.fishState,
          action: FISHING_ACTION.loosen,
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

  async finishFailedAttempt(e, state, { recordCatch = null, masteryGain = 0 } = {}) {
    const groupId = e.group_id;
    const userId = e.user_id;
    const stateKey = this.buildFishingStateKey(groupId, userId);
    const recordEncounter = recordCatch == null
      ? shouldRecordFishEncounter(state)
      : Boolean(recordCatch);
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
        recordCatch: recordEncounter,
      });
      if (!result.success && result.reason !== "duplicate") {
        logger.warn(`[钓鱼] 失败结算未完成: ${result.reason}`);
      }
    } catch (err) {
      logger.error(`[钓鱼] 失败结算异常: ${err.stack || err}`);
    } finally {
      this.finish("handleFishing", true);
      try {
        await this.setCooldownAndIncrement(
          groupId,
          userId,
          state.hasTimeSand ? FISHING_TIME_SAND_COOLDOWN_SECONDS : FISHING_COOLDOWN_SECONDS,
        );
      } catch (err) {
        logger.error(`[钓鱼] 写入冷却失败: ${err.stack || err}`);
      } finally {
        if (state.cleanup) state.cleanup();
      }
    }
    return true;
  }

  async setCooldownAndIncrement(
    groupId,
    userId,
    cooldownSeconds = FISHING_COOLDOWN_SECONDS,
  ) {
    const cooldownKey = `sakura:fishing:cooldown:${groupId}:${userId}`;
    const dailyKey = `sakura:economy:daily_fishing_count:${groupId}:${userId}`;
    const now = Date.now();
    return await completeFishingAttempt(redis, {
      cooldownKey,
      dailyKey,
      nowSeconds: Math.floor(now / 1000),
      cooldownSeconds,
      dailyTtlSeconds: secondsUntilNextShanghaiDay(now),
    });
  }

  destroy() {
    for (const [stateKey, state] of fishingSessions.entries()) {
      this.cleanupFishingSession(stateKey, state.id);
    }
    super.destroy();
  }

  async applyNightmareEffect({
    e,
    state,
    fishingManager,
    economyManager,
    expGain,
  }) {
    const { fish, rodConfig } = state;
    const effect = fish.nightmare_effect || {};
    const normalizePenalty = (value) => Math.max(
      1,
      Math.round(Number(value)),
    );
    let rodBroken = false;
    let forceStaminaToOne = false;
    const fallbackRodDamage = (amount, prefix) => {
      const damage = normalizePenalty(amount);
      const result = applyRodDamage(fishingManager, e.user_id, rodConfig, damage);
      rodBroken ||= result.isBroken;
      return `${prefix}${result.msg}`;
    };
    let message = "💥 这是一个噩梦般的生物！";

    switch (effect.type) {
      case "rod_damage": {
        message = fallbackRodDamage(
          effect.amount || 20,
          "💥 它疯狂挣扎，严重损坏了你的鱼竿！",
        );
        break;
      }

      case "rod_damage_control_loss": {
        const controlLoss = normalizePenalty(effect.control_loss || 10);
        const controlResult = fishingManager.reduceRodControl(
          e.user_id,
          rodConfig.id,
          controlLoss,
        );
        const rodDamage = normalizePenalty(effect.rod_damage || 10);
        const damageResult = applyRodDamage(
          fishingManager,
          e.user_id,
          rodConfig,
          rodDamage,
        );
        rodBroken ||= damageResult.isBroken;
        const controlMessage = controlResult.applied && !damageResult.isBroken
          ? "\n🕸️ 鱼竿内部留下了一处难以修复的暗伤。"
          : "";
        message = `🦈 骨刺狠狠撕磨着竿身！${damageResult.msg}${controlMessage}`;
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
        const stolenAmount = Math.min(normalizePenalty(baseAmount), currentCoins);
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
        const stolenAmount = Math.min(normalizePenalty(baseAmount), currentCoins);
        economyManager.reduceCoins(e, stolenAmount, {
          type: "支出",
          note: `钓鱼事件：${fish.name}`,
        });
        message = `🌑 它按 ${percent}% 吞噬你的财富……你丢失了 ${stolenAmount} 樱花币！`;
        break;
      }

      case "curse": {
        const layers = normalizePenalty(effect.layers || 5);
        fishingManager.addNightmareCurseLayers(e.user_id, layers);
        message = `☠️ 诅咒附身！噩梦诅咒增加了 ${layers} 层。`;
        break;
      }

      case "nightmare_weight_multiplier": {
        const result = fishingManager.applyBrideNightmareMultiplier(
          e.user_id,
          effect.multiplier || 2,
        );
        message = `💍 溺水花嫁留下了印记，当前 ${getBrideMarkLayers(result.total)} 层，` +
          `噩梦出现概率变为 ${result.total} 倍。`;
        break;
      }

      case "steal_bait": {
        const result = fishingManager.stealHighestValueBait(e.user_id);
        if (result.stolen) {
          message = `🐒 水猴偷走了背包里价值最高的鱼饵【${result.bait.name}】×1，剩余 ${result.remaining} 个！`;
        } else {
          message = fallbackRodDamage(
            effect.fallback_rod_damage || 20,
            "🐒 水猴没摸到鱼饵，恼怒地抓伤了鱼竿！",
          );
        }
        break;
      }

      case "stamina_crush": {
        const staminaStatus = fishingManager.getFishingStaminaStatus(e.user_id);
        const baseDamage = calculateCorpseFisherRodDamage(
          staminaStatus.current,
          effect.max_rod_damage || 20,
        );
        const damage = baseDamage > 0 ? normalizePenalty(baseDamage) : 0;
        const damageResult = damage > 0
          ? applyRodDamage(fishingManager, e.user_id, rodConfig, damage)
          : { msg: "", isBroken: false };
        rodBroken ||= damageResult.isBroken;
        fishingManager.forceFishingStaminaToOne(e.user_id);
        forceStaminaToOne = true;
        message = `🪝 捞尸人以你当前的 ${staminaStatus.current} 点体力反噬鱼竿` +
          `，造成 ${damage} 点损耗，并将体力强制压到 1！${damageResult.msg}`;
        break;
      }

      case "ghost_debt": {
        const amount = normalizePenalty(effect.amount || 100);
        const result = fishingManager.addGhostDebt(e.user_id, amount);
        message = `🚢 幽灵船留下亡者船票：债务 +${result.added}，当前 ${result.total}！` +
          "\n💰 还清前，钓鱼金币会先减半，再用于偿还债务。";
        break;
      }

      case "deep_pressure": {
        const layers = normalizePenalty(effect.layers || 3);
        const result = fishingManager.addDeepPressureLayers(e.user_id, layers);
        message = `🔔 潜水钟敲响，深压 +${result.added} 层，当前 ${result.total} 层！` +
          "接下来的垂钓会更加吃力。";
        break;
      }

      case "devour_inventory": {
        const result = fishingManager.devourRandomInventoryItem(
          e.user_id,
          [rodConfig.id],
        );
        if (result) {
          const shopManager = new ShopManager();
          const item = shopManager.findItemById(result.itemId) ||
            shopManager.findItemByName(result.itemId);
          message = `🌑 食星之影吞掉了【${item?.name || result.itemId}】×1！`;
        } else {
          message = fallbackRodDamage(
            effect.fallback_rod_damage || 2,
            "🌑 背包里没有可吞噬的物品，它转而啃噬鱼竿！",
          );
        }
        break;
      }

      default:
        break;
    }

    return { message, expGain, rodBroken, forceStaminaToOne };
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
    const isShiny = Boolean(fish.isShiny);
    // 异色优先取虹光/金色图；生成失败则回退原图。图片资源缺失时不带图，避免整条消息发送失败
    let fishImagePath = null;
    if (isShiny) {
      try {
        fishImagePath = await getShinyFishImagePath(fish.id);
      } catch (err) {
        logger.warn(`[钓鱼] 生成异色图失败，回退原图: ${err.message}`);
      }
    }
    if (!fishImagePath) fishImagePath = getFishImagePath(fish.id);
    const fishImageSegment = fs.existsSync(fishImagePath)
      ? segment.image(`file:///${fishImagePath}`)
      : "";
    const shinyNameTag = isShiny ? "🌈异色·" : "";
    const economyManager = new EconomyManager(e);
    const settlement = new FishingSettlementService(e);
    const isPerfect = Boolean(state.isPerfect);
    const bossVictory = isBossFish(fish);
    const bossReward = bossVictory ? calculateBossCatchReward(fish) : null;
    // 首领奖励独立于普通收益链：只允许异色 ×4，不吃其余经验加成。
    let expGain = bossVictory
      ? bossReward.expGain
      : Math.max(1, Math.round(
        rollFishExp(fish.rarity) *
        (isPerfect ? PERFECT_EXP_MULTIPLIER : 1) *
        (state.hasDoubleExp ? 2 : 1) *
        (state.hasMonsterBait ? 3 : 1) *
        (isShiny ? SHINY_EXP_MULTIPLIER : 1) *
        (state.environment?.expMultiplier || 1),
      ));
    const weatherTag = Array.isArray(fish.weather) && fish.weather.length > 0
      ? `（${fish.weather.map((name) => `${WEATHER_CONFIG[name]?.emoji || ""}${name}`).join("/")}限定）`
      : "";

    try {
      if (fish.rarity === "噩梦") {
        // 深渊猎手先消耗一次完整免疫；没有充能时才进入断线与噩梦效果结算。
        const immunity = fishingManager.consumeNightmareImmunity(userId);
        const immunityTriggered = Boolean(immunity.immune);
        const lineSaved = immunityTriggered || Boolean(state.hasRiverBless);
        if (!lineSaved) {
          fishingManager.breakLine(userId, lineConfig.id);
        }

        const effectResult = immunityTriggered
          ? {
            message: "🛡️ 本次噩梦的伤害、偷取与附加状态全部未生效。",
            expGain,
            rodBroken: false,
            forceStaminaToOne: false,
          }
          : await this.applyNightmareEffect({
            e,
            state,
            fishingManager,
            economyManager,
            expGain,
          });
        const punishmentMsg = effectResult.message;
        expGain = effectResult.expGain;

        const lineResultMsg = lineSaved
          ? (immunityTriggered
            ? `🗡️ 猎魔守护完全隔绝了这次噩梦，鱼线安然无恙！\n`
            : `🌊 河神的祝福护住了鱼线！\n`)
          : `💥 崩！鱼线被扯断了！\n🧵 失去了【${lineConfig.name}】\n`;
        const professionBonusMsg = immunity.active
          ? `🛡️ 噩梦免疫储存：${formatNightmareImmunityDetail(immunity)}\n`
          : "";

        const settleResult = settlement.settleAttempt({
          sessionId: state.id,
          fishId: fish.id,
          success: true,
          earnings: 0,
          rodId: effectResult.rodBroken ? null : rodConfig.id,
          masteryGain: 1,
          expGain,
          weight: fish.actualWeight,
        });
        if (effectResult.forceStaminaToOne) {
          fishingManager.forceFishingStaminaToOne(userId);
          if (settleResult.levelUp) settleResult.levelUp.staminaForcedTo = 1;
        }
        const dexProgress = getDexProgress(fishingManager, userId, settleResult);

        await e.reply([
          `😱 钓到了... 糟糕！是【${fish.name}】！\n`,
          fishImageSegment,
          `📝 ${fish.description}\n`,
          `📊 稀有度：${rarity.color}${fish.rarity}${weatherTag}\n`,
          lineResultMsg,
          professionBonusMsg,
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
          expGain,
          weight: fish.actualWeight,
        });
        const dexProgress = getDexProgress(fishingManager, userId, addResult);
        const newMastery = fishingManager.getRodMastery(userId, rodConfig.id);

        await e.reply([
          `🎉 钓到了【${fish.name}】！\n`,
          fishImageSegment,
          `📝 ${fish.description}\n`,
          `📊 稀有度：${rarity.color}${fish.rarity}${weatherTag}\n`,
          `📈 熟练度：${newMastery}\n`,
          `🗝️ 宝箱已放入背包，发送「#开宝箱」开启它！${formatCatchTail(expGain, isPerfect, addResult, dexProgress)}`,
        ]);
        return true;
      }

      // 首领金币只由自身重量偏差决定；普通渔获继续走完整收益加成链。
      const price = bossVictory
        ? bossReward.earnings
        : await calculateFishPrice(
          fish,
          fishingManager,
          state.environment?.priceMultiplier || 1,
        );

      const buffMultiplier = bossVictory
        ? 1
        : await this.getFishSellBuffMultiplier(groupId, userId, state);
      const merchantMultiplier = bossVictory
        ? 1
        : fishingManager.getMerchantCoinMultiplier(userId);
      // 首领的异色倍率已在独立奖励包中计算，普通渔获在这里计算。
      const shinyMultiplier = bossVictory || !isShiny ? 1 : SHINY_PRICE_MULTIPLIER;
      const finalPrice = Math.round(price * buffMultiplier * merchantMultiplier * shinyMultiplier);

      const settleResult = settlement.settleCoinCatch({
        sessionId: state.id,
        fishId: fish.id,
        earnings: finalPrice,
        rodId: rodConfig.id,
        note: `钓鱼出售 ${isShiny ? "异色·" : ""}${fish.name}`,
        expGain,
        weight: fish.actualWeight,
        shiny: isShiny,
        rewardItemId: bossReward?.rewardItemId || null,
        rewardItemCount: bossReward?.rewardItemCount || 0,
      });
      const dexProgress = getDexProgress(fishingManager, userId, settleResult);
      const newMastery = fishingManager.getRodMastery(userId, rodConfig.id);

      let priceBoostMsg = "";
      if (!bossVictory) {
        try {
          if (await fishingManager.isFishPriceBoostActive()) {
            priceBoostMsg = `😱 鱼雷恐慌中，鱼价×${TORPEDO_PRICE_BOOST_MULTIPLIER}！\n`;
          }
        } catch (err) {
          logger.warn(`[钓鱼] 获取鱼雷鱼价状态失败: ${err.message}`);
        }
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

      const shinyMsg = isShiny
        ? `🌈 异色${bossVictory ? "首领" : "个体"}！金币 ×${SHINY_PRICE_MULTIPLIER}、经验 ×${SHINY_EXP_MULTIPLIER}！\n`
        : "";

      const rewardChest = bossVictory
        ? new ShopManager().findItemById(settleResult.rewardItemId)
        : null;
      const bossRewardMsg = bossVictory
        ? `🗝️ 当地宝箱：【${rewardChest?.name || settleResult.rewardItemId}】×${settleResult.rewardItemCount} 已放入背包\n`
        : "";

      const debtPenaltyMsg = settleResult.penaltyDeducted > 0
        ? `🚢 亡者船票先将金币收益减半：${settleResult.grossEarnings} → ${settleResult.earningsAfterPenalty}\n`
        : "";
      const debtMsg = settleResult.debtPaid > 0
        ? `👻 再偿还 ${settleResult.debtPaid} 樱花币债务，剩余 ${settleResult.remainingDebt}\n`
        : "";
      const earningsMsg = settleResult.penaltyDeducted > 0 || settleResult.debtPaid > 0
        ? `💰 价值：${finalPrice} 樱花币｜实际到账：${settleResult.earnings} 樱花币`
        : `💰 价值：${finalPrice} 樱花币`;

      const resultMsg = [
        bossVictory
          ? `🏆 单人讨伐成功！击败了${state.locationId ? "当前钓点的" : ""}首领【${shinyNameTag}${fish.name}】！\n`
          : `🎉 钓到了【${shinyNameTag}${fish.name}】！\n`,
        fishImageSegment,
        `📝 ${fish.description}\n`,
        bossVictory
          ? `👑 类型：钓点首领｜🌀 ${fish.boss_mechanic.name}\n`
          : `📊 稀有度：${rarity.color}${fish.rarity}${weatherTag}\n`,
        `⚖️ 重量：${fishWeight}\n`,
        bossVictory
          ? `🎮 玩家操作：${state.fightingRounds} 次｜承受反击：${state.bossAttackRounds || 0} 次\n`
          : "",
        `📈 熟练度：${newMastery}\n`,
        priceBoostMsg,
        buffMsg,
        merchantMsg,
        shinyMsg,
        bossRewardMsg,
        debtPenaltyMsg,
        debtMsg,
        `${earningsMsg}${formatCatchTail(expGain, isPerfect, settleResult, dexProgress)}`,
      ];
      await e.reply(resultMsg);
      return true;
    } finally {
      try {
        await this.setCooldownAndIncrement(
          groupId,
          userId,
          state.hasTimeSand ? FISHING_TIME_SAND_COOLDOWN_SECONDS : FISHING_COOLDOWN_SECONDS,
        );
      } catch (err) {
        logger.error(`[钓鱼] 写入冷却失败: ${err.stack || err}`);
      } finally {
        if (state.cleanup) state.cleanup();
      }
    }
  }

  async getFishSellBuffMultiplier(groupId, userId, buffSnapshot = null) {
    if (buffSnapshot) {
      return (buffSnapshot.hasDoubleCoin ? 2 : 1) *
        (buffSnapshot.hasMonsterBait ? 3 : 1);
    }

    const multiplierKeys = [
      `sakura:fishing:buff:item_card_double_coin:${groupId}:${userId}`,
      `sakura:fishing:buff:item_bait_monster:${groupId}:${userId}`,
    ];
    try {
      const [doubleCoin, monsterBait] = await Promise.all(
        multiplierKeys.map((key) => redis.get(key)),
      );
      return (doubleCoin ? 2 : 1) * (monsterBait ? 3 : 1);
    } catch (err) {
      logger.warn(`[钓鱼] 获取金币加成失败，按原价结算: ${err.message}`);
    }
    return 1;
  }


  pondWeatherForecast = Command(/^#?(鱼塘|钓鱼)天气$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    const current = getWeatherByTime();
    const fishingManager = new FishingManager(e.group_id);
    const locationId = fishingManager.getFishingLocation(e.user_id);
    const location = getFishingLocationConfig(locationId);

    await e.reply([
      `🌤️ 当前天气观测\n`,
      `📍 当前钓点：${location.emoji}【${location.name}】\n`,
      `现在：${current.emoji}${current.name}\n`,
      `🔭 水域变化无常，无法预报下一时段天气。`,
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
      return `${config.emoji}【${config.name}】${currentMark}${lockMark}\n` +
        `   ${config.description}`;
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
    await e.reply(
      `🚶 收拾好装备，来到了${locationConfig.emoji}【${locationConfig.name}】\n` +
      `${locationConfig.description}\n` +
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
      (bait.boss_bait ? "\n👑 下一竿必定呼出当前钓点首领。" : "")
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
    await e.reply(`🧵 鱼线换好啦！当前使用【${line.name}】。`);
    return true;
  });

  fishingStatus = Command(/^#?钓鱼(状态|信息)$/, async (e) => {
    if (!this.checkWhitelist(e)) return false;
    const groupId = e.group_id;
    const userId = e.user_id;
    const fishingManager = new FishingManager(groupId);
    const locationConfig = getFishingLocationConfig(fishingManager.getFishingLocation(userId));
    const weather = getWeatherByTime();
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
      equipment.push({
        id: equippedLineId,
        name: lineConfig.name,
        handler: "fishing_line",
        details: [],
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
          baitConfig.boss_bait ? "下一竿必定呼出当前钓点首领" : "已准备就绪",
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
    let fogLampActive = false;
    for (const [index, item] of buffItems.entries()) {
      const ttl = buffTtls[index];
      if (ttl > 0) {
        if (item.id === "item_lamp_fog") fogLampActive = true;
        effects.push({
          icon: item.icon || "✨",
          name: item.name,
          detail: `剩余 ${formatEffectTime(ttl)}`,
          tone: "positive",
        });
      }
    }
    const statusWeather = fogLampActive
      ? { name: "雾（雾灯）", emoji: WEATHER_CONFIG["雾"].emoji }
      : weather;

    const wishKey = `sakura:fishing:wish:${groupId}:${userId}`;
    const [wishTtl, wishRarity] = await Promise.all([
      redis.ttl(wishKey).catch(() => 0),
      redis.get(wishKey).catch(() => null),
    ]);
    if (wishTtl > 0 && RARITY_CONFIG[wishRarity]) {
      effects.push({
        icon: "🌠",
        name: "星愿",
        detail: `下一次咬钩指定为${wishRarity} · 剩余 ${formatEffectTime(wishTtl)}`,
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
    if (nightmareStatus.brideNightmareMultiplier > 1) {
      effects.push({
        icon: "💍",
        name: "花嫁印记",
        detail: `${getBrideMarkLayers(nightmareStatus.brideNightmareMultiplier)} 层` +
          ` · 噩梦出现概率变为 ${nightmareStatus.brideNightmareMultiplier} 倍`,
        tone: "danger",
      });
    }
    if (nightmareStatus.ghostDebt > 0) {
      effects.push({
        icon: "🚢",
        name: "亡者船票",
        detail: `尚欠 ${nightmareStatus.ghostDebt} · 收益先减半再还债`,
        tone: "warning",
      });
    }
    if (nightmareStatus.deepPressureLayers > 0) {
      effects.push({
        icon: "🔔",
        name: "深压回响",
        detail: `剩余 ${nightmareStatus.deepPressureLayers} 层 · 接下来的垂钓会更吃力`,
        tone: "warning",
      });
    }
    const nightmareImmunity = fishingManager.getNightmareImmunityStatus(userId);
    if (nightmareImmunity.active) {
      effects.push({
        icon: "🛡️",
        name: "猎魔守护",
        detail: formatNightmareImmunityDetail(nightmareImmunity),
        tone: nightmareImmunity.ready ? "positive" : "warning",
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
        weather: statusWeather,
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
          totalAttempts: userData.total_attempts || 0,
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
              shinyCount: record?.shinyCount || 0,
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
    const shinyCollected = sections.reduce(
      (sum, section) =>
        sum + section.entries.filter((entry) => entry.shinyCount > 0).length,
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
        shinyCollected,
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
              { text: `🌈 异色 ${shinyCollected}` },
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
            const lineBonus = fishingManager.getLineBonusFromMastery(e.user_id, equippedRod);
            bonusInfo = `\n🎣 当前鱼竿熟练度: ${mastery}｜鱼线承重: +${lineBonus}`;
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
          const immunity = fishingManager.getNightmareImmunityStatus(e.user_id);
          bonusInfo = `\n🛡️ 噩梦免疫储存: ${formatNightmareImmunityDetail(immunity)}`;
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
