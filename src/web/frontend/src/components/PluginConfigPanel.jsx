import { useState, useEffect, useCallback, useMemo } from 'react';
import ConfigField from './ConfigField';

/**
 * 递归渲染 schema 字段
 */
function RenderFields({ schema, data, pathPrefix, onChange }) {
    if (!schema) return null;

    return Object.entries(schema).map(([key, meta]) => {
        const fullPath = pathPrefix ? `${pathPrefix}.${key}` : key;

        if (meta.type === 'object' && meta.children) {
            const displayName = meta.label || meta.description || key;
            return (
                <div key={key} className="nested-section">
                    <div className="field-label" style={{
                        marginBottom: 10,
                        fontSize: 13,
                        fontWeight: 600,
                        color: 'var(--text-primary)'
                    }}>
                        {displayName}
                    </div>
                    {meta.help && <div className="field-help" style={{ marginTop: -6, marginBottom: 10 }}>{meta.help}</div>}
                    <RenderFields
                        schema={meta.children}
                        data={data?.[key]}
                        pathPrefix={fullPath}
                        onChange={onChange}
                    />
                </div>
            );
        }

        return (
            <ConfigField
                key={key}
                name={key}
                meta={meta}
                value={data?.[key]}
                onChange={(value) => onChange(fullPath, value)}
            />
        );
    });
}

/**
 * 插件配置面板 — 渲染当前分类下的所有模块表单
 * 浮动保存按钮：按当前分类批量保存所有有变更的模块
 */
export default function PluginConfigPanel({
    pluginName,
    modules,
    schemas,
    configs,
    saving,
    onSave,
}) {
    const [drafts, setDrafts] = useState({});

    useEffect(() => {
        if (configs) {
            setDrafts(prev => {
                const next = { ...prev };
                for (const mod of modules) {
                    if (configs[mod] && JSON.stringify(prev[mod]) !== JSON.stringify(configs[mod])) {
                        next[mod] = structuredClone(configs[mod]);
                    }
                }
                return next;
            });
        }
    }, [configs, modules]);

    const handleChange = useCallback((moduleName, path, value) => {
        setDrafts(prev => {
            const next = { ...prev };
            next[moduleName] = structuredClone(prev[moduleName] || {});
            setNestedValue(next[moduleName], path, value);
            return next;
        });
    }, []);

    // 检查当前分类下是否有任何模块有变更
    const changedModules = useMemo(() => {
        return modules.filter(mod => {
            const draft = drafts[mod];
            const currentConfig = configs[mod];
            return draft && JSON.stringify(draft) !== JSON.stringify(currentConfig);
        });
    }, [modules, drafts, configs]);

    const hasAnyChanges = changedModules.length > 0;

    // 批量保存当前分类下所有有变更的模块
    const [batchSaving, setBatchSaving] = useState(false);
    const handleBatchSave = useCallback(async () => {
        if (changedModules.length === 0) return;
        setBatchSaving(true);
        for (const mod of changedModules) {
            await onSave(pluginName, mod, drafts[mod]);
        }
        setBatchSaving(false);
    }, [changedModules, onSave, pluginName, drafts]);

    if (!modules || modules.length === 0) {
        return (
            <div className="empty-state">
                该分类下暂无配置模块
            </div>
        );
    }

    return (
        <div className="plugin-modules">
            {modules.map(mod => {
                const currentSchema = schemas[mod];
                const draft = drafts[mod];

                if (!currentSchema || !draft) {
                    return (
                        <div key={mod} className="config-section">
                            <div className="section-title">{mod}</div>
                            <div className="empty-state" style={{ height: 60 }}>加载中...</div>
                        </div>
                    );
                }

                // Use schema label/description as the display title
                const displayTitle = currentSchema.label || currentSchema.description || mod;

                return (
                    <div key={mod} className="config-section">
                        <div className="section-title">
                            {displayTitle}
                        </div>
                        {currentSchema.help && (
                            <div className="section-desc">{currentSchema.help}</div>
                        )}

                        {currentSchema.children ? (
                            <RenderFields
                                schema={currentSchema.children}
                                data={draft}
                                pathPrefix=""
                                onChange={(path, value) => handleChange(mod, path, value)}
                            />
                        ) : (
                            <div className="field-group">
                                <label className="field-label">配置内容（JSON）</label>
                                <textarea
                                    className="field-input field-textarea"
                                    style={{ minHeight: 160, fontFamily: 'monospace' }}
                                    value={JSON.stringify(draft, null, 2)}
                                    onChange={(e) => {
                                        try {
                                            setDrafts(prev => ({
                                                ...prev,
                                                [mod]: JSON.parse(e.target.value),
                                            }));
                                        } catch { /* ignore */ }
                                    }}
                                />
                            </div>
                        )}
                    </div>
                );
            })}

            {/* 浮动保存按钮 */}
            <div className="save-bar">
                <button
                    type="button"
                    className="btn btn-primary btn-save"
                    disabled={saving || batchSaving || !hasAnyChanges}
                    style={{ opacity: hasAnyChanges ? 1 : 0.4 }}
                    onClick={handleBatchSave}
                >
                    {batchSaving || saving ? '保存中...' : hasAnyChanges ? `💾 保存配置 (${changedModules.length})` : '无变更'}
                </button>
            </div>
        </div>
    );
}

function setNestedValue(obj, path, value) {
    const keys = path.split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
            current[keys[i]] = {};
        }
        current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
}
