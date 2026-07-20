export function isUniqueFishingEquipmentId(itemId) {
  return /^(?:rod|line)_/.test(String(itemId || ""));
}
