export const REVIVE_COIN_BASE_AMOUNT = 35;
export const REVIVE_COIN_PER_LEVEL = 2;
export const TRANSFER_UNLOCK_FISHING_LEVEL = 5;
export const AI_TRANSFER_MAX_BALANCE_PERCENT = 20;
export const AI_TRANSFER_GROUP_COOLDOWN_SECONDS = 2 * 60;
export const EQUIPMENT_SELL_PRICE_RATIO = 0.55;

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

export function getNonMasterAiTransferLimit(balance) {
  const numericBalance = Number(balance);
  if (!Number.isFinite(numericBalance) || numericBalance <= 0) return 0;
  return Math.floor(numericBalance * AI_TRANSFER_MAX_BALANCE_PERCENT / 100);
}
