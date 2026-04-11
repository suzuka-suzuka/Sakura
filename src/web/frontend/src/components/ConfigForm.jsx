import { useState, useEffect, useCallback } from 'react';
import ConfigField from './ConfigField';

export default function ConfigForm({
    config,
    schema,
    onSave,
    saving,
    activeTab,
    scopeSelfId = null,
}) {
    const [draft, setDraft] = useState(config);

    useEffect(() => {
        setDraft(config);
    }, [config]);

    const handleChange = useCallback((path, value) => {
        setDraft((prev) => {
            const next = structuredClone(prev);
            setNestedValue(next, path, value);
            return next;
        });
    }, []);

    const handleSubmit = (event) => {
        event.preventDefault();
        onSave(draft);
    };

    const hasChanges = JSON.stringify(draft) !== JSON.stringify(config);

    if (!schema?.children || !activeTab) {
        return null;
    }

    const renderRootFieldSection = () => {
        if (!activeTab.fields) return null;

        return (
            <div className="config-section">
                <div className="section-title">
                    {activeTab.title || activeTab.label || '配置'}
                </div>
                {activeTab.description && (
                    <div className="section-desc">{activeTab.description}</div>
                )}
                {activeTab.fields.map(({ key, meta }) => (
                    <ConfigField
                        key={key}
                        name={key}
                        meta={meta}
                        value={draft?.[key]}
                        onChange={(value) => handleChange(key, value)}
                        scopeSelfId={scopeSelfId}
                    />
                ))}
            </div>
        );
    };

    const renderObjectSection = () => {
        if (!activeTab.isObject || !activeTab.meta) return null;

        const { key, meta } = activeTab;
        return (
            <div className="config-section">
                <div className="section-title">
                    {activeTab.title || meta.label || meta.description || key}
                </div>
                {activeTab.description ? (
                    <div className="section-desc">{activeTab.description}</div>
                ) : meta.help ? (
                    <div className="section-desc">{meta.help}</div>
                ) : null}
                {meta.children && Object.entries(meta.children).map(([childKey, childMeta]) => {
                    if (childMeta.type === 'object' && childMeta.children) {
                        return (
                            <div key={childKey} className="nested-section">
                                <div
                                    className="field-label"
                                    style={{
                                        marginBottom: 12,
                                        fontSize: 14,
                                        fontWeight: 600,
                                        color: 'var(--text-primary)',
                                    }}
                                >
                                    {childMeta.label || childMeta.description || childKey}
                                </div>
                                {Object.entries(childMeta.children).map(([subKey, subMeta]) => (
                                    <ConfigField
                                        key={subKey}
                                        name={subKey}
                                        meta={subMeta}
                                        value={draft?.[key]?.[childKey]?.[subKey]}
                                        onChange={(value) => handleChange(`${key}.${childKey}.${subKey}`, value)}
                                        scopeSelfId={scopeSelfId}
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
                            scopeSelfId={scopeSelfId}
                        />
                    );
                })}
            </div>
        );
    };

    const renderContent = () => {
        if (activeTab.isAccount || activeTab.isTop) {
            return renderRootFieldSection();
        }

        if (activeTab.isObject) {
            return renderObjectSection();
        }

        return null;
    };

    return (
        <form onSubmit={handleSubmit}>
            {renderContent()}

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
    for (let i = 0; i < keys.length - 1; i += 1) {
        if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
            current[keys[i]] = {};
        }
        current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
}
