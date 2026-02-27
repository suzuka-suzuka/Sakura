import { useState, useCallback, useMemo } from 'react';
import { useConfig } from './hooks/useConfig';
import { useWebSocket } from './hooks/useWebSocket';
import { useSystemInfo } from './hooks/useSystemInfo';
import LoginPage from './components/LoginPage';
import ConfigForm from './components/ConfigForm';
import PluginConfigPanel from './components/PluginConfigPanel';
import SystemMonitor from './components/SystemMonitor';

function App() {
  const {
    config, schema, loading, saving, errors,
    isLoggedIn, token,
    login, logout,
    saveConfig,
    updateFromWs,
    plugins,
    pluginSchemas,
    pluginConfigs,
    pluginCategories,
    pluginMeta,
    savePluginConfig,
    updatePluginFromWs,
  } = useConfig();

  const [toasts, setToasts] = useState([]);
  const [activeSection, setActiveSection] = useState('monitor');
  const [activeCategoryIdx, setActiveCategoryIdx] = useState(0);

  const addToast = useCallback((message, type = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 3000);
  }, []);

  const onConfigChanged = useCallback((newConfig) => {
    updateFromWs(newConfig);
    addToast('配置已从文件同步更新', 'info');
  }, [updateFromWs, addToast]);

  const onPluginConfigChanged = useCallback((pluginName, moduleName, data) => {
    updatePluginFromWs(pluginName, moduleName, data);
    addToast(`${pluginName}/${moduleName} 已同步更新`, 'info');
  }, [updatePluginFromWs, addToast]);

  const { connected } = useWebSocket(
    isLoggedIn ? token : null,
    onConfigChanged,
    onPluginConfigChanged,
  );

  // 系统监控数据
  const {
    staticInfo,
    dynamicInfo,
    botInfo,
    networkSpeed,
    loading: systemLoading,
  } = useSystemInfo(token, isLoggedIn && activeSection === 'monitor');

  const handleSave = useCallback(async (newConfig) => {
    const result = await saveConfig(newConfig);
    if (result.success) {
      addToast('配置保存成功', 'success');
    } else {
      const msg = result.errors?.map(e => e.message).join(', ') || '保存失败';
      addToast(msg, 'error');
    }
  }, [saveConfig, addToast]);

  const handlePluginSave = useCallback(async (pluginName, moduleName, data) => {
    const result = await savePluginConfig(pluginName, moduleName, data);
    if (result.success) {
      addToast(`保存成功`, 'success');
    } else {
      const msg = result.errors?.map(e => e.message).join(', ') || '保存失败';
      addToast(msg, 'error');
    }
  }, [savePluginConfig, addToast]);

  // Build left nav items
  const pluginNames = Object.keys(plugins || {});
  const navItems = useMemo(() => [
    { key: 'monitor', label: '系统监控', icon: '📊' },
    { key: 'framework', label: '框架配置', icon: '🌸' },
    ...pluginNames.map(name => {
      const meta = pluginMeta?.[name];
      return {
        key: name,
        label: meta?.displayName || name,
        icon: meta?.icon || '📦',
      };
    }),
    { key: '__menu_editor__', label: '菜单编辑', icon: '📝' },
  ], [pluginNames, pluginMeta]);

  // Build category tabs for active section
  const categoryTabs = useMemo(() => {
    if (activeSection === 'monitor') {
      return []; // 监控页面不需要分类标签
    }

    if (activeSection === 'framework') {
      if (!schema?.children) return [];
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
        tabs.push({ key: '__top__', label: '基本设置', fields: topLevelFields, isTop: true });
      }
      for (const s of objectSections) {
        tabs.push({
          key: s.key,
          label: s.meta.label || s.meta.description || s.key,
          meta: s.meta,
          isObject: true,
        });
      }
      return tabs;
    }

    const cats = pluginCategories[activeSection];
    const mods = plugins[activeSection] || [];
    if (!cats) {
      return [{ key: '__all__', label: '全部配置', modules: mods }];
    }

    const categorizedModules = new Set();
    Object.values(cats).forEach(modList => {
      if (Array.isArray(modList)) modList.forEach(m => categorizedModules.add(m));
    });
    const uncategorized = mods.filter(m => !categorizedModules.has(m));

    const tabs = [];
    for (const [catName, catModules] of Object.entries(cats)) {
      const validModules = catModules.filter(m => mods.includes(m));
      if (validModules.length > 0) {
        tabs.push({ key: catName, label: catName, modules: validModules });
      }
    }
    if (uncategorized.length > 0) {
      tabs.push({ key: '__other__', label: '其他', modules: uncategorized });
    }
    return tabs;
  }, [activeSection, schema, pluginCategories, plugins]);

  const safeIdx = Math.min(activeCategoryIdx, Math.max(categoryTabs.length - 1, 0));
  const currentTab = categoryTabs[safeIdx] || null;

  const handleSectionChange = useCallback((key) => {
    setActiveSection(key);
    setActiveCategoryIdx(0);
  }, []);

  // 获取当前 section 的显示名和图标
  const currentNav = navItems.find(n => n.key === activeSection);
  const sectionLabel = currentNav?.label || activeSection;
  const sectionIcon = currentNav?.icon || '⚙️';

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
      {/* Toast */}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`}>
            {t.message}
          </div>
        ))}
      </div>

      {/* Main Layout: left nav + content */}
      <div className="app-layout">
        {/* Left Navigation */}
        <aside className="left-nav">
          <div className="left-nav-brand">
            <span className="left-nav-brand-icon">🌸</span>
            <span className="left-nav-brand-text">Sakura</span>
          </div>
          <div className="left-nav-divider"></div>

          <div className="left-nav-section">配置</div>
          {navItems.map(item => (
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

          {/* Bottom: status + logout */}
          <div className="left-nav-bottom">
            <div className="left-nav-status">
              <span className={`status-dot ${connected ? 'connected' : 'disconnected'}`}></span>
              <span className="left-nav-status-text">{connected ? '已连接' : '未连接'}</span>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={logout}>退出</button>
          </div>
        </aside>

        {/* Main content */}
        <main className="main-content">
          {/* Section Heading */}
          <div className="section-heading">
            <span className="heading-accent">{sectionLabel}</span>
          </div>

          {/* Category Tabs */}
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

          {/* Validation errors */}
          {activeSection === 'framework' && errors && errors.length > 0 && (
            <div className="config-section" style={{ borderColor: 'rgba(229, 57, 53, 0.2)' }}>
              <div className="section-title" style={{ color: 'var(--error)' }}>
                ⚠️ 配置验证警告
              </div>
              <div className="section-desc">
                {errors.map((e, i) => (
                  <div key={i} style={{ color: 'var(--warning)', marginBottom: 3 }}>
                    • {e.path?.join('.') || '?'}: {e.message}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Content */}
          <div className="content-area">
            {activeSection === 'monitor' && (
              <SystemMonitor
                staticInfo={staticInfo}
                dynamicInfo={dynamicInfo}
                botInfo={botInfo}
                networkSpeed={networkSpeed}
                loading={systemLoading}
              />
            )}

            {activeSection === 'framework' && config && schema && currentTab && (
              <ConfigForm
                config={config}
                schema={schema}
                onSave={handleSave}
                saving={saving}
                activeTab={currentTab}
              />
            )}

            {activeSection !== 'framework' && activeSection !== 'monitor' && currentTab && (
              <PluginConfigPanel
                pluginName={activeSection}
                modules={currentTab.modules || []}
                schemas={pluginSchemas[activeSection] || {}}
                configs={pluginConfigs[activeSection] || {}}
                saving={saving}
                onSave={handlePluginSave}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

export default App;
