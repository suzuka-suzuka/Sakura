function normalizeSelfIds(values) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0))];
}

export function resolveRuntimePluginSelfId(onlineSelfIds, requestedSelfId) {
    const onlineIds = normalizeSelfIds(onlineSelfIds);
    if (onlineIds.length <= 1) return null;

    const requested = Number(requestedSelfId);
    return Number.isFinite(requested) && requested > 0 && onlineIds.includes(requested)
        ? requested
        : null;
}

export function getCronPluginScopeIds(onlineSelfIds) {
    const onlineIds = normalizeSelfIds(onlineSelfIds);
    return onlineIds.length > 1 ? onlineIds : [];
}
