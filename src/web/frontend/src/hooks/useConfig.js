import { useState, useEffect, useCallback } from 'react';

const API_BASE = '';
const PLUGIN_SELF_ID_STORAGE_KEY = 'sakura_plugin_self_id';

function normalizeSelfId(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function scopeKeyOf(selfId) {
    return selfId == null ? '__default__' : String(selfId);
}

export function useConfig() {
    const [config, setConfig] = useState(null);
    const [schema, setSchema] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [errors, setErrors] = useState(null);
    const [token, setToken] = useState(() => localStorage.getItem('sakura_token'));
    const [isLoggedIn, setIsLoggedIn] = useState(!!localStorage.getItem('sakura_token'));

    const [plugins, setPlugins] = useState({});
    const [pluginCategories, setPluginCategories] = useState({});
    const [pluginMeta, setPluginMeta] = useState({});
    const [pluginSchemas, setPluginSchemas] = useState({});
    const [pluginConfigs, setPluginConfigs] = useState({});
    const [botAccounts, setBotAccounts] = useState([]);
    const [configuredAccountIds, setConfiguredAccountIds] = useState([]); // 已有独立配置文件的账号 ID
    const [selectedPluginSelfId, setSelectedPluginSelfIdState] = useState(() =>
        normalizeSelfId(localStorage.getItem(PLUGIN_SELF_ID_STORAGE_KEY))
    );

    // 分账号框架基本配置
    const [accountSchema, setAccountSchema] = useState(null);
    const [accountConfigs, setAccountConfigs] = useState({}); // selfId → config

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
                localStorage.setItem('sakura_token', data.token);
                return { success: true };
            }
            return { success: false, error: data.error };
        } catch {
            return { success: false, error: '杩炴帴澶辫触' };
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
        setSelectedPluginSelfIdState(null);
        localStorage.removeItem('sakura_token');
        localStorage.removeItem(PLUGIN_SELF_ID_STORAGE_KEY);
    }, []);

    const fetchSchema = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/schema`, { headers: headers() });
            if (res.status === 401) { logout(); return; }
            const data = await res.json();
            if (data.success) setSchema(data.data);
        } catch (error) {
            console.error('获取 schema 失败:', error);
        }
    }, [headers, logout]);

    const fetchAccountSchema = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/account-schema`, { headers: headers() });
            if (res.status === 401) { logout(); return; }
            const data = await res.json();
            if (data.success) setAccountSchema(data.data);
        } catch (error) {
            console.error('获取账号 schema 失败:', error);
        }
    }, [headers, logout]);

    const fetchAccountConfig = useCallback(async (selfId) => {
        const normalizedSelfId = normalizeSelfId(selfId);
        if (!normalizedSelfId) return;
        try {
            const res = await fetch(`${API_BASE}/api/account-config?selfId=${normalizedSelfId}`, { headers: headers() });
            if (res.status === 401) { logout(); return; }
            const data = await res.json();
            if (data.success) {
                setAccountConfigs(prev => ({ ...prev, [normalizedSelfId]: data.data }));
            }
        } catch (error) {
            console.error(`获取账号 ${selfId} 配置失败:`, error);
        }
    }, [headers, logout]);

    const saveAccountConfig = useCallback(async (selfId, newConfig) => {
        const normalizedSelfId = normalizeSelfId(selfId);
        if (!normalizedSelfId) return { success: false, errors: [{ message: '请先选择账号' }] };
        setSaving(true);
        try {
            const res = await fetch(`${API_BASE}/api/account-config?selfId=${normalizedSelfId}`, {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify({ data: newConfig }),
            });
            const data = await res.json();
            if (data.success) {
                setAccountConfigs(prev => ({ ...prev, [normalizedSelfId]: newConfig }));
                // 保存后将此账号加入已配置列表（确保顶部标签栏下次显示）
                setConfiguredAccountIds(prev =>
                    prev.includes(normalizedSelfId) ? prev : [...prev, normalizedSelfId]
                );
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
            console.error('鑾峰彇閰嶇疆澶辫触:', error);
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
            return { success: false, errors: [{ message: '淇濆瓨澶辫触' }] };
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
                setSelectedPluginSelfId(null);
                return;
            }

            const accounts = Array.isArray(data.data?.accounts) ? data.data.accounts : [];
            setBotAccounts(accounts);
            setConfiguredAccountIds(Array.isArray(data.data?.configuredAccountIds) ? data.data.configuredAccountIds : []);

            const storedSelfId = normalizeSelfId(localStorage.getItem(PLUGIN_SELF_ID_STORAGE_KEY));
            const currentSelfId = normalizeSelfId(selectedPluginSelfId);
            const preferredSelfId = currentSelfId ?? storedSelfId;
            const hasPreferred = preferredSelfId != null && accounts.some((account) => Number(account.self_id) === preferredSelfId);
            const nextSelfId = hasPreferred ? preferredSelfId : normalizeSelfId(accounts[0]?.self_id);
            setSelectedPluginSelfId(nextSelfId);
        } catch (error) {
            console.error('鑾峰彇 Bot 淇℃伅澶辫触:', error);
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
            if (!data.success) return;

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
                    .catch(() => { });
            }
        } catch (error) {
            console.error('鑾峰彇鎻掍欢鍒楄〃澶辫触:', error);
        }
    }, [headers, logout]);

    const fetchPluginConfigsForSelf = useCallback(async (selfId) => {
        const normalizedSelfId = normalizeSelfId(selfId);
        if (!isLoggedIn || normalizedSelfId == null) {
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
                    `${API_BASE}/api/plugins/${pluginName}/config?selfId=${normalizedSelfId}`,
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
                console.error(`鑾峰彇鎻掍欢 ${pluginName} 閰嶇疆澶辫触:`, error);
            }
        }));
    }, [headers, isLoggedIn, logout, plugins]);

    const savePluginConfig = useCallback(async (pluginName, moduleName, newConfig, selfId = selectedPluginSelfId) => {
        const normalizedSelfId = normalizeSelfId(selfId);
        if (normalizedSelfId == null) {
            return { success: false, errors: [{ message: '璇峰厛閫夋嫨璐﹀彿' }] };
        }

        setSaving(true);
        try {
            const res = await fetch(`${API_BASE}/api/plugins/${pluginName}/${moduleName}/config?selfId=${normalizedSelfId}`, {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify({ data: newConfig }),
            });
            const data = await res.json();
            if (data.success) {
                const scopeKey = scopeKeyOf(normalizedSelfId);
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
            return { success: false, errors: [{ message: '淇濆瓨澶辫触' }] };
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

    // 当切换账号时，按需拉取该账号的基本配置
    useEffect(() => {
        if (!isLoggedIn || selectedPluginSelfId == null) return;
        if (accountConfigs[selectedPluginSelfId] !== undefined) return; // 已缓存
        fetchAccountConfig(selectedPluginSelfId);
    }, [isLoggedIn, selectedPluginSelfId, accountConfigs, fetchAccountConfig]);

    useEffect(() => {
        if (!isLoggedIn || selectedPluginSelfId == null || Object.keys(plugins).length === 0) {
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
