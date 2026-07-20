export function getUnownedFishingLines(lines, ownedItemIds = []) {
  const owned = ownedItemIds instanceof Set
    ? ownedItemIds
    : new Set(ownedItemIds);
  return (Array.isArray(lines) ? lines : []).filter((line) => (
    line?.id && !owned.has(line.id)
  ));
}

export function selectRandomUnownedLine(
  lines,
  ownedItemIds = [],
  random = Math.random,
) {
  const candidates = getUnownedFishingLines(lines, ownedItemIds);
  if (candidates.length === 0) return null;
  const roll = Math.max(0, Math.min(0.999999999999, Number(random()) || 0));
  return candidates[Math.floor(roll * candidates.length)];
}

export function resolveRandomLineLootWeight(loot, hasUnownedLine) {
  const entries = (Array.isArray(loot) ? loot : []).map((entry) => ({ ...entry }));
  if (hasUnownedLine) return entries;

  const randomLineWeight = entries
    .filter((entry) => entry.type === "random_line")
    .reduce((sum, entry) => sum + Math.max(0, Number(entry.weight) || 0), 0);
  if (randomLineWeight <= 0) return entries;

  const fallbackIndex = entries.findIndex((entry) => (
    entry.type === "coins" && !entry.name
  ));
  const anyCoinIndex = fallbackIndex >= 0
    ? fallbackIndex
    : entries.findIndex((entry) => entry.type === "coins");
  if (anyCoinIndex < 0) return entries;

  entries[anyCoinIndex].weight = (
    Math.max(0, Number(entries[anyCoinIndex].weight) || 0) + randomLineWeight
  );
  return entries.filter((entry) => entry.type !== "random_line");
}
