export function normalizeAccountSelfId(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

export function resolvePluginScopeSelfId(accounts, preferredSelfId = null) {
    const onlineAccounts = (Array.isArray(accounts) ? accounts : [])
        .filter((account) => account?.status !== 'offline')
        .map((account) => ({
            ...account,
            self_id: normalizeAccountSelfId(account?.self_id),
        }))
        .filter((account) => account.self_id != null);

    if (onlineAccounts.length <= 1) {
        return null;
    }

    const preferred = normalizeAccountSelfId(preferredSelfId);
    if (preferred != null && onlineAccounts.some((account) => account.self_id === preferred)) {
        return preferred;
    }

    return onlineAccounts[0].self_id;
}

