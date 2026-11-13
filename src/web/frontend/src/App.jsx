import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConfig } from './hooks/useConfig';
import { useWebSocket } from './hooks/useWebSocket';
import { useSystemInfo } from './hooks/useSystemInfo';
import LoginPage from './components/LoginPage';
import SystemMonitor from './components/SystemMonitor';
import FileManager from './components/FileManager';
import Sidebar from './components/Sidebar';
import SearchPalette from './components/SearchPalette';
import Icon from './components/Icon';
import { ObjectConfigPage, PageHeader, PluginConfigPage } from './components/ConfigPage';
import { resolvePluginScopeSelfId } from './utils/accountScope';
import { buildPluginNavigation, collectFieldLabels, fieldAnchorId } from './utils/schemaLayout';

const DEFAULT_SCOPE_KEY = '__default__';
const THEME_STORAGE_KEY = 'sakura_theme';

function readRoute() {
    const hash = window.location.hash.replace(/^#\/?/, '');
    const [kind = 'monitor', ...rest] = hash.split('/').map((part) => decodeURIComponent(part));
    if (kind === 'plugin' && rest.length >= 2) return { kind, plugin: rest[0], page: rest[1] };
    if (['monitor', 'framework', 'account', 'files'].includes(kind)) return { kind };
    return { kind: 'monitor' };
}

function routeKey(route) {
    return route.kind === 'plugin' ? `plugin:${route.plugin}:${route.page}` : route.kind;
}

function routeHash(route) {
    if (route.kind === 'plugin') return `#/plugin/${encodeURIComponent(route.plugin)}/${encodeURIComponent(route.page)}`;
    return `#/${route.kind}`;
}

function readTheme() {
    try {
        const stored = localStorage.getItem(THEME_STORAGE_KEY);
        if (stored === 'light' || stored === 'dark') return stored;
    } catch { /* 浏览器禁用存储时使用系统主题 */ }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function AccountSwitcher({ accounts, selectedSelfId, onSelect }) {
    if (!accounts || accounts.length < 2) return null;
    return (
        <div className="account-switcher" role="radiogroup" aria-label="选择账号">
            {accounts.map((account) => {
                const active = Number(account.self_id) === Number(selectedSelfId);
                return (
                    <button
                        key={account.self_id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={`account-chip ${active ? 'active' : ''}`}
                        onClick={() => onSelect(account.self_id)}
                        title={`${account.nickname || 'Bot'}（${account.self_id}）`}
                    >
                        <img
                            src={`https://q1.qlogo.cn/g?b=qq&nk=${account.uin || account.self_id}&s=100`}
                            alt=""
                            onError={(event) => { event.currentTarget.style.visibility = 'hidden'; }}
                        />
                        <span>{account.nickname || account.self_id}</span>
                    </button>
                );
            })}
        </div>
    );
}

function App() {
    const {
        config,
        schema,
        loading,
        errors,
        isLoggedIn,
        token,
        login,
        logout,
        saveConfig,
        updateFromWs,
        plugins,
        pluginSchemas,
        pluginConfigs,
        pluginCategories,
        pluginMeta,
        savePluginConfig,
        updatePluginFromWs,
        botAccounts,
        selectedPluginSelfId,
        setSelectedPluginSelfId,
        accountSchema,
        accountConfigs,
        saveAccountConfig,
    } = useConfig();

    const effectivePluginSelfId = resolvePluginScopeSelfId(botAccounts, selectedPluginSelfId);
    const [route, setRoute] = useState(readRoute);
    const [toasts, setToasts] = useState([]);
    const [theme, setTheme] = useState(readTheme);
    const [searchOpen, setSearchOpen] = useState(false);
    const [navOpen, setNavOpen] = useState(false);
    const [pendingAnchor, setPendingAnchor] = useState(null);

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
    }, [theme]);

    useEffect(() => {
        const onHashChange = () => setRoute(readRoute());
        window.addEventListener('hashchange', onHashChange);
        return () => window.removeEventListener('hashchange', onHashChange);
    }, []);

    useEffect(() => {
        const onKeyDown = (event) => {
            const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                setSearchOpen((open) => !open);
            } else if (event.key === '/' && !typing && !searchOpen) {
                event.preventDefault();
                setSearchOpen(true);
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [searchOpen]);

    const toggleTheme = useCallback(() => {
        setTheme((current) => {
            const next = current === 'dark' ? 'light' : 'dark';
            try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* 忽略 */ }
            return next;
        });
    }, []);

    const addToast = useCallback((message, type = 'info') => {
        const id = `${Date.now()}-${Math.random()}`;
        setToasts((prev) => [...prev.slice(-3), { id, message, type }]);
        setTimeout(() => setToasts((prev) => prev.filter((item) => item.id !== id)), 3200);
    }, []);

    const onConfigChanged = useCallback((newConfig) => {
        updateFromWs(newConfig);
        addToast('框架配置已在别处更新', 'info');
    }, [updateFromWs, addToast]);

    const onPluginConfigChanged = useCallback((pluginName, moduleName, data, selfId) => {
        updatePluginFromWs(pluginName, moduleName, data, selfId);
    }, [updatePluginFromWs]);

    const { connected } = useWebSocket(isLoggedIn ? token : null, onConfigChanged, onPluginConfigChanged, logout);

    const { staticInfo, dynamicInfo, botInfo, loading: systemLoading } = useSystemInfo(
        isLoggedIn ? token : null,
        isLoggedIn && route.kind === 'monitor',
        logout,
    );

    // ===== 导航 =====
    const pluginNav = useMemo(() => {
        const result = {};
        for (const name of Object.keys(plugins || {})) {
            result[name] = buildPluginNavigation(name, pluginCategories?.[name], plugins[name] || []);
        }
        return result;
    }, [plugins, pluginCategories]);

    const navGroups = useMemo(() => {
        const groups = [
            { title: '', items: [{ key: 'monitor', title: '系统概览', icon: 'activity', route: { kind: 'monitor' } }] },
            {
                title: '框架',
                items: [
                    { key: 'framework', title: '连接与基础', icon: 'plug', route: { kind: 'framework' } },
                    { key: 'account', title: '账号设置', icon: 'user', route: { kind: 'account' } },
                ],
            },
        ];
        const pluginNames = Object.keys(pluginNav);
        for (const name of pluginNames) {
            const displayName = pluginMeta?.[name]?.displayName || name;
            for (const group of pluginNav[name]) {
                groups.push({
                    title: pluginNames.length > 1 ? `${displayName}${group.title ? ` · ${group.title}` : ''}` : (group.title || displayName),
                    items: group.pages.map((page) => {
                        const pageRoute = { kind: 'plugin', plugin: name, page: page.key };
                        return { key: routeKey(pageRoute), title: page.title, icon: page.icon, route: pageRoute, page, groupTitle: group.title };
                    }),
                });
            }
        }
        groups.push({ title: '工具', items: [{ key: 'files', title: '文件管理', icon: 'folder', route: { kind: 'files' } }] });
        return groups;
    }, [pluginNav, pluginMeta]);

    const navItems = useMemo(() => navGroups.flatMap((group) => group.items), [navGroups]);
    const activeKey = routeKey(route);
    const activeItem = navItems.find((item) => item.key === activeKey);

    const navigate = useCallback((nextRoute, anchor = null) => {
        const hash = routeHash(nextRoute);
        if (window.location.hash !== hash) window.location.hash = hash;
        setRoute(nextRoute);
        setNavOpen(false);
        setPendingAnchor(anchor);
        if (!anchor) window.scrollTo({ top: 0 });
    }, []);

    // 搜索跳转后滚动到具体设置项，并短暂高亮
    useEffect(() => {
        if (!pendingAnchor) return undefined;
        let attempts = 0;
        const timer = window.setInterval(() => {
            const element = document.getElementById(pendingAnchor);
            attempts += 1;
            if (element) {
                element.scrollIntoView({ block: 'center' });
                element.classList.add('flash');
                // 同页其他模块加载完成后布局会变化，再对齐一次
                window.setTimeout(() => element.scrollIntoView({ behavior: 'smooth', block: 'center' }), 400);
                window.setTimeout(() => element.classList.remove('flash'), 2000);
            }
            if (element || attempts > 30) {
                window.clearInterval(timer);
                setPendingAnchor(null);
            }
        }, 60);
        return () => window.clearInterval(timer);
    }, [pendingAnchor, route]);

    // ===== 搜索索引 =====
    const searchEntries = useMemo(() => {
        const entries = [];
        for (const item of navItems) {
            entries.push({
                id: `page:${item.key}`,
                kind: 'page',
                title: item.title,
                subtitle: item.groupTitle || '',
                icon: item.icon,
                keywords: item.page?.description || '',
                route: item.route,
            });
            if (item.route.kind === 'plugin') {
                for (const module of item.page.modules) {
                    const moduleSchema = pluginSchemas?.[item.route.plugin]?.[module];
                    for (const field of collectFieldLabels(moduleSchema)) {
                        if (field.key.includes('.')) continue;
                        entries.push({
                            id: `field:${item.key}:${module}:${field.key}`,
                            kind: 'field',
                            title: field.label,
                            subtitle: [item.title, field.group].filter(Boolean).join(' › '),
                            keywords: field.help,
                            route: item.route,
                            anchor: fieldAnchorId(module, field.key),
                        });
                    }
                }
            }
        }
        if (schema?.children) {
            for (const [sectionKey, sectionMeta] of Object.entries(schema.children)) {
                const sectionTitle = sectionMeta.label || sectionMeta.description || sectionKey;
                if (sectionMeta.type === 'object' && sectionMeta.children) {
                    for (const field of collectFieldLabels(sectionMeta)) {
                        if (field.key.includes('.')) continue;
                        entries.push({
                            id: `framework:${sectionKey}:${field.key}`,
                            kind: 'field',
                            title: field.label,
                            subtitle: `连接与基础 › ${sectionTitle}`,
                            route: { kind: 'framework' },
                            anchor: fieldAnchorId(sectionKey, field.key),
                        });
                    }
                } else {
                    entries.push({
                        id: `framework:root:${sectionKey}`,
                        kind: 'field',
                        title: sectionTitle,
                        subtitle: '连接与基础',
                        route: { kind: 'framework' },
                        anchor: fieldAnchorId('root', sectionKey),
                    });
                }
            }
        }
        return entries;
    }, [navItems, pluginSchemas, schema]);

    // ===== 保存 =====
    const toResult = useCallback((result, successMessage) => {
        if (result.success) addToast(successMessage, 'success');
        else addToast('保存失败，请检查标红的内容', 'error');
        return result;
    }, [addToast]);

    const handleFrameworkSave = useCallback(
        async (next) => toResult(await saveConfig(next), '框架配置已保存'),
        [saveConfig, toResult]
    );
    const handleAccountSave = useCallback(
        async (next) => toResult(await saveAccountConfig(effectivePluginSelfId, next), '账号配置已保存'),
        [saveAccountConfig, effectivePluginSelfId, toResult]
    );

    // ===== 渲染 =====
    if (!isLoggedIn) return <LoginPage onLogin={login} />;
    if (loading) {
        return (
            <div className="boot-screen">
                <div className="spinner" />
            </div>
        );
    }

    const scopeKey = effectivePluginSelfId == null ? DEFAULT_SCOPE_KEY : String(effectivePluginSelfId);
    const accountSwitcher = (
        <AccountSwitcher accounts={botAccounts} selectedSelfId={effectivePluginSelfId} onSelect={setSelectedPluginSelfId} />
    );

    const renderPage = () => {
        if (route.kind === 'monitor') {
            return (
                <div className="page">
                    <PageHeader title="系统概览" icon="activity" />
                    <SystemMonitor staticInfo={staticInfo} dynamicInfo={dynamicInfo} botInfo={botInfo} loading={systemLoading} />
                </div>
            );
        }

        if (route.kind === 'files') {
            return (
                <div className="page page--wide">
                    <PageHeader title="文件管理" icon="folder" />
                    <FileManager token={token} onUnauthorized={logout} onToast={addToast} />
                </div>
            );
        }

        if (route.kind === 'framework') {
            const children = schema?.children || {};
            const rootChildren = Object.fromEntries(
                Object.entries(children).filter(([, meta]) => !(meta.type === 'object' && meta.children))
            );
            const sections = [
                ...(Object.keys(rootChildren).length > 0
                    ? [{ key: null, title: '基础', meta: { children: rootChildren } }]
                    : []),
                ...Object.entries(children)
                    .filter(([, meta]) => meta.type === 'object' && meta.children)
                    .map(([key, meta]) => ({ key, title: meta.label || meta.description || key, help: meta.help, meta })),
            ];
            return (
                <ObjectConfigPage
                    title="连接与基础"
                    icon="plug"
                    schema={schema}
                    config={config}
                    sections={sections}
                    onSave={handleFrameworkSave}
                    warnings={errors?.length > 0 ? (
                        <div className="callout callout-warn">
                            <Icon name="alert" size={16} />
                            <div>
                                <div className="callout-title">当前配置文件有问题</div>
                                <ul>{errors.map((item, index) => <li key={index}>{item.path?.join('.') || '?'}：{item.message}</li>)}</ul>
                            </div>
                        </div>
                    ) : null}
                />
            );
        }

        if (route.kind === 'account') {
            return (
                <ObjectConfigPage
                    key={`account:${scopeKey}`}
                    title="账号设置"
                    icon="user"
                    schema={accountSchema}
                    config={accountConfigs[scopeKey] ?? null}
                    sections={accountSchema?.children ? [{ key: null, title: '', meta: accountSchema }] : []}
                    onSave={handleAccountSave}
                    scopeSelfId={effectivePluginSelfId}
                    headerActions={accountSwitcher}
                />
            );
        }

        if (route.kind === 'plugin' && activeItem?.page) {
            const pluginName = route.plugin;
            return (
                <PluginConfigPage
                    key={`${activeKey}:${scopeKey}`}
                    page={activeItem.page}
                    schemas={pluginSchemas[pluginName] || {}}
                    configs={pluginConfigs[pluginName]?.[scopeKey] || {}}
                    scopeSelfId={effectivePluginSelfId}
                    headerActions={accountSwitcher}
                    onSaveModule={async (module, data) => {
                        const result = await savePluginConfig(pluginName, module, data, effectivePluginSelfId);
                        if (result.success) addToast(`已保存`, 'success');
                        else addToast('保存失败，请检查标红的内容', 'error');
                        return result;
                    }}
                />
            );
        }

        return (
            <div className="page">
                <PageHeader title="页面不存在" />
                <button type="button" className="btn btn-secondary" onClick={() => navigate({ kind: 'monitor' })}>回到概览</button>
            </div>
        );
    };

    return (
        <div className="app">
            <div className="toast-stack" aria-live="polite">
                {toasts.map((toast) => (
                    <div key={toast.id} className={`toast toast-${toast.type}`}>
                        <Icon name={toast.type === 'success' ? 'check' : toast.type === 'error' ? 'alert' : 'info'} size={16} />
                        {toast.message}
                    </div>
                ))}
            </div>

            <Sidebar
                groups={navGroups}
                activeKey={activeKey}
                onNavigate={(item) => navigate(item.route)}
                onOpenSearch={() => setSearchOpen(true)}
                connected={connected}
                theme={theme}
                onToggleTheme={toggleTheme}
                onLogout={logout}
                open={navOpen}
                onClose={() => setNavOpen(false)}
            />

            <main className="main">
                <div className="mobile-bar">
                    <button type="button" className="icon-btn" onClick={() => setNavOpen(true)} aria-label="打开导航">
                        <Icon name="menu" size={20} />
                    </button>
                    <span className="mobile-bar-title">{activeItem?.title || 'Sakura'}</span>
                    <button type="button" className="icon-btn" onClick={() => setSearchOpen(true)} aria-label="搜索设置">
                        <Icon name="search" size={19} />
                    </button>
                </div>
                {renderPage()}
            </main>

            {searchOpen && (
                <SearchPalette
                    entries={searchEntries}
                    onClose={() => setSearchOpen(false)}
                    onSelect={(entry) => {
                        setSearchOpen(false);
                        navigate(entry.route, entry.anchor || null);
                    }}
                />
            )}
        </div>
    );
}

export default App;
