import { TORPEDO_HOOK_WEIGHT_PER_ITEM } from "../fishing/rules.js";
import { getFishData } from "../fishing/fishData.js";

export const FORTUNE_BAG_ITEM_ID = "fortune_bag";
export const FORTUNE_BAG_INITIAL_AMOUNT = 10;
export const FORTUNE_BAG_INCREMENT = 10;
export const FORTUNE_BAG_HOOK_WEIGHT_PER_ITEM = 5;
export const FORTUNE_BAG_OWNER_EXP = 1;
export const FORTUNE_BAG_LEASE_MS = 15 * 60 * 1000;
export const FORTUNE_BAG_MESSAGE_LIMIT = 120;
export const FORTUNE_BAG_IMAGE_LIMIT = 2 * 1024 * 1024;

// 鱼雷与福袋每个5权重；普通渔获保留100基础权重。
export function rollPondItemType(torpedoCount, fortuneBagCount, random = Math.random) {
  const torpedoWeight = Math.max(0, Number(torpedoCount) || 0) * TORPEDO_HOOK_WEIGHT_PER_ITEM;
  const bagWeight = Math.max(0, Number(fortuneBagCount) || 0) * FORTUNE_BAG_HOOK_WEIGHT_PER_ITEM;
  if (torpedoWeight + bagWeight === 0) return "fish";
  const roll = Math.max(0, Math.min(0.999999999999, Number(random()) || 0)) * (100 + torpedoWeight + bagWeight);
  if (roll < torpedoWeight) return "torpedo";
  if (roll < torpedoWeight + bagWeight) return "fortune_bag";
  return "fish";
}

export function normalizeFortuneBagMessage(message) {
  const value = String(message || "").trim().replace(/\s+/gu, " ");
  if (!value || [...value].length > FORTUNE_BAG_MESSAGE_LIMIT) return null;
  return value.replace(/\[CQ:/giu, "［CQ:");
}

export function fortuneBagAsCatch(bag) {
  const weight = bag.amount / 2;
  const difficulty = getFishData().find(fish => fish.id === `chest_${bag.location}`)?.difficulty ?? 10;
  return {
    id: `fortune_bag_${bag.id}`,
    name: `福袋 F${bag.id}`,
    rarity: "宝藏",
    isFortuneBag: true,
    fortuneBagId: bag.id,
    amount: bag.amount,
    description: bag.message,
    image: bag.image || null,
    difficulty,
    actualWeight: weight,
    effectiveWeight: weight,
    weight: [weight, weight],
    base_price: 0,
  };
}
