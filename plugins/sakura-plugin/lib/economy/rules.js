export const REVIVE_COIN_BASE_AMOUNT = 100;
export const REVIVE_COIN_PER_LEVEL = 2;
export const TRANSFER_UNLOCK_FISHING_LEVEL = 5;
export const AI_TRANSFER_MAX_BALANCE_PERCENT = 20;
export const AI_TRANSFER_GROUP_COOLDOWN_SECONDS = 2 * 60;
export const EQUIPMENT_SELL_PRICE_RATIO = 0.8;

export function calculateEquipmentSellPrice(originalPrice, durabilityRatio = 1) {
  const price = Number(originalPrice);
  if (!Number.isFinite(price) || price <= 0) return 0;
  const numericDurabilityRatio = Number(durabilityRatio);
  const safeDurabilityRatio = Number.isFinite(numericDurabilityRatio)
    ? Math.max(0, Math.min(1, numericDurabilityRatio))
    : 1;
  return Math.floor(price * EQUIPMENT_SELL_PRICE_RATIO * safeDurabilityRatio);
}

function normalizeFishingLevel(level) {
  const numericLevel = Number(level);
  if (!Number.isFinite(numericLevel)) return 1;
  return Math.max(1, Math.floor(numericLevel));
}

export function getReviveCoinPolicy(fishingLevel) {
  const level = normalizeFishingLevel(fishingLevel);
  const amount = REVIVE_COIN_BASE_AMOUNT + (level - 1) * REVIVE_COIN_PER_LEVEL;

  return {
    fishingLevel: level,
    amount,
    maxBalanceExclusive: amount,
  };
}

export function canUseTransfer(fishingLevel) {
  return normalizeFishingLevel(fishingLevel) >= TRANSFER_UNLOCK_FISHING_LEVEL;
}

// 钓鱼等级里程碑奖励：每 5 级一档、不设上限，每档发一套自救耗材，
// 保证断竿和中诅咒时不至于卡死。发的是消耗品而非金币，档位无限也不会推高收益基线。
export const FISHING_LEVEL_REWARD_STEP = 5;
export const FISHING_LEVEL_REWARD_ITEMS = Object.freeze([
  Object.freeze({ itemId: "item_toolkit_repair", count: 1 }),
  Object.freeze({ itemId: "item_holy_water", count: 1 }),
]);

export function getReachedFishingLevelRewardMilestones(fishingLevel) {
  const level = normalizeFishingLevel(fishingLevel);
  const milestones = [];
  for (
    let milestone = FISHING_LEVEL_REWARD_STEP;
    milestone <= level;
    milestone += FISHING_LEVEL_REWARD_STEP
  ) {
    milestones.push(milestone);
  }
  return milestones;
}

export function getFishingLevelRewardClaimType(milestone) {
  return `fishing_level_reward_${milestone}`;
}

export function getNextFishingLevelRewardMilestone(fishingLevel) {
  const level = normalizeFishingLevel(fishingLevel);
  return (Math.floor(level / FISHING_LEVEL_REWARD_STEP) + 1) * FISHING_LEVEL_REWARD_STEP;
}

export function getFishingLevelRewardSlotCost() {
  return FISHING_LEVEL_REWARD_ITEMS.reduce((total, reward) => total + reward.count, 0);
}

// 钓点专属图鉴奖励：按「该钓点专属鱼」的收录数发档，每个钓点各自一条进度线。
// 奖励全部取自该钓点已有的宝箱/道具/藏品，不引入新内容；只有全收录档给一次性金币。
export const DEX_LOCATION_REWARD_THRESHOLDS = Object.freeze([10, 20, 30]);
export const DEX_LOCATION_FULL_TIER_KEY = "full";
export const DEX_LOCATION_FULL_COIN_REWARD = 1000;

const DEX_LOCATION_SIGNATURE_ITEMS = Object.freeze({
  pond: "item_sign_koi",
  river: "item_charm_river",
  lake: "item_lamp_fog",
  coast: "item_card_double_coin",
  abyss: "item_bait_monster",
  mystic: "item_bottle_wish",
});

const DEX_LOCATION_TREASURE_ITEMS = Object.freeze({
  pond: "treasure_pond_sakura_amber",
  river: "treasure_river_golden_scale",
  lake: "treasure_lake_bronze_mirror",
  coast: "treasure_coast_black_pearl",
  abyss: "treasure_abyss_dragon_ambergris",
  mystic: "treasure_mystic_star_fragment",
});

export function getDexLocationChestId(locationId) {
  return `chest_${locationId}`;
}

export function getDexLocationRewardClaimType(locationId, tierKey) {
  return `dex_loc_${locationId}_${tierKey}`;
}

// 全收录档用 "full" 而不是具体条数做记账键：以后 fish.json 增删鱼种时，
// 分母变化不会凭空造出一个没领过的新档位。
export function getDexLocationRewardTiers(locationId, exclusiveTotal) {
  const total = Math.max(0, Math.floor(Number(exclusiveTotal) || 0));
  const chestId = getDexLocationChestId(locationId);
  const signatureItemId = DEX_LOCATION_SIGNATURE_ITEMS[locationId];
  const treasureItemId = DEX_LOCATION_TREASURE_ITEMS[locationId];
  if (total <= 0 || !signatureItemId || !treasureItemId) return [];

  const tierRewards = {
    10: [{ itemId: chestId, count: 1 }],
    20: [{ itemId: chestId, count: 2 }],
    30: [{ itemId: signatureItemId, count: 1 }, { itemId: chestId, count: 1 }],
  };

  const tiers = DEX_LOCATION_REWARD_THRESHOLDS
    // 门槛必须严格小于全收录数，否则会和全收录档重叠成两次领取
    .filter((threshold) => threshold < total)
    .map((threshold) => ({
      key: String(threshold),
      threshold,
      items: tierRewards[threshold],
      coins: 0,
    }));

  tiers.push({
    key: DEX_LOCATION_FULL_TIER_KEY,
    threshold: total,
    items: [
      { itemId: "bait_boss", count: 2 },
      { itemId: treasureItemId, count: 1 },
    ],
    coins: DEX_LOCATION_FULL_COIN_REWARD,
  });

  return tiers;
}

// 红包：每份至少 1 樱花币，所以总额必须不小于份数。
export const RED_PACKET_MIN_SHARE = 1;
export const RED_PACKET_MIN_AMOUNT = 10;
export const RED_PACKET_MAX_AMOUNT = 100000;
// 至少两份：单份红包等于一条可以指定收款人的通道，会绕开转账手续费；
// 两份起步时发红包的人无法控制另一份落到谁手上，抢不走的还会原路退回。
export const RED_PACKET_MIN_COUNT = 2;
export const RED_PACKET_MAX_COUNT = 20;
// 手续费与转账对齐：固定 10 ＋ 金额的 5%（转账 0~10% 随机的期望值），
// 但百分比部分按份数摊薄——份数越少越接近定向转账，就该按转账的价码收。
export const RED_PACKET_FEE_BASE = 10;
export const RED_PACKET_FEE_RATE = 0.05;
export const RED_PACKET_EXPIRE_SECONDS = 5 * 60;
// 同一个人同时挂着的未领完红包上限，避免刷屏和一次性锁死大量余额。
export const RED_PACKET_MAX_ACTIVE_PER_USER = 3;
export const RED_PACKET_MODES = Object.freeze({ lucky: "拼手气", equal: "均等" });

// 二倍均值法：每份的上限是「剩余金额均值的两倍」，同时预留给后面每人至少 1 币，
// 这样金额分布既有波动又不会前面几份把红包掏空。
function splitLuckyShares(amount, count, random = Math.random) {
  const shares = [];
  let remainingAmount = amount;
  let remainingCount = count;
  while (remainingCount > 1) {
    // 先给后面每个人留够保底，剩下的才是这一份能动用的额度。
    const spendable = remainingAmount - RED_PACKET_MIN_SHARE * (remainingCount - 1);
    const upperBound = Math.max(1, Math.floor((spendable / remainingCount) * 2));
    const share = Math.max(
      RED_PACKET_MIN_SHARE,
      Math.min(spendable, Math.floor(Math.max(0, Math.min(1, random())) * upperBound) + 1),
    );
    shares.push(share);
    remainingAmount -= share;
    remainingCount -= 1;
  }
  shares.push(remainingAmount);
  return shares;
}

// 均等模式除不尽时，余数按顺序分给先抢到的人，总额仍然精确等于发出的金额。
function splitEqualShares(amount, count) {
  const base = Math.floor(amount / count);
  const remainder = amount - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

export function splitRedPacket(amount, count, mode = "equal", random = Math.random) {
  const safeAmount = Math.floor(Number(amount) || 0);
  const safeCount = Math.floor(Number(count) || 0);
  if (safeCount < 1 || safeAmount < safeCount * RED_PACKET_MIN_SHARE) return null;
  return mode === "lucky"
    ? splitLuckyShares(safeAmount, safeCount, random)
    : splitEqualShares(safeAmount, safeCount);
}

// 手续费在本金之外另收：播报出去的金额就是真正会被抢走的金额。
export function calculateRedPacketFee(amount, count) {
  const safeAmount = Math.max(0, Math.floor(Number(amount) || 0));
  const safeCount = Math.max(1, Math.floor(Number(count) || 0));
  return RED_PACKET_FEE_BASE + Math.floor(safeAmount * RED_PACKET_FEE_RATE / safeCount);
}

export function validateRedPacket(amount, count) {
  const safeAmount = Number(amount);
  const safeCount = Number(count);
  if (!Number.isSafeInteger(safeAmount) || !Number.isSafeInteger(safeCount)) {
    return { valid: false, reason: "invalid" };
  }
  if (safeAmount < RED_PACKET_MIN_AMOUNT || safeAmount > RED_PACKET_MAX_AMOUNT) {
    return { valid: false, reason: "amount_range" };
  }
  if (safeCount < RED_PACKET_MIN_COUNT || safeCount > RED_PACKET_MAX_COUNT) {
    return { valid: false, reason: "count_range" };
  }
  if (safeAmount < safeCount * RED_PACKET_MIN_SHARE) {
    return { valid: false, reason: "too_thin" };
  }
  return { valid: true, amount: safeAmount, count: safeCount };
}

export function getNonMasterAiTransferLimit(balance) {
  const numericBalance = Number(balance);
  if (!Number.isFinite(numericBalance) || numericBalance <= 0) return 0;
  return Math.floor(numericBalance * AI_TRANSFER_MAX_BALANCE_PERCENT / 100);
}
