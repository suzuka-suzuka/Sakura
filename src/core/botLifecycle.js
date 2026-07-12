function normalizeSelfId(selfId) {
  if (selfId === null || selfId === undefined || selfId === "") return null;
  const id = Number(selfId);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export function isBotOfflineEvent(event) {
  if (!event || typeof event !== "object") return false;

  if (event.post_type === "notice" && event.notice_type === "bot_offline") {
    return true;
  }

  if (
    event.post_type === "meta_event" &&
    event.meta_event_type === "heartbeat" &&
    event.status?.online === false
  ) {
    return true;
  }

  return (
    event.post_type === "meta_event" &&
    event.meta_event_type === "lifecycle" &&
    (event.sub_type === "disable" || event.sub_type === "disconnect")
  );
}

export function canRunBotScopedTask(selfId, getBotById) {
  if (selfId === null || selfId === undefined) return true;

  const id = normalizeSelfId(selfId);
  if (id == null || typeof getBotById !== "function") return false;
  return Boolean(getBotById(id));
}

export function bindBotRoute(bindings, selfId, client, routeKey) {
  const id = normalizeSelfId(selfId);
  if (id == null) return false;

  bindings.set(id, { client, routeKey });
  return true;
}

export function cleanupBotRoutes(
  bindings,
  { client, routeKey, selfIds = [], removeBot }
) {
  const explicitSelfIds = Array.isArray(selfIds) ? selfIds : [];
  const normalizedSelfIds = [...new Set(explicitSelfIds
    .map(normalizeSelfId)
    .filter((selfId) => selfId != null))];
  const candidates = explicitSelfIds.length > 0
    ? normalizedSelfIds.map((selfId) => [selfId, bindings.get(selfId)])
    : Array.from(bindings.entries());
  const removedSelfIds = [];

  for (const [selfId, bound] of candidates) {
    if (!bound || bound.client !== client) continue;
    if (routeKey && bound.routeKey !== routeKey) continue;

    bindings.delete(selfId);
    removeBot(selfId);
    removedSelfIds.push(selfId);
  }

  return removedSelfIds;
}
