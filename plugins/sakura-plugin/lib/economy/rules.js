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

// 红包：每份至少 1 樱花币，所以总额必须不小于份数。
export const RED_PACKET_MIN_SHARE = 1;
export const RED_PACKET_MIN_AMOUNT = 10;
export const RED_PACKET_MAX_AMOUNT = 100000;
export const RED_PACKET_MAX_COUNT = 20;
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

export function splitRedPacket(amount, count, mode = "lucky", random = Math.random) {
  const safeAmount = Math.floor(Number(amount) || 0);
  const safeCount = Math.floor(Number(count) || 0);
  if (safeCount < 1 || safeAmount < safeCount * RED_PACKET_MIN_SHARE) return null;
  return mode === "equal"
    ? splitEqualShares(safeAmount, safeCount)
    : splitLuckyShares(safeAmount, safeCount, random);
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
  if (safeCount < 1 || safeCount > RED_PACKET_MAX_COUNT) {
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
