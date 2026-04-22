import { useCallback, useMemo, useState } from 'react';
import { useConfig } from './hooks/useConfig';
import { useWebSocket } from './hooks/useWebSocket';
import { useSystemInfo } from './hooks/useSystemInfo';
import LoginPage from './components/LoginPage';
import ConfigForm from './components/ConfigForm';
import PluginConfigPanel from './components/PluginConfigPanel';
import SystemMonitor from './components/SystemMonitor';

const DEFAULT_SCOPE_KEY = '__default__';

function App() {
  const {
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

  const [toasts, setToasts] = useState([]);
  const [activeSection, setActiveSection] = useState('monitor');
  const [activeCategoryIdx, setActiveCategoryIdx] = useState(0);

  const addToast = useCallback((message, type = 'info') => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 3000);
  }, []);

  const onConfigChanged = useCallback((newConfig) => {
    updateFromWs(newConfig);
    addToast('框架配置已同步更新', 'info');
  }, [updateFromWs, addToast]);

  const onPluginConfigChanged = useCallback((pluginName, moduleName, data, selfId) => {
    updatePluginFromWs(pluginName, moduleName, data, selfId);
    addToast(`${pluginName}/${moduleName} 已同步更新`, 'info');
  }, [updatePluginFromWs, addToast]);

  const { connected } = useWebSocket(
    isLoggedIn ? token : null,
    onConfigChanged,
    onPluginConfigChanged,
    logout,
  );

  const {
    staticInfo,
    dynamicInfo,
    botInfo,
    loading: systemLoading,
  } = useSystemInfo(
    isLoggedIn ? token : null,
    isLoggedIn && activeSection === 'monitor',
    logout,
  );

  const handleSave = useCallback(async (newConfig) => {
    const result = await saveConfig(newConfig);
    if (result.success) {
      addToast('框架配置保存成功', 'success');
    } else {
      const message = result.errors?.map((item) => item.message).join(', ') || '保存失败';
      addToast(message, 'error');
    }
  }, [saveConfig, addToast]);

  const handleAccountSave = useCallback(async (newConfig) => {
    const result = await saveAccountConfig(selectedPluginSelfId, newConfig);
    if (result.success) {
      addToast('账号配置保存成功', 'success');
    } else {
      const message = result.errors?.map((item) => item.message).join(', ') || '保存失败';
      addToast(message, 'error');
    }
  }, [saveAccountConfig, addToast, selectedPluginSelfId]);

  const handlePluginSave = useCallback(async (pluginName, moduleName, data) => {
    const result = await savePluginConfig(pluginName, moduleName, data, selectedPluginSelfId);
    if (result.success) {
      addToast('保存成功', 'success');
    } else {
      const message = result.errors?.map((item) => item.message).join(', ') || '保存失败';
      addToast(message, 'error');
    }
    return result;
  }, [savePluginConfig, addToast, selectedPluginSelfId]);

  const pluginNames = Object.keys(plugins || {});

  const navItems = useMemo(() => [
    { key: 'monitor', label: '系统监控', icon: '📊' },
    { key: 'framework', label: '框架配置', icon: '🌸' },
    { key: 'account', label: '账号配置', icon: '👤' },
    ...pluginNames.map((name) => {
      const meta = pluginMeta?.[name];
      return {
        key: name,
        label: meta?.displayName || name,
        icon: meta?.icon || '🧩',
      };
    }),
    { key: '__menu_editor__', label: '菜单编辑', icon: '📝' },
  ], [pluginNames, pluginMeta]);

  const accountTab = useMemo(() => {
    if (!accountSchema?.children) {
      return null;
    }

    return {
      key: '__account__',
      label: '账号配置',
      title: '账号基础配置',
      isAccount: true,
      fields: Object.entries(accountSchema.children).map(([key, meta]) => ({ key, meta })),
    };
  }, [accountSchema]);

  const categoryTabs = useMemo(() => {
    if (activeSection === 'monitor' || activeSection === 'account') {
      return [];
    }

    if (activeSection === 'framework') {
      if (!schema?.children) {
        return [];
      }

      const tabs = [];
      const topLevelFields = [];
      const objectSections = [];

      for (const [key, meta] of Object.entries(schema.children)) {
        if (meta.type === 'object' && meta.children) {
          objectSections.push({ key, meta });
        } else {
          topLevelFields.push({ key, meta });
        }
      }

      if (topLevelFields.length > 0) {
        tabs.push({
          key: '__global_basic__',
          label: '基础配置',
          title: '基础配置',
          fields: topLevelFields,
          isTop: true,
        });
      }

      for (const section of objectSections) {
        tabs.push({
          key: section.key,
          label: section.meta.label || section.meta.description || section.key,
          title: section.meta.label || section.meta.description || section.key,
          meta: section.meta,
          isObject: true,
        });
      }

      return tabs;
    }

    const categories = pluginCategories[activeSection];
    const modules = plugins[activeSection] || [];
    if (!categories) {
      return [{ key: '__all__', label: '全部配置', modules }];
    }

    const categorizedModules = new Set();
    Object.values(categories).forEach((moduleList) => {
      if (Array.isArray(moduleList)) {
        moduleList.forEach((moduleName) => categorizedModules.add(moduleName));
      }
    });

    const uncategorized = modules.filter((moduleName) => !categorizedModules.has(moduleName));
    const tabs = [];

    for (const [categoryName, moduleList] of Object.entries(categories)) {
      const validModules = moduleList.filter((moduleName) => modules.includes(moduleName));
      if (validModules.length > 0) {
        tabs.push({ key: categoryName, label: categoryName, modules: validModules });
      }
    }

    if (uncategorized.length > 0) {
      tabs.push({ key: '__other__', label: '其他', modules: uncategorized });
    }

    return tabs;
  }, [activeSection, schema, pluginCategories, plugins]);

  const safeIdx = Math.min(activeCategoryIdx, Math.max(categoryTabs.length - 1, 0));
  const currentTab = categoryTabs[safeIdx] || null;
  const isAccountSection = activeSection === 'account';
  const isPluginSection = activeSection !== 'framework' && activeSection !== 'monitor' && activeSection !== 'account';

  const showAccountTopbar = botAccounts.length > 1 && (isPluginSection || isAccountSection);

  const currentPluginScopeKey = selectedPluginSelfId == null
    ? DEFAULT_SCOPE_KEY
    : String(selectedPluginSelfId);
  const currentPluginConfigs = pluginConfigs[activeSection]?.[currentPluginScopeKey] || {};
  const currentAccountConfig = accountConfigs[currentPluginScopeKey] ?? null;
  const selectedBotAccount = botAccounts.find(
    (account) => Number(account.self_id) === Number(selectedPluginSelfId)
  ) || null;
  const canEditCurrentScope = selectedPluginSelfId == null || selectedBotAccount != null;

  const handleSectionChange = useCallback((key) => {
    setActiveSection(key);
    setActiveCategoryIdx(0);
  }, []);

  const currentNav = navItems.find((item) => item.key === activeSection);
  const sectionLabel = currentNav?.label || activeSection;

  if (!isLoggedIn) {
    return <LoginPage onLogin={login} />;
  }

  if (loading) {
    return (
      <div className="loading-container">
        <div className="spinner"></div>
      </div>
    );
  }

  return (
    <div className="app-root">
      <div className="toast-container">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.type}`}>
            {toast.message}
          </div>
        ))}
      </div>

      <div className="app-layout">
        <aside className="left-nav">
          <div className="left-nav-brand">
            <span className="left-nav-brand-icon">🌸</span>
            <span className="left-nav-brand-text">Sakura</span>
          </div>
          <div className="left-nav-divider"></div>

          <div className="left-nav-section">配置</div>
          {navItems.map((item) => (
            <button
              key={item.key}
              className={`left-nav-item ${activeSection === item.key ? 'active' : ''}`}
              onClick={() => {
                if (item.key === '__menu_editor__') {
                  window.open('/menu', '_self');
                } else {
                  handleSectionChange(item.key);
                }
              }}
            >
              <span className="left-nav-icon">{item.icon}</span>
              <span className="left-nav-label">{item.label}</span>
            </button>
          ))}

          <div className="left-nav-bottom">
            <div className="left-nav-status">
              <span className={`status-dot ${connected ? 'connected' : 'disconnected'}`}></span>
              <span className="left-nav-status-text">{connected ? '已连接' : '未连接'}</span>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={logout}>退出</button>
          </div>
        </aside>

        <main className="main-content">
          {showAccountTopbar && (
            <div className="account-topbar">
              {botAccounts.map((account) => (
                <button
                  key={account.self_id}
                  className={`account-tab ${Number(account.self_id) === Number(selectedPluginSelfId) ? 'active' : ''}`}
                  onClick={() => setSelectedPluginSelfId(account.self_id)}
                >
                  <img
                    className="account-tab-avatar"
                    src={`https://q1.qlogo.cn/g?b=qq&nk=${account.uin || account.self_id}&s=100`}
                    alt=""
                    onError={(event) => {
                      event.target.src = 'https://q1.qlogo.cn/g?b=qq&nk=10000&s=100';
                    }}
                  />
                  <span className="account-tab-name">{account.nickname || 'Bot'}</span>
                  <span className="account-tab-id">{account.self_id}</span>
                </button>
              ))}
            </div>
          )}

          <div className="section-heading">
            <span className="heading-accent">{sectionLabel}</span>
          </div>

          {categoryTabs.length > 1 && (
            <div className="category-tabs">
              {categoryTabs.map((tab, idx) => (
                <button
                  key={tab.key}
                  className={`category-tab ${idx === safeIdx ? 'active' : ''}`}
                  onClick={() => setActiveCategoryIdx(idx)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}

          {activeSection === 'framework' && errors && errors.length > 0 && (
            <div className="config-section" style={{ borderColor: 'rgba(229, 57, 53, 0.2)' }}>
              <div className="section-title" style={{ color: 'var(--error)' }}>
                配置校验警告
              </div>
              <div className="section-desc">
                {errors.map((item, index) => (
                  <div key={index} style={{ color: 'var(--warning)', marginBottom: 3 }}>
                    {item.path?.join('.') || '?'}: {item.message}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="content-area">
            {activeSection === 'monitor' && (
              <SystemMonitor
                staticInfo={staticInfo}
                dynamicInfo={dynamicInfo}
                botInfo={botInfo}
                loading={systemLoading}
              />
            )}

            {activeSection === 'framework' && currentTab && config && schema && (
              <ConfigForm
                config={config}
                schema={schema}
                onSave={handleSave}
                saving={saving}
                activeTab={currentTab}
              />
            )}

            {activeSection === 'account' && (
              currentAccountConfig && accountSchema && accountTab ? (
                <ConfigForm
                  config={currentAccountConfig}
                  schema={accountSchema}
                  onSave={handleAccountSave}
                  saving={saving}
                  activeTab={accountTab}
                  scopeSelfId={selectedPluginSelfId}
                />
              ) : (
                <div className="loading-container" style={{ minHeight: 120 }}>
                  <div className="spinner"></div>
                </div>
              )
            )}

            {isPluginSection && !canEditCurrentScope && (
              <div className="empty-state">
                当前账号不在线，暂时无法编辑该账号作用域的配置。
              </div>
            )}

            {isPluginSection && currentTab && canEditCurrentScope && (
              <PluginConfigPanel
                pluginName={activeSection}
                modules={currentTab.modules || []}
                schemas={pluginSchemas[activeSection] || {}}
                configs={currentPluginConfigs}
                saving={saving}
                onSave={handlePluginSave}
                scopeSelfId={selectedPluginSelfId}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

export default App;
