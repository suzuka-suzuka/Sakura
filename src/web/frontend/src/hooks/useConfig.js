import { useState, useEffect, useCallback } from 'react';

const API_BASE = '';

/**
 * 配置数据管理 Hook — 支持框架 + 插件配置
 */
export function useConfig() {
    const [config, setConfig] = useState(null);
    const [schema, setSchema] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [errors, setErrors] = useState(null);
    const [token, setToken] = useState(() => localStorage.getItem('sakura_token'));
    const [isLoggedIn, setIsLoggedIn] = useState(!!localStorage.getItem('sakura_token'));

    // 插件相关状态
    const [plugins, setPlugins] = useState({});           // { pluginName: [moduleNames] }
    const [pluginCategories, setPluginCategories] = useState({}); // { pluginName: { Category: [Modules] } }
    const [pluginMeta, setPluginMeta] = useState({});       // { pluginName: { displayName, icon } }
    const [pluginSchemas, setPluginSchemas] = useState({}); // { pluginName: { moduleName: schemaMeta } }
    const [pluginConfigs, setPluginConfigs] = useState({}); // { pluginName: { moduleName: config } }

    const headers = useCallback(() => ({
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }), [token]);

    // ============ 认证 ============

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
        } catch (e) {
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
        setPluginMeta({});
        setPluginMeta({});
        localStorage.removeItem('sakura_token');
    }, []);

    // ============ 框架配置 ============

    const fetchSchema = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/schema`, { headers: headers() });
            if (res.status === 401) { logout(); return; }
            const data = await res.json();
            if (data.success) setSchema(data.data);
        } catch (e) {
            console.error('获取 schema 失败:', e);
        }
    }, [headers, logout]);

    const fetchConfig = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/config`, { headers: headers() });
            if (res.status === 401) { logout(); return; }
            const data = await res.json();
            if (data.success) {
                setConfig(data.data);
                setErrors(data.errors);
            }
        } catch (e) {
            console.error('获取配置失败:', e);
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
        } catch (e) {
            return { success: false, errors: [{ message: '保存失败' }] };
        } finally {
            setSaving(false);
        }
    }, [headers]);

    // ============ 插件配置 ============

    const fetchPlugins = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/plugins`, { headers: headers() });
            if (res.status === 401) { logout(); return; }
            const data = await res.json();
            if (data.success) {
                // 后端返回 { pluginName: { modules: [], categories: {} } }
                // 或者旧版 { pluginName: [modules] }

                const nextPlugins = {};
                const nextCategories = {};
                const nextMeta = {};

                for (const [name, info] of Object.entries(data.data)) {
                    if (Array.isArray(info)) {
                        nextPlugins[name] = info;
                    } else {
                        nextPlugins[name] = info.modules || [];
                        nextCategories[name] = info.categories || null;
                        if (info.meta) nextMeta[name] = info.meta;
                    }
                }

                setPlugins(nextPlugins);
                setPluginCategories(nextCategories);
                setPluginMeta(nextMeta);

                // 批量加载每个插件的 schema 和 config
                for (const pluginName of Object.keys(data.data)) {
                    // Schema
                    fetch(`${API_BASE}/api/plugins/${pluginName}/schema`, { headers: headers() })
                        .then(r => r.json())
                        .then(d => {
                            if (d.success) {
                                setPluginSchemas(prev => ({ ...prev, [pluginName]: d.data }));
                            }
                        })
                        .catch(() => { });

                    // Config
                    fetch(`${API_BASE}/api/plugins/${pluginName}/config`, { headers: headers() })
                        .then(r => r.json())
                        .then(d => {
                            if (d.success) {
                                setPluginConfigs(prev => ({ ...prev, [pluginName]: d.data }));
                            }
                        })
                        .catch(() => { });
                }
            }
        } catch (e) {
            console.error('获取插件列表失败:', e);
        }
    }, [headers, logout]);

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
                setPluginConfigs(prev => ({
                    ...prev,
                    [pluginName]: {
                        ...prev[pluginName],
                        [moduleName]: newConfig,
                    },
                }));
                return { success: true };
            }
            return { success: false, errors: data.errors };
        } catch (e) {
            return { success: false, errors: [{ message: '保存失败' }] };
        } finally {
            setSaving(false);
        }
    }, [headers]);

    // ============ 初始加载 ============

    useEffect(() => {
        if (isLoggedIn) {
            Promise.all([
                fetchSchema(),
                fetchConfig(),
                fetchPlugins(),
            ]).finally(() => setLoading(false));
        } else {
            setLoading(false);
        }
    }, [isLoggedIn, fetchSchema, fetchConfig, fetchPlugins]);

    // ============ WebSocket 回调 ============

    const updateFromWs = useCallback((newConfig) => {
        setConfig(newConfig);
    }, []);

    const updatePluginFromWs = useCallback((pluginName, moduleName, data) => {
        setPluginConfigs(prev => ({
            ...prev,
            [pluginName]: {
                ...prev[pluginName],
                [moduleName]: data,
            },
        }));
    }, []);

    return {
        config, schema, loading, saving, errors,
        isLoggedIn, token,
        login, logout,
        saveConfig,
        updateFromWs,
        // 插件
        plugins,
        pluginCategories,
        pluginMeta,
        pluginSchemas,
        pluginConfigs,
        savePluginConfig,
        updatePluginFromWs,
    };
}
