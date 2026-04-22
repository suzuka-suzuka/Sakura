import { useState, useEffect, useCallback } from 'react';

const API_BASE = '';
const AUTH_TOKEN_STORAGE_KEY = 'sakura_token';
const PLUGIN_SELF_ID_STORAGE_KEY = 'sakura_plugin_self_id';
const DEFAULT_SCOPE_KEY = '__default__';

function readAuthToken() {
    const sessionToken = sessionStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    if (sessionToken) {
        return sessionToken;
    }

    const legacyToken = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    if (legacyToken) {
        sessionStorage.setItem(AUTH_TOKEN_STORAGE_KEY, legacyToken);
        localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    }

    return legacyToken;
}

function storeAuthToken(token) {
    sessionStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
}

function clearAuthToken() {
    sessionStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
}

function normalizeSelfId(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function scopeKeyOf(selfId) {
    return selfId == null ? DEFAULT_SCOPE_KEY : String(selfId);
}

function buildScopedQuery(selfId) {
    const normalizedSelfId = normalizeSelfId(selfId);
    return normalizedSelfId == null ? '' : `?selfId=${normalizedSelfId}`;
}

export function useConfig() {
    const [config, setConfig] = useState(null);
    const [schema, setSchema] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [errors, setErrors] = useState(null);
    const [token, setToken] = useState(() => readAuthToken());
    const [isLoggedIn, setIsLoggedIn] = useState(() => !!readAuthToken());

    const [plugins, setPlugins] = useState({});
    const [pluginCategories, setPluginCategories] = useState({});
    const [pluginMeta, setPluginMeta] = useState({});
    const [pluginSchemas, setPluginSchemas] = useState({});
    const [pluginConfigs, setPluginConfigs] = useState({});
    const [botAccounts, setBotAccounts] = useState([]);
    const [configuredAccountIds, setConfiguredAccountIds] = useState([]);
    const [selectedPluginSelfId, setSelectedPluginSelfIdState] = useState(() =>
        normalizeSelfId(localStorage.getItem(PLUGIN_SELF_ID_STORAGE_KEY))
    );

    const [accountSchema, setAccountSchema] = useState(null);
    const [accountConfigs, setAccountConfigs] = useState({});

    const headers = useCallback(() => ({
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }), [token]);

    const setSelectedPluginSelfId = useCallback((selfId) => {
        const normalized = normalizeSelfId(selfId);
        setSelectedPluginSelfIdState(normalized);
        if (normalized == null) {
            localStorage.removeItem(PLUGIN_SELF_ID_STORAGE_KEY);
        } else {
            localStorage.setItem(PLUGIN_SELF_ID_STORAGE_KEY, String(normalized));
        }
    }, []);

    const login = useCallback(async (password) => {
        try {
            const res = await fetch(`${API_BASE}/api/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password }),
            });
            const data = await res.json();
            if (data.success) {
                setToken(data.token);
                setIsLoggedIn(true);
                storeAuthToken(data.token);
                return { success: true };
            }
            return { success: false, error: data.error };
        } catch {
            return { success: false, error: '连接失败' };
        }
    }, []);

    const logout = useCallback(() => {
        setToken(null);
        setIsLoggedIn(false);
        setConfig(null);
        setSchema(null);
        setPlugins({});
        setPluginSchemas({});
        setPluginConfigs({});
        setPluginCategories({});
        setPluginMeta({});
        setBotAccounts([]);
        setConfiguredAccountIds([]);
        setAccountSchema(null);
        setAccountConfigs({});
        setSelectedPluginSelfIdState(null);
        clearAuthToken();
        localStorage.removeItem(PLUGIN_SELF_ID_STORAGE_KEY);
    }, []);

    const fetchSchema = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/schema`, { headers: headers() });
            if (res.status === 401) {
                logout();
                return;
            }
            const data = await res.json();
            if (data.success) {
                setSchema(data.data);
            }
        } catch (error) {
            console.error('Failed to fetch schema:', error);
        }
    }, [headers, logout]);

    const fetchAccountSchema = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/account-schema`, { headers: headers() });
            if (res.status === 401) {
                logout();
                return;
            }
            const data = await res.json();
            if (data.success) {
                setAccountSchema(data.data);
            }
        } catch (error) {
            console.error('Failed to fetch account schema:', error);
        }
    }, [headers, logout]);

    const fetchAccountConfig = useCallback(async (selfId) => {
        const normalizedSelfId = normalizeSelfId(selfId);
        const scopeKey = scopeKeyOf(normalizedSelfId);

        try {
            const res = await fetch(
                `${API_BASE}/api/account-config${buildScopedQuery(normalizedSelfId)}`,
                { headers: headers() }
            );
            if (res.status === 401) {
                logout();
                return;
            }
            const data = await res.json();
            if (data.success) {
                setAccountConfigs((prev) => ({ ...prev, [scopeKey]: data.data }));
            }
        } catch (error) {
            console.error(
                `Failed to fetch ${normalizedSelfId == null ? 'default' : `account ${normalizedSelfId}`} config:`,
                error
            );
        }
    }, [headers, logout]);

    const saveAccountConfig = useCallback(async (selfId, newConfig) => {
        const normalizedSelfId = normalizeSelfId(selfId);
        const scopeKey = scopeKeyOf(normalizedSelfId);

        setSaving(true);
        try {
            const res = await fetch(`${API_BASE}/api/account-config${buildScopedQuery(normalizedSelfId)}`, {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify({ data: newConfig }),
            });
            const data = await res.json();
            if (data.success) {
                setAccountConfigs((prev) => ({ ...prev, [scopeKey]: newConfig }));
                if (normalizedSelfId != null) {
                    setConfiguredAccountIds((prev) =>
                        prev.includes(normalizedSelfId) ? prev : [...prev, normalizedSelfId]
                    );
                }
                return { success: true };
            }
            return { success: false, errors: data.errors };
        } catch {
            return { success: false, errors: [{ message: '保存失败' }] };
        } finally {
            setSaving(false);
        }
    }, [headers]);

    const fetchConfig = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/config`, { headers: headers() });
            if (res.status === 401) {
                logout();
                return;
            }
            const data = await res.json();
            if (data.success) {
                setConfig(data.data);
                setErrors(data.errors);
            }
        } catch (error) {
            console.error('Failed to fetch config:', error);
        }
    }, [headers, logout]);

    const saveConfig = useCallback(async (newConfig) => {
        setSaving(true);
        try {
            const res = await fetch(`${API_BASE}/api/config`, {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify({ data: newConfig }),
            });
            const data = await res.json();
            if (data.success) {
                setConfig(newConfig);
                setErrors(null);
                return { success: true };
            }
            return { success: false, errors: data.errors };
        } catch {
            return { success: false, errors: [{ message: '保存失败' }] };
        } finally {
            setSaving(false);
        }
    }, [headers]);

    const fetchBotAccounts = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/bot/info`, { headers: headers() });
            if (res.status === 401) {
                logout();
                return;
            }

            const data = await res.json();
            if (!data.success) {
                setBotAccounts([]);
                setConfiguredAccountIds([]);
                setSelectedPluginSelfId(null);
                return;
            }

            const accounts = Array.isArray(data.data?.accounts) ? data.data.accounts : [];
            const nextConfiguredIds = Array.isArray(data.data?.configuredScopeIds)
                ? data.data.configuredScopeIds
                : Array.isArray(data.data?.configuredAccountIds)
                    ? data.data.configuredAccountIds
                : [];

            setBotAccounts(accounts);
            setConfiguredAccountIds(nextConfiguredIds);

            const storedSelfId = normalizeSelfId(localStorage.getItem(PLUGIN_SELF_ID_STORAGE_KEY));
            const currentSelfId = normalizeSelfId(selectedPluginSelfId);
            const preferredSelfId = currentSelfId ?? storedSelfId;
            const hasPreferred = preferredSelfId != null
                && accounts.some((account) => Number(account.self_id) === preferredSelfId);

            const soleAccountId = normalizeSelfId(accounts[0]?.self_id);
            const hasSingleScopedConfig = accounts.length === 1
                && soleAccountId != null
                && nextConfiguredIds.includes(soleAccountId);

            const nextSelfId = accounts.length > 1
                ? (hasPreferred ? preferredSelfId : normalizeSelfId(accounts[0]?.self_id))
                : (hasSingleScopedConfig ? soleAccountId : null);

            setSelectedPluginSelfId(nextSelfId);
        } catch (error) {
            console.error('Failed to fetch bot info:', error);
        }
    }, [headers, logout, selectedPluginSelfId, setSelectedPluginSelfId]);

    const fetchPlugins = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/plugins`, { headers: headers() });
            if (res.status === 401) {
                logout();
                return;
            }

            const data = await res.json();
            if (!data.success) {
                return;
            }

            const nextPlugins = {};
            const nextCategories = {};
            const nextMeta = {};

            for (const [name, info] of Object.entries(data.data)) {
                if (Array.isArray(info)) {
                    nextPlugins[name] = info;
                } else {
                    nextPlugins[name] = info.modules || [];
                    nextCategories[name] = info.categories || null;
                    if (info.meta) {
                        nextMeta[name] = info.meta;
                    }
                }
            }

            setPlugins(nextPlugins);
            setPluginCategories(nextCategories);
            setPluginMeta(nextMeta);

            for (const pluginName of Object.keys(data.data)) {
                fetch(`${API_BASE}/api/plugins/${pluginName}/schema`, { headers: headers() })
                    .then((response) => response.json())
                    .then((schemaData) => {
                        if (schemaData.success) {
                            setPluginSchemas((prev) => ({ ...prev, [pluginName]: schemaData.data }));
                        }
                    })
                    .catch(() => {});
            }
        } catch (error) {
            console.error('Failed to fetch plugins:', error);
        }
    }, [headers, logout]);

    const fetchPluginConfigsForSelf = useCallback(async (selfId) => {
        const normalizedSelfId = normalizeSelfId(selfId);
        if (!isLoggedIn) {
            return;
        }

        const currentPlugins = Object.keys(plugins);
        if (currentPlugins.length === 0) {
            return;
        }

        const scopeKey = scopeKeyOf(normalizedSelfId);

        await Promise.all(currentPlugins.map(async (pluginName) => {
            try {
                const res = await fetch(
                    `${API_BASE}/api/plugins/${pluginName}/config${buildScopedQuery(normalizedSelfId)}`,
                    { headers: headers() }
                );
                if (res.status === 401) {
                    logout();
                    return;
                }

                const data = await res.json();
                if (data.success) {
                    setPluginConfigs((prev) => ({
                        ...prev,
                        [pluginName]: {
                            ...(prev[pluginName] || {}),
                            [scopeKey]: data.data,
                        },
                    }));
                }
            } catch (error) {
                console.error(`Failed to fetch plugin config for ${pluginName}:`, error);
            }
        }));
    }, [headers, isLoggedIn, logout, plugins]);

    const savePluginConfig = useCallback(async (pluginName, moduleName, newConfig, selfId = selectedPluginSelfId) => {
        const normalizedSelfId = normalizeSelfId(selfId);
        const scopeKey = scopeKeyOf(normalizedSelfId);

        setSaving(true);
        try {
            const res = await fetch(
                `${API_BASE}/api/plugins/${pluginName}/${moduleName}/config${buildScopedQuery(normalizedSelfId)}`,
                {
                    method: 'POST',
                    headers: headers(),
                    body: JSON.stringify({ data: newConfig }),
                }
            );
            const data = await res.json();
            if (data.success) {
                setPluginConfigs((prev) => ({
                    ...prev,
                    [pluginName]: {
                        ...(prev[pluginName] || {}),
                        [scopeKey]: {
                            ...(prev[pluginName]?.[scopeKey] || {}),
                            [moduleName]: newConfig,
                        },
                    },
                }));
                return { success: true };
            }
            return { success: false, errors: data.errors };
        } catch {
            return { success: false, errors: [{ message: '保存失败' }] };
        } finally {
            setSaving(false);
        }
    }, [headers, selectedPluginSelfId]);

    useEffect(() => {
        if (!isLoggedIn) {
            setLoading(false);
            return;
        }

        setLoading(true);
        Promise.all([
            fetchSchema(),
            fetchConfig(),
            fetchPlugins(),
            fetchBotAccounts(),
            fetchAccountSchema(),
        ]).finally(() => setLoading(false));
    }, [isLoggedIn, fetchSchema, fetchConfig, fetchPlugins, fetchBotAccounts, fetchAccountSchema]);

    useEffect(() => {
        if (!isLoggedIn) {
            return;
        }

        const scopeKey = scopeKeyOf(selectedPluginSelfId);
        if (accountConfigs[scopeKey] !== undefined) {
            return;
        }

        fetchAccountConfig(selectedPluginSelfId);
    }, [isLoggedIn, selectedPluginSelfId, accountConfigs, fetchAccountConfig]);

    useEffect(() => {
        if (!isLoggedIn || Object.keys(plugins).length === 0) {
            return;
        }

        fetchPluginConfigsForSelf(selectedPluginSelfId);
    }, [isLoggedIn, plugins, selectedPluginSelfId, fetchPluginConfigsForSelf]);

    const updateFromWs = useCallback((newConfig) => {
        setConfig(newConfig);
    }, []);

    const updatePluginFromWs = useCallback((pluginName, moduleName, data, selfId = null) => {
        const scopeKey = scopeKeyOf(normalizeSelfId(selfId));
        setPluginConfigs((prev) => ({
            ...prev,
            [pluginName]: {
                ...(prev[pluginName] || {}),
                [scopeKey]: {
                    ...(prev[pluginName]?.[scopeKey] || {}),
                    [moduleName]: data,
                },
            },
        }));
    }, []);

    return {
        config,
        schema,
        loading,
        saving,
        errors,
        isLoggedIn,
        token,
        login,
        logout,
        saveConfig,
        updateFromWs,
        plugins,
        pluginCategories,
        pluginMeta,
        pluginSchemas,
        pluginConfigs,
        savePluginConfig,
        updatePluginFromWs,
        botAccounts,
        configuredAccountIds,
        selectedPluginSelfId,
        setSelectedPluginSelfId,
        accountSchema,
        accountConfigs,
        fetchAccountConfig,
        saveAccountConfig,
    };
}
