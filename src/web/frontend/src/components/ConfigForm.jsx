import { useState, useEffect, useCallback } from 'react';
import ConfigField from './ConfigField';

/**
 * Schema 驱动的配置表单
 * 支持 activeTab 来只显示某个 section
 */
export default function ConfigForm({ config, schema, onSave, saving, activeTab }) {
    const [draft, setDraft] = useState(config);

    useEffect(() => {
        setDraft(config);
    }, [config]);

    const handleChange = useCallback((path, value) => {
        setDraft(prev => {
            const next = structuredClone(prev);
            setNestedValue(next, path, value);
            return next;
        });
    }, []);

    const handleSubmit = (e) => {
        e.preventDefault();
        onSave(draft);
    };

    const hasChanges = JSON.stringify(draft) !== JSON.stringify(config);

    if (!schema?.children) return null;

    // Render based on activeTab
    const renderContent = () => {
        if (!activeTab) return null;

        // Top-level simple fields tab
        if (activeTab.isTop && activeTab.fields) {
            return (
                <div className="config-section">
                    <div className="section-title">
                        基本设置
                    </div>
                    <div className="section-desc">框架核心配置项</div>
                    {activeTab.fields.map(({ key, meta }) => (
                        <ConfigField
                            key={key}
                            name={key}
                            meta={meta}
                            value={draft?.[key]}
                            onChange={(value) => handleChange(key, value)}
                        />
                    ))}
                </div>
            );
        }

        // Object section tab
        if (activeTab.isObject && activeTab.meta) {
            const { key, meta } = { key: activeTab.key, meta: activeTab.meta };
            return (
                <div className="config-section">
                    <div className="section-title">
                        {meta.label || meta.description || key}
                    </div>
                    {meta.help ? (
                        <div className="section-desc">{meta.help}</div>
                    ) : meta.label ? (
                        <div className="section-desc">{key}</div>
                    ) : null}
                    {meta.children && Object.entries(meta.children).map(([childKey, childMeta]) => {
                        if (childMeta.type === 'object' && childMeta.children) {
                            return (
                                <div key={childKey} className="nested-section">
                                    <div className="field-label" style={{
                                        marginBottom: 12,
                                        fontSize: 14,
                                        fontWeight: 600,
                                        color: 'var(--text-primary)'
                                    }}>
                                        {childMeta.label || childMeta.description || childKey}
                                    </div>
                                    {Object.entries(childMeta.children).map(([subKey, subMeta]) => (
                                        <ConfigField
                                            key={subKey}
                                            name={subKey}
                                            meta={subMeta}
                                            value={draft?.[key]?.[childKey]?.[subKey]}
                                            onChange={(value) => handleChange(`${key}.${childKey}.${subKey}`, value)}
                                        />
                                    ))}
                                </div>
                            );
                        }
                        return (
                            <ConfigField
                                key={childKey}
                                name={childKey}
                                meta={childMeta}
                                value={draft?.[key]?.[childKey]}
                                onChange={(value) => handleChange(`${key}.${childKey}`, value)}
                            />
                        );
                    })}
                </div>
            );
        }

        return null;
    };

    return (
        <form onSubmit={handleSubmit}>
            {renderContent()}

            {/* Save button */}
            <div className="save-bar">
                <button
                    type="submit"
                    className="btn btn-primary btn-save"
                    disabled={saving || !hasChanges}
                    style={{ opacity: hasChanges ? 1 : 0.4 }}
                >
                    {saving ? '保存中...' : hasChanges ? '💾 保存配置' : '无变更'}
                </button>
            </div>
        </form>
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
