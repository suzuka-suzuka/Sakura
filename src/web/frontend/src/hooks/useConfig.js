import { useState, useEffect, useCallback } from 'react';
import { clearAuthState, readAuthToken, storeAuthState, touchAuthToken } from '../utils/authStorage';
import { invalidateDynamicOptions } from './useDynamicOptions';

const API_BASE = '';

// 一个实例只服务一个 QQ 号，面板里的配置就是这个实例的配置，没有账号作用域
export function useConfig() {
    const [config, setConfig] = useState(null);
    const [schema, setSchema] = useState(null);
    // 登录后首轮数据是否加载完成；loading 由它派生，避免在 effect 里同步 setState
    const [bootLoaded, setBootLoaded] = useState(false);
    const [saving, setSaving] = useState(false);
    const [errors, setErrors] = useState(null);
    const [token, setToken] = useState(() => readAuthToken());
    const [isLoggedIn, setIsLoggedIn] = useState(() => !!readAuthToken());

    const [plugins, setPlugins] = useState({});
    const [pluginCategories, setPluginCategories] = useState({});
    const [pluginMeta, setPluginMeta] = useState({});
    const [pluginSchemas, setPluginSchemas] = useState({});
    const [pluginConfigs, setPluginConfigs] = useState({});

    const headers = useCallback(() => {
        if (token) {
            touchAuthToken(token);
        }

        return {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        };
    }, [token]);

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
                storeAuthState(data.token, data.expiresAt);
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
        setBootLoaded(false);
        clearAuthState();
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

    const fetchPluginConfigs = useCallback(async () => {
        if (!isLoggedIn) {
            return;
        }

        const currentPlugins = Object.keys(plugins);
        if (currentPlugins.length === 0) {
            return;
        }

        await Promise.all(currentPlugins.map(async (pluginName) => {
            try {
                const res = await fetch(`${API_BASE}/api/plugins/${pluginName}/config`, { headers: headers() });
                if (res.status === 401) {
                    logout();
                    return;
                }

                const data = await res.json();
                if (data.success) {
                    setPluginConfigs((prev) => ({ ...prev, [pluginName]: data.data }));
                }
            } catch (error) {
                console.error(`Failed to fetch plugin config for ${pluginName}:`, error);
            }
        }));
    }, [headers, isLoggedIn, logout, plugins]);

    const savePluginConfig = useCallback(async (pluginName, moduleName, newConfig) => {
        setSaving(true);
        try {
            const res = await fetch(`${API_BASE}/api/plugins/${pluginName}/${moduleName}/config`, {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify({ data: newConfig }),
            });
            const data = await res.json();
            if (data.success) {
                setPluginConfigs((prev) => ({
                    ...prev,
                    [pluginName]: {
                        ...(prev[pluginName] || {}),
                        [moduleName]: newConfig,
                    },
                }));
                // 只在保存的模块提供动态选项时刷新，刷新期间保留已有字段。
                invalidateDynamicOptions({ pluginName, moduleName });
                return { success: true };
            }
            return { success: false, errors: data.errors };
        } catch {
            return { success: false, errors: [{ message: '保存失败' }] };
        } finally {
            setSaving(false);
        }
    }, [headers]);

    const loading = isLoggedIn && !bootLoaded;

    useEffect(() => {
        if (!isLoggedIn) {
            return;
        }

        // 这些请求函数在 401 时会调用 logout()（含 setState），lint 无法判断那发生在 await 之后，
        // 所以从 Promise 回调里发起，明确不在 effect 同步阶段改状态
        Promise.resolve()
            .then(() => Promise.all([
                fetchSchema(),
                fetchConfig(),
                fetchPlugins(),
            ]))
            .finally(() => setBootLoaded(true));
    }, [isLoggedIn, fetchSchema, fetchConfig, fetchPlugins]);

    useEffect(() => {
        if (!isLoggedIn || Object.keys(plugins).length === 0) {
            return;
        }

        fetchPluginConfigs();
    }, [isLoggedIn, plugins, fetchPluginConfigs]);

    const updateFromWs = useCallback((newConfig) => {
        setConfig(newConfig);
    }, []);

    const updatePluginFromWs = useCallback((pluginName, moduleName, data) => {
        // 面板保存也会收到文件热重载的回声；按来源刷新，不清空已有选项。
        invalidateDynamicOptions({ pluginName, moduleName });
        setPluginConfigs((prev) => ({
            ...prev,
            [pluginName]: {
                ...(prev[pluginName] || {}),
                [moduleName]: data,
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
    };
}
