export const AUTH_TOKEN_STORAGE_KEY = 'sakura_token';
export const AUTH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function parseStoredAuth(value) {
    if (!value) return null;

    const now = Date.now();
    const fallback = (rawToken) => {
        const token = String(rawToken || '').trim();
        return token ? { token, expiresAt: now + AUTH_TOKEN_TTL_MS } : null;
    };

    try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && parsed.token) {
            const expiresAt = Number(parsed.expiresAt) || now + AUTH_TOKEN_TTL_MS;
            if (expiresAt <= now) return null;
            return { token: String(parsed.token), expiresAt };
        }
    } catch {
        return fallback(value);
    }

    return fallback(value);
}

export function storeAuthState(token, expiresAt = Date.now() + AUTH_TOKEN_TTL_MS) {
    if (!token) return;

    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, JSON.stringify({
        token,
        expiresAt: Number(expiresAt) || Date.now() + AUTH_TOKEN_TTL_MS,
        updatedAt: Date.now(),
    }));
    sessionStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
}

export function clearAuthState() {
    sessionStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
}

export function readAuthState() {
    const localValue = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    const localState = parseStoredAuth(localValue);
    if (localState) {
        storeAuthState(localState.token, localState.expiresAt);
        return localState;
    }
    if (localValue) {
        localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    }

    const sessionValue = sessionStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    const sessionState = parseStoredAuth(sessionValue);
    if (sessionState) {
        storeAuthState(sessionState.token, sessionState.expiresAt);
        return sessionState;
    }
    if (sessionValue) {
        sessionStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    }

    return null;
}

export function readAuthToken({ touch = false } = {}) {
    const state = readAuthState();
    if (!state) return null;
    if (touch) {
        storeAuthState(state.token);
    }
    return state.token;
}

export function touchAuthToken(token, expiresAt = Date.now() + AUTH_TOKEN_TTL_MS) {
    if (!token) return;
    const state = readAuthState();
    if (!state || state.token !== token) return;
    storeAuthState(token, expiresAt);
}
