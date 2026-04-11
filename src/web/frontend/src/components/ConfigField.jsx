import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';

function normalizeScopeSelfId(scopeSelfId) {
    if (scopeSelfId == null) return null;
    const num = Number(scopeSelfId);
    return Number.isFinite(num) && num > 0 ? num : null;
}

function buildScopedUrl(basePath, scopeSelfId) {
    const normalizedSelfId = normalizeScopeSelfId(scopeSelfId);
    if (normalizedSelfId == null) {
        return basePath;
    }

    const separator = basePath.includes('?') ? '&' : '?';
    return `${basePath}${separator}selfId=${normalizedSelfId}`;
}

/**
 * 单个配置字段渲染器
 * 根据 schema 元数据中的 type 自动选择对应的输入控件
 *
 * meta 可能包含: { type, description, label, help, default, step?, min?, max?, hideSpinner?, items?, children?, uiType? }
 */
export default function ConfigField({ name, meta, value, onChange, scopeSelfId = null }) {
    const { type, description, options, label, help, uiType } = meta;

    // 显示名称: 优先 label > description > name
    const displayName = label || description || name;

    // 指令消耗配置 → CommandCostField
    if (uiType === 'commandCost') {
        return (
            <CommandCostField
                name={name}
                displayName={displayName}
                help={help}
                value={value}
                onChange={onChange}
            />
        );
    }

    // Boolean → Toggle
    if (type === 'boolean') {
        return (
            <div className="field-group">
                <div className="toggle-wrapper">
                    <label className="field-label">
                        {displayName}
                        <span className="field-type-badge">{name}</span>
                    </label>
                    <button
                        type="button"
                        className={`toggle ${value ? 'active' : ''}`}
                        onClick={() => onChange(!value)}
                    >
                        <span className="toggle-knob" />
                    </button>
                </div>
                {help && <div className="field-help">{help}</div>}
            </div>
        );
    }

    // Enum → Select
    if (type === 'enum' && options) {
        return (
            <div className="field-group">
                <label className="field-label">
                    {displayName}
                    <span className="field-type-badge">{name}</span>
                </label>
                {help && <div className="field-help">{help}</div>}
                <select
                    className="field-input"
                    value={value ?? ''}
                    onChange={(e) => onChange(e.target.value)}
                >
                    {options.map(opt => (
                        <option key={opt} value={opt}>{opt}</option>
                    ))}
                </select>
            </div>
        );
    }

    // Array
    if (type === 'array') {
        // Array of objects → ObjectArrayField
        if (meta.items?.type === 'object' && meta.items?.children) {
            return (
                <ObjectArrayField
                    name={name}
                    displayName={displayName}
                    help={help}
                    value={value}
                    onChange={onChange}
                    itemMeta={meta.items}
                    fixed={meta.fixed}
                    nameField={meta.nameField}
                    scopeSelfId={scopeSelfId}
                />
            );
        }
        // Group select array → GroupSelectField
        if (uiType === 'groupSelect' || meta.items?.uiType === 'groupSelect') {
            return (
                <GroupSelectField
                    name={name}
                    displayName={displayName}
                    help={help}
                    value={value}
                    onChange={onChange}
                    scopeSelfId={scopeSelfId}
                />
            );
        }
        // Dynamic select array (roleSelectArray, channelSelectArray, etc.)
        if (uiType && uiType.endsWith('Array')) {
            return (
                <DynamicSelectArrayField
                    name={name}
                    displayName={displayName}
                    help={help}
                    value={value}
                    onChange={onChange}
                    uiType={uiType}
                    scopeSelfId={scopeSelfId}
                />
            );
        }
        // Simple array → Tag Input
        return (
            <ArrayField
                name={name}
                displayName={displayName}
                help={help}
                value={value}
                onChange={onChange}
                itemType={meta.items?.type || 'string'}
            />
        );
    }

    // Number
    if (type === 'number') {
        // Single group select → SingleGroupSelectField
        if (uiType === 'groupSelect') {
            return (
                <SingleGroupSelectField
                    name={name}
                    displayName={displayName}
                    help={help}
                    value={value}
                    onChange={onChange}
                    scopeSelfId={scopeSelfId}
                />
            );
        }

        const hasStep = meta.step != null;
        const hideSpinner = meta.hideSpinner || !hasStep;

        return (
            <div className="field-group">
                <label className="field-label">
                    {displayName}
                    <span className="field-type-badge">{name}</span>
                    {meta.min != null && meta.max != null && (
                        <span className="field-type-badge">{meta.min} ~ {meta.max}</span>
                    )}
                </label>
                {help && <div className="field-help">{help}</div>}
                <input
                    type={hideSpinner ? 'text' : 'number'}
                    inputMode="numeric"
                    className="field-input"
                    value={value ?? ''}
                    step={meta.step || undefined}
                    min={meta.min ?? undefined}
                    max={meta.max ?? undefined}
                    onChange={(e) => {
                        const v = e.target.value;
                        if (v === '' || v === '-') {
                            onChange(v === '' ? 0 : v);
                            return;
                        }
                        const num = Number(v);
                        if (!isNaN(num)) {
                            let clamped = num;
                            if (meta.min != null && clamped < meta.min) clamped = meta.min;
                            if (meta.max != null && clamped > meta.max) clamped = meta.max;
                            onChange(clamped);
                        }
                    }}
                />
            </div>
        );
    }

    // String with #textarea uiType → Textarea
    if ((type === 'string' || !type) && uiType === 'textarea') {
        return (
            <div className="field-group">
                <label className="field-label">
                    {displayName}
                    <span className="field-type-badge">{name}</span>
                </label>
                {help && <div className="field-help">{help}</div>}
                <textarea
                    className="field-input field-textarea"
                    value={value ?? ''}
                    onChange={(e) => onChange(e.target.value)}
                />
            </div>
        );
    }

    // Cron expression editor
    if ((type === 'string' || !type) && uiType === 'cron') {
        return (
            <CronField
                name={name}
                displayName={displayName}
                help={help}
                value={value}
                onChange={onChange}
            />
        );
    }

    // Dynamic select fields (roleSelect, channelSelect, etc.)
    // 检查 uiType 是否在动态选项配置中（不以 Array 结尾的单选类型）
    if ((type === 'string' || !type) && uiType && !uiType.endsWith('Array')) {
        // 可能是动态选择类型，让 DynamicSelectField 去判断
        return (
                <DynamicSelectField
                    name={name}
                    displayName={displayName}
                    help={help}
                    value={value}
                    onChange={onChange}
                    uiType={uiType}
                    scopeSelfId={scopeSelfId}
                />
        );
    }

    // String / Union / Default
    const isPassword = name.toLowerCase().includes('password');

    return (
        <div className="field-group">
            <label className="field-label">
                {displayName}
                <span className="field-type-badge">{name}</span>
            </label>
            {help && <div className="field-help">{help}</div>}
            {isPassword ? (
                <PasswordField
                    value={value}
                    onChange={onChange}
                />
            ) : (
                <input
                    type="text"
                    className="field-input"
                    value={value ?? ''}
                    onChange={(e) => {
                        const v = e.target.value;
                        // Union (number|string): 如果能转为数字就转
                        if (type === 'number|string' || type === 'string|number') {
                            const num = Number(v);
                            onChange(!isNaN(num) && v.trim() !== '' ? num : v);
                        } else {
                            onChange(v);
                        }
                    }}
                />
            )}
        </div>
    );
}

function PasswordField({ value, onChange }) {
    const [show, setShow] = useState(false);

    return (
        <div style={{ position: 'relative' }}>
            <input
                type={show ? 'text' : 'password'}
                className="field-input"
                style={{ paddingRight: 40 }}
                value={value ?? ''}
                onChange={(e) => onChange(e.target.value)}
            />
            <button
                type="button"
                onClick={() => setShow(!show)}
                style={{
                    position: 'absolute',
                    right: 10,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 16,
                    opacity: 0.6,
                    padding: 4,
                    display: 'flex',
                    alignItems: 'center',
                    color: 'var(--text-secondary)'
                }}
                title={show ? '隐藏密码' : '显示密码'}
            >
                {show ? '👁️' : '🔒'}
            </button>
        </div>
    );
}

/**
 * 数组字段渲染器 - Tag 式添加/删除（基本类型数组）
 */
function ArrayField({ name, displayName, help, value, onChange, itemType }) {
    const [inputValue, setInputValue] = useState('');
    const inputRef = useRef(null);
    const items = Array.isArray(value) ? value : [];

    const addItem = () => {
        const trimmed = inputValue.trim();
        if (!trimmed) return;

        let newValue = trimmed;
        if (itemType === 'number') {
            newValue = Number(trimmed);
            if (isNaN(newValue)) return;
        }

        if (!items.includes(newValue)) {
            onChange([...items, newValue]);
        }
        setInputValue('');
    };

    const removeItem = (index) => {
        onChange(items.filter((_, i) => i !== index));
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addItem();
        }
        if (e.key === 'Backspace' && inputValue === '' && items.length > 0) {
            removeItem(items.length - 1);
        }
    };

    return (
        <div className="field-group">
            <label className="field-label">
                {displayName}
                <span className="field-type-badge">{name}</span>
                <span className="field-type-badge">{items.length} 项</span>
            </label>
            {help && <div className="field-help">{help}</div>}
            <div className="array-field" onClick={() => inputRef.current?.focus()}>
                {items.map((item, index) => (
                    <span key={index} className="array-tag">
                        {String(item)}
                        <button
                            type="button"
                            className="array-tag-remove"
                            onClick={(e) => { e.stopPropagation(); removeItem(index); }}
                        >
                            ×
                        </button>
                    </span>
                ))}
                <input
                    ref={inputRef}
                    type="text"
                    inputMode={itemType === 'number' ? 'numeric' : 'text'}
                    className="array-input"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onBlur={addItem}
                />
            </div>
        </div>
    );
}

/**
 * 群号选择字段 — 弹窗多选 bot 已加入的群，标签显示群名
 */
function GroupSelectField({ name, displayName, help, value, onChange, scopeSelfId = null }) {
    const [showModal, setShowModal] = useState(false);
    const [groupMap, setGroupMap] = useState(new Map());
    const items = Array.isArray(value) ? value : [];

    // 获取群列表，建立 群号→群名 映射
    useEffect(() => {
        const token = localStorage.getItem('sakura_token');
        fetch(buildScopedUrl('/api/bot/groups', scopeSelfId), {
            headers: { Authorization: `Bearer ${token}` },
        })
            .then(r => r.json())
            .then(d => {
                if (d.success && d.data) {
                    const map = new Map();
                    d.data.forEach(g => map.set(g.group_id, g.group_name || String(g.group_id)));
                    setGroupMap(map);
                }
            })
            .catch(() => { });
    }, [scopeSelfId]);

    const removeItem = (index) => {
        onChange(items.filter((_, i) => i !== index));
    };

    const getDisplayName = (groupId) => {
        return groupMap.get(Number(groupId)) || String(groupId);
    };

    return (
        <div className="field-group">
            <label className="field-label">
                {displayName}
                <span className="field-type-badge">{name}</span>
                <span className="field-type-badge">{items.length} 项</span>
            </label>
            {help && <div className="field-help">{help}</div>}
            <div className="array-field group-select-field">
                {items.map((item, index) => (
                    <span key={index} className="array-tag" title={String(item)}>
                        {getDisplayName(item)}
                        <button
                            type="button"
                            className="array-tag-remove"
                            onClick={(e) => { e.stopPropagation(); removeItem(index); }}
                        >
                            ×
                        </button>
                    </span>
                ))}
                <button
                    type="button"
                    className="btn btn-secondary group-select-btn"
                    onClick={() => setShowModal(true)}
                >
                    + 选择群
                </button>
            </div>
            {showModal && (
                <GroupSelectModal
                    selected={items}
                    onConfirm={(selected) => { onChange(selected); setShowModal(false); }}
                    onCancel={() => setShowModal(false)}
                    scopeSelfId={scopeSelfId}
                />
            )}
        </div>
    );
}

/**
 * 群选择弹窗 — 从 bot 群列表中多选
 */
function GroupSelectModal({ selected, onConfirm, onCancel, scopeSelfId = null }) {
    const [groups, setGroups] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [search, setSearch] = useState('');
    const [checked, setChecked] = useState(new Set(selected.map(Number)));

    useEffect(() => {
        const token = localStorage.getItem('sakura_token');
        fetch(buildScopedUrl('/api/bot/groups', scopeSelfId), {
            headers: { Authorization: `Bearer ${token}` },
        })
            .then(r => r.json())
            .then(d => {
                if (d.success) {
                    setGroups(d.data || []);
                } else {
                    setError(d.error || '获取群列表失败');
                }
            })
            .catch(e => setError('请求失败: ' + e.message))
            .finally(() => setLoading(false));
    }, [scopeSelfId]);

    const filtered = groups.filter(g => {
        if (!search) return true;
        return String(g.group_id).includes(search) || (g.group_name || '').includes(search);
    });

    const toggleGroup = (groupId) => {
        setChecked(prev => {
            const next = new Set(prev);
            if (next.has(groupId)) {
                next.delete(groupId);
            } else {
                next.add(groupId);
            }
            return next;
        });
    };

    const toggleAll = () => {
        const allFilteredIds = filtered.map(g => g.group_id);
        const allChecked = allFilteredIds.every(id => checked.has(id));
        setChecked(prev => {
            const next = new Set(prev);
            if (allChecked) {
                allFilteredIds.forEach(id => next.delete(id));
            } else {
                allFilteredIds.forEach(id => next.add(id));
            }
            return next;
        });
    };

    const handleConfirm = () => {
        onConfirm([...checked]);
    };

    return createPortal(
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
            <div className="modal-card group-select-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <span className="modal-title">选择群 ({checked.size} 已选)</span>
                    <button className="modal-close" onClick={onCancel}>✕</button>
                </div>
                <div className="group-select-search">
                    <input
                        type="text"
                        className="field-input"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="搜索群号或群名..."
                    />
                </div>
                <div className="modal-body group-select-list">
                    {loading && <div className="empty-state" style={{ height: 80 }}>加载中...</div>}
                    {error && <div className="empty-state" style={{ height: 80, color: 'var(--error)' }}>{error}</div>}
                    {!loading && !error && filtered.length === 0 && (
                        <div className="empty-state" style={{ height: 80 }}>无匹配的群</div>
                    )}
                    {!loading && !error && filtered.length > 0 && (
                        <>
                            <label className="group-select-item group-select-all" onClick={toggleAll}>
                                <input
                                    type="checkbox"
                                    checked={filtered.length > 0 && filtered.every(g => checked.has(g.group_id))}
                                    readOnly
                                />
                                <span className="group-select-info">
                                    <span className="group-select-name">全选 / 取消全选</span>
                                </span>
                            </label>
                            {filtered.map(g => (
                                <div key={g.group_id} className="group-select-item" onClick={() => toggleGroup(g.group_id)} style={{ cursor: 'pointer' }}>
                                    <input
                                        type="checkbox"
                                        checked={checked.has(g.group_id)}
                                        readOnly
                                    />
                                    <span className="group-select-info">
                                        <span className="group-select-name">{g.group_name}</span>
                                        <span className="group-select-id">
                                            {g.group_id}
                                            {Array.isArray(g.bots) && g.bots.length > 1 ? ` · ${g.bots.length} 个账号` : ''}
                                        </span>
                                    </span>
                                </div>
                            ))}
                        </>
                    )}
                </div>
                <div className="modal-footer">
                    <button type="button" className="btn btn-secondary" onClick={onCancel}>取消</button>
                    <button type="button" className="btn btn-primary" onClick={handleConfirm}>确定 ({checked.size})</button>
                </div>
            </div>
        </div>,
        document.body
    );
}

/**
 * 单选群号字段 — 下拉选择 bot 已加入的单个群
 */
function SingleGroupSelectField({ name, displayName, help, value, onChange, scopeSelfId = null }) {
    const [groups, setGroups] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const token = localStorage.getItem('sakura_token');
        fetch(buildScopedUrl('/api/bot/groups', scopeSelfId), {
            headers: { Authorization: `Bearer ${token}` },
        })
            .then(r => r.json())
            .then(d => {
                if (d.success && d.data) {
                    setGroups(d.data || []);
                }
            })
            .catch(() => { })
            .finally(() => setLoading(false));
    }, [scopeSelfId]);

    const currentGroup = groups.find(g => g.group_id === Number(value));
    const displayValue = currentGroup 
        ? `${currentGroup.group_name} (${currentGroup.group_id})`
        : (value ? String(value) : '');

    return (
        <div className="field-group">
            <label className="field-label">
                {displayName}
                <span className="field-type-badge">{name}</span>
            </label>
            {help && <div className="field-help">{help}</div>}
            {loading ? (
                <div className="field-input" style={{ color: 'var(--text-secondary)' }}>加载中...</div>
            ) : (
                <select
                    className="field-input"
                    value={value ?? 0}
                    onChange={(e) => onChange(Number(e.target.value))}
                >
                    <option value={0}>请选择群...</option>
                    {groups.map(g => (
                        <option key={g.group_id} value={g.group_id}>
                            {g.group_name} ({g.group_id})
                        </option>
                    ))}
                </select>
            )}
        </div>
    );
}

/**
 * 对象数组字段渲染器 - 列表 + 弹窗添加/编辑
 * 点击项目打开编辑弹窗，不再使用展开模式
 * fixed: 是否为固定长度数组（不能添加/删除）
 * nameField: 指定用于显示标题的字段名
 */
function ObjectArrayField({ name, displayName, help, value, onChange, itemMeta, fixed, nameField, scopeSelfId = null }) {
    const [showAddModal, setShowAddModal] = useState(false);
    const [editIndex, setEditIndex] = useState(-1);
    const items = Array.isArray(value) ? value : [];

    const removeItem = (index) => {
        onChange(items.filter((_, i) => i !== index));
        if (editIndex === index) setEditIndex(-1);
    };

    const handleAddItem = (newItem) => {
        onChange([...items, newItem]);
        setShowAddModal(false);
    };

    const handleEditItem = (updatedItem) => {
        const updated = structuredClone(items);
        updated[editIndex] = updatedItem;
        onChange(updated);
        setEditIndex(-1);
    };

    // 为每个 item 生成摘要标签
    const getItemSummary = (item, index) => {
        // 优先使用指定的 nameField
        if (nameField && item[nameField] !== undefined && item[nameField] !== '') {
            return `${item[nameField]}`;
        }
        // 回退到默认字段
        const defaultNameFields = ['name', 'cmd', 'trigger', 'prefix', 'group'];
        for (const f of defaultNameFields) {
            if (item[f] !== undefined && item[f] !== '') {
                return `${item[f]}`;
            }
        }
        return <span className="array-item-number">{index + 1}</span>;
    };

    return (
        <div className="field-group">
            <label className="field-label">
                {displayName}
                <span className="field-type-badge">{name}</span>
                <span className="field-type-badge">{items.length} 项</span>
                {fixed && <span className="field-type-badge" title="固定数组，不能添加/删除">🔒</span>}
            </label>
            {help && <div className="field-help">{help}</div>}

            <div className="object-array-container">
                {items.map((item, index) => (
                    <div key={index} className="object-array-item">
                        <div
                            className="object-array-header"
                            onClick={() => setEditIndex(index)}
                        >
                            <span className="object-array-toggle">✏️</span>
                            <span className="object-array-summary">
                                {getItemSummary(item, index)}
                            </span>
                            {!fixed && (
                                <button
                                    type="button"
                                    className="object-array-remove"
                                    onClick={(e) => { e.stopPropagation(); removeItem(index); }}
                                    title="删除"
                                >
                                    ✕
                                </button>
                            )}
                        </div>
                    </div>
                ))}

                {!fixed && (
                    <button
                        type="button"
                        className="btn btn-secondary object-array-add"
                        onClick={() => setShowAddModal(true)}
                    >
                        + 添加
                    </button>
                )}
            </div>

            {/* Add Modal - 仅在非固定数组时显示 */}
            {!fixed && showAddModal && (
                <AddObjectModal
                    title={`添加 ${displayName}`}
                    itemMeta={itemMeta}
                    nextIndex={items.length}
                    onConfirm={handleAddItem}
                    onCancel={() => setShowAddModal(false)}
                    scopeSelfId={scopeSelfId}
                />
            )}

            {/* Edit Modal */}
            {editIndex >= 0 && editIndex < items.length && (
                <EditObjectModal
                    title={
                        <>
                            编辑 {displayName}{' '}
                            <span className="modal-item-number">
                                {nameField && items[editIndex][nameField]
                                    ? items[editIndex][nameField]
                                    : editIndex + 1}
                            </span>
                        </>
                    }
                    itemMeta={itemMeta}
                    initialData={items[editIndex]}
                    onConfirm={handleEditItem}
                    onCancel={() => setEditIndex(-1)}
                    readOnlyFields={fixed && nameField ? [nameField] : []}
                    scopeSelfId={scopeSelfId}
                />
            )}
        </div>
    );
}

/**
 * 添加对象的弹窗表单
 * 所有字段初始为空，不填充默认值
 */
function AddObjectModal({ title, itemMeta, nextIndex = 0, onConfirm, onCancel, scopeSelfId = null }) {
    const buildDefaultValue = useCallback((meta, key = '') => {
        if (meta?.default !== undefined) {
            if (
                key === 'name' &&
                typeof meta.default === 'string' &&
                /\d+$/.test(meta.default)
            ) {
                return meta.default.replace(/\d+$/, String(nextIndex + 1));
            }
            return structuredClone(meta.default);
        }
        if (meta?.type === 'boolean') return false;
        if (meta?.type === 'number') return 0;
        if (meta?.type === 'array') return [];
        if (meta?.type === 'object') {
            const obj = {};
            if (meta.children) {
                for (const [childKey, childMeta] of Object.entries(meta.children)) {
                    obj[childKey] = buildDefaultValue(childMeta, childKey);
                }
            }
            return obj;
        }
        return '';
    }, [scopeSelfId]);

    const buildEmptyItem = useCallback(() => {
        const item = {};
        if (itemMeta.children) {
            for (const [key, childMeta] of Object.entries(itemMeta.children)) {
                item[key] = buildDefaultValue(childMeta, key);
            }
        }
        return item;
    }, [buildDefaultValue, itemMeta]);

    const [draft, setDraft] = useState(() => buildEmptyItem());

    const handleFieldChange = useCallback((key, val) => {
        setDraft(prev => ({ ...prev, [key]: val }));
    }, []);

    const handleSubmit = (e) => {
        e.preventDefault();
        e.stopPropagation();
        onConfirm(draft);
    };

    return createPortal(
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <span className="modal-title">{title}</span>
                    <button className="modal-close" onClick={onCancel}>✕</button>
                </div>
                <form onSubmit={handleSubmit}>
                    <div className="modal-body">
                        {itemMeta.children && Object.entries(itemMeta.children).map(([childKey, childMeta]) => (
                            <ConfigField
                                key={childKey}
                                name={childKey}
                                meta={childMeta}
                                value={draft[childKey]}
                                onChange={(val) => handleFieldChange(childKey, val)}
                                scopeSelfId={scopeSelfId}
                            />
                        ))}
                    </div>
                    <div className="modal-footer">
                        <button type="button" className="btn btn-secondary" onClick={onCancel}>
                            取消
                        </button>
                        <button type="submit" className="btn btn-primary">
                            确定添加
                        </button>
                    </div>
                </form>
            </div>
        </div>,
        document.body
    );
}

/**
 * 编辑对象的弹窗表单
 * 所有字段预填充当前值
 * readOnlyFields: 只读字段列表（固定数组中的标识字段）
 */
function EditObjectModal({ title, itemMeta, initialData, onConfirm, onCancel, readOnlyFields = [], scopeSelfId = null }) {
    const [draft, setDraft] = useState(() => structuredClone(initialData));

    const handleFieldChange = useCallback((key, val) => {
        setDraft(prev => ({ ...prev, [key]: val }));
    }, []);

    const handleSubmit = (e) => {
        e.preventDefault();
        e.stopPropagation();
        onConfirm(draft);
    };

    return createPortal(
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <span className="modal-title">{title}</span>
                    <button className="modal-close" onClick={onCancel}>✕</button>
                </div>
                <form onSubmit={handleSubmit}>
                    <div className="modal-body">
                        {itemMeta.children && Object.entries(itemMeta.children).map(([childKey, childMeta]) => {
                            const isReadOnly = readOnlyFields.includes(childKey);
                            if (isReadOnly) {
                                // 只读字段显示为禁用状态
                                return (
                                    <div key={childKey} className="field-group">
                                        <label className="field-label">
                                            {childMeta.label || childMeta.description || childKey}
                                            <span className="field-type-badge">{childKey}</span>
                                            <span className="field-type-badge" title="此字段不可编辑">🔒</span>
                                        </label>
                                        <input
                                            type="text"
                                            className="field-input"
                                            value={draft[childKey] ?? ''}
                                            disabled
                                            style={{ opacity: 0.6, cursor: 'not-allowed' }}
                                        />
                                    </div>
                                );
                            }
                            return (
                                <ConfigField
                                    key={childKey}
                                    name={childKey}
                                    meta={childMeta}
                                    value={draft[childKey]}
                                    onChange={(val) => handleFieldChange(childKey, val)}
                                    scopeSelfId={scopeSelfId}
                                />
                            );
                        })}
                    </div>
                    <div className="modal-footer">
                        <button type="button" className="btn btn-secondary" onClick={onCancel}>
                            取消
                        </button>
                        <button type="submit" className="btn btn-primary">
                            确定保存
                        </button>
                    </div>
                </form>
            </div>
        </div>,
        document.body
    );
}

/**
 * 动态选择字段 — 从 API 获取选项列表
 * uiType: 动态选项类型标识（如 roleSelect, channelSelect）
 */
function DynamicSelectField({ name, displayName, help, value, onChange, uiType, scopeSelfId = null }) {
    const [options, setOptions] = useState([]);
    const [configLabel, setConfigLabel] = useState('');
    const [loading, setLoading] = useState(true);
    const [isDynamic, setIsDynamic] = useState(true);

    useEffect(() => {
        const token = localStorage.getItem('sakura_token');
        fetch(buildScopedUrl('/api/dynamic-options', scopeSelfId), {
            headers: { Authorization: `Bearer ${token}` },
        })
            .then(r => r.json())
            .then(d => {
                if (d.success && d.data) {
                    const config = d.data.config?.[uiType];
                    if (config) {
                        setOptions(d.data.options?.[uiType] || []);
                        setConfigLabel(config.label || '');
                        setIsDynamic(true);
                    } else {
                        // 不是动态类型，标记为非动态
                        setIsDynamic(false);
                    }
                }
            })
            .catch(() => { setIsDynamic(false); })
            .finally(() => setLoading(false));
    }, [scopeSelfId, uiType]);

    // 如果不是动态类型，回退到普通文本输入
    if (!loading && !isDynamic) {
        return (
            <div className="field-group">
                <label className="field-label">
                    {displayName}
                    <span className="field-type-badge">{name}</span>
                </label>
                {help && <div className="field-help">{help}</div>}
                <input
                    type="text"
                    className="field-input"
                    value={value ?? ''}
                    onChange={(e) => onChange(e.target.value)}
                />
            </div>
        );
    }

    // 确保当前值在选项中，如果不在则添加
    const allOptions = options.includes(value) || !value ? options : [value, ...options];

    return (
        <div className="field-group">
            <label className="field-label">
                {displayName}
                <span className="field-type-badge">{name}</span>
            </label>
            {help && <div className="field-help">{help}</div>}
            {loading ? (
                <div className="field-input" style={{ color: 'var(--text-secondary)' }}>加载中...</div>
            ) : (
                <select
                    className="field-input"
                    value={value ?? ''}
                    onChange={(e) => onChange(e.target.value)}
                >
                    <option value="">请选择{configLabel}...</option>
                    {allOptions.map(opt => (
                        <option key={opt} value={opt}>{opt}</option>
                    ))}
                </select>
            )}
        </div>
    );
}

/**
 * 动态多选数组字段 — 从 API 获取选项列表，弹窗多选
 * uiType: 动态选项类型标识（如 roleSelectArray, channelSelectArray）
 */
function DynamicSelectArrayField({ name, displayName, help, value, onChange, uiType, scopeSelfId = null }) {
    const [showModal, setShowModal] = useState(false);
    const [options, setOptions] = useState([]);
    const [configLabel, setConfigLabel] = useState('');
    const items = Array.isArray(value) ? value : [];

    useEffect(() => {
        const token = localStorage.getItem('sakura_token');
        fetch(buildScopedUrl('/api/dynamic-options', scopeSelfId), {
            headers: { Authorization: `Bearer ${token}` },
        })
            .then(r => r.json())
            .then(d => {
                if (d.success && d.data) {
                    const config = d.data.config?.[uiType];
                    if (config) {
                        setOptions(d.data.options?.[uiType] || []);
                        setConfigLabel(config.label || '');
                    }
                }
            })
            .catch(() => { });
    }, [scopeSelfId, uiType]);

    const removeItem = (index) => {
        onChange(items.filter((_, i) => i !== index));
    };

    return (
        <div className="field-group">
            <label className="field-label">
                {displayName}
                <span className="field-type-badge">{name}</span>
                <span className="field-type-badge">{items.length} 项</span>
            </label>
            {help && <div className="field-help">{help}</div>}
            <div className="array-field group-select-field">
                {items.map((item, index) => (
                    <span key={index} className="array-tag">
                        {String(item)}
                        <button
                            type="button"
                            className="array-tag-remove"
                            onClick={(e) => { e.stopPropagation(); removeItem(index); }}
                        >
                            ×
                        </button>
                    </span>
                ))}
                <button
                    type="button"
                    className="btn btn-secondary group-select-btn"
                    onClick={() => setShowModal(true)}
                >
                    + 选择{configLabel}
                </button>
            </div>
            {showModal && (
                <DynamicSelectModal
                    title={`选择${configLabel}`}
                    options={options}
                    selected={items}
                    onConfirm={(selected) => { onChange(selected); setShowModal(false); }}
                    onCancel={() => setShowModal(false)}
                />
            )}
        </div>
    );
}

/**
 * 动态选择弹窗 — 多选模式
 */
function DynamicSelectModal({ title, options, selected, onConfirm, onCancel }) {
    const [search, setSearch] = useState('');
    const [checked, setChecked] = useState(new Set(selected));

    const filtered = options.filter(opt => {
        if (!search) return true;
        return opt.toLowerCase().includes(search.toLowerCase());
    });

    const toggleOption = (opt) => {
        setChecked(prev => {
            const next = new Set(prev);
            if (next.has(opt)) {
                next.delete(opt);
            } else {
                next.add(opt);
            }
            return next;
        });
    };

    const toggleAll = () => {
        const allChecked = filtered.every(opt => checked.has(opt));
        setChecked(prev => {
            const next = new Set(prev);
            if (allChecked) {
                filtered.forEach(opt => next.delete(opt));
            } else {
                filtered.forEach(opt => next.add(opt));
            }
            return next;
        });
    };

    const handleConfirm = () => {
        onConfirm([...checked]);
    };

    return createPortal(
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
            <div className="modal-card group-select-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <span className="modal-title">{title} ({checked.size} 已选)</span>
                    <button className="modal-close" onClick={onCancel}>✕</button>
                </div>
                <div className="group-select-search">
                    <input
                        type="text"
                        className="field-input"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="搜索..."
                    />
                </div>
                <div className="modal-body group-select-list">
                    {filtered.length === 0 && (
                        <div className="empty-state" style={{ height: 80 }}>无匹配项</div>
                    )}
                    {filtered.length > 0 && (
                        <>
                            <label className="group-select-item group-select-all" onClick={toggleAll}>
                                <input
                                    type="checkbox"
                                    checked={filtered.length > 0 && filtered.every(opt => checked.has(opt))}
                                    readOnly
                                />
                                <span className="group-select-info">
                                    <span className="group-select-name">全选 / 取消全选</span>
                                </span>
                            </label>
                            {filtered.map(opt => (
                                <div key={opt} className="group-select-item" onClick={() => toggleOption(opt)} style={{ cursor: 'pointer' }}>
                                    <input
                                        type="checkbox"
                                        checked={checked.has(opt)}
                                        readOnly
                                    />
                                    <span className="group-select-info">
                                        <span className="group-select-name">{opt}</span>
                                    </span>
                                </div>
                            ))}
                        </>
                    )}
                </div>
                <div className="modal-footer">
                    <button type="button" className="btn btn-secondary" onClick={onCancel}>取消</button>
                    <button type="button" className="btn btn-primary" onClick={handleConfirm}>确定 ({checked.size})</button>
                </div>
            </div>
        </div>,
        document.body
    );
}

/**
 * 指令消耗配置字段 — 直接罗列所有已定义的指令中文名，每行两个，后面可填数字
 */
function CommandCostField({ name, displayName, help, value, onChange }) {
    const [commandNames, setCommandNames] = useState({});
    const [loading, setLoading] = useState(true);

    // 从 API 获取指令映射表
    useEffect(() => {
        const token = localStorage.getItem('sakura_token');
        fetch('/api/command-names', {
            headers: { Authorization: `Bearer ${token}` },
        })
            .then(r => r.json())
            .then(d => {
                if (d.success && d.data) {
                    setCommandNames(d.data);
                }
            })
            .catch(() => { })
            .finally(() => setLoading(false));
    }, []);

    // 将 value 数组转换为 Map 便于查找
    const costMap = new Map();
    if (Array.isArray(value)) {
        value.forEach(item => {
            if (item.command) {
                costMap.set(item.command, item.cost || 0);
            }
        });
    }

    // 处理单个指令消耗变更
    const handleCostChange = useCallback((commandDisplayName, newCost) => {
        const currentValue = Array.isArray(value) ? [...value] : [];
        const existingIndex = currentValue.findIndex(item => item.command === commandDisplayName);

        const costNum = parseInt(newCost, 10) || 0;

        if (existingIndex >= 0) {
            if (costNum > 0) {
                currentValue[existingIndex] = { command: commandDisplayName, cost: costNum };
            } else {
                // 如果消耗为 0，从数组中移除
                currentValue.splice(existingIndex, 1);
            }
        } else if (costNum > 0) {
            currentValue.push({ command: commandDisplayName, cost: costNum });
        }

        onChange(currentValue);
    }, [value, onChange]);

    // 获取所有指令的中文显示名列表（后端已经返回数组）
    const commandList = Array.isArray(commandNames) ? commandNames : Object.values(commandNames);

    if (loading) {
        return (
            <div className="field-group">
                <label className="field-label">
                    {displayName}
                    <span className="field-type-badge">{name}</span>
                </label>
                {help && <div className="field-help">{help}</div>}
                <div className="field-input" style={{ color: 'var(--text-secondary)' }}>加载中...</div>
            </div>
        );
    }

    if (commandList.length === 0) {
        return (
            <div className="field-group">
                <label className="field-label">
                    {displayName}
                    <span className="field-type-badge">{name}</span>
                </label>
                {help && <div className="field-help">{help}</div>}
                <div className="empty-state" style={{ padding: '12px', fontSize: '13px' }}>
                    暂无已定义的指令消耗配置
                </div>
            </div>
        );
    }

    // 将指令列表分成三列显示
    const rows = [];
    for (let i = 0; i < commandList.length; i += 3) {
        rows.push(commandList.slice(i, i + 3));
    }

    return (
        <div className="field-group">
            <label className="field-label">
                {displayName}
                <span className="field-type-badge">{name}</span>
                <span className="field-type-badge">{value?.length || 0} 项已配置</span>
            </label>
            {help && <div className="field-help">{help}</div>}
            <div className="command-cost-grid">
                {rows.map((row, rowIndex) => (
                    <div key={rowIndex} className="command-cost-row">
                        {row.map(cmdName => (
                            <div key={cmdName} className="command-cost-item">
                                <span className="command-cost-label">{cmdName}：</span>
                                <input
                                    type="number"
                                    className="command-cost-input"
                                    min="0"
                                    placeholder="0"
                                    value={costMap.get(cmdName) || ''}
                                    onChange={(e) => handleCostChange(cmdName, e.target.value)}
                                />
                            </div>
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}

/**
 * Cron 表达式可视化编辑器
 * 支持 5 段标准格式（分 时 日 月 周）
 */
function CronField({ name, displayName, help, value, onChange }) {
    const cronValue = value || '0 * * * *';
    const parts = cronValue.trim().split(/\s+/);

    const fieldDefs = [
        { key: 'minute', label: '分', placeholder: '*', allowed: '0-59' },
        { key: 'hour', label: '时', placeholder: '*', allowed: '0-23' },
        { key: 'dom', label: '日', placeholder: '*', allowed: '1-31' },
        { key: 'month', label: '月', placeholder: '*', allowed: '1-12' },
        { key: 'dow', label: '周', placeholder: '*', allowed: '0-7' },
    ];

    const segments = {
        minute: parts[0] || '*',
        hour: parts[1] || '*',
        dom: parts[2] || '*',
        month: parts[3] || '*',
        dow: parts[4] || '*'
    };

    const updateSegment = (key, val) => {
        const updated = { ...segments, [key]: val || '*' };
        const expr = `${updated.minute} ${updated.hour} ${updated.dom} ${updated.month} ${updated.dow}`;
        onChange(expr);
    };

    // 简单的前端格式校验
    const isValidSegment = (val) => /^[\d*,\-\/]+$/.test(val);
    const allValid = Object.values(segments).every(isValidSegment) && parts.length === 5;

    // 生成人类可读描述
    const getReadable = () => {
        const { minute, hour, dom, month, dow } = segments;
        const descParts = [];

        // 周
        if (dow !== '*') {
            const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
            const dayNum = parseInt(dow);
            if (!isNaN(dayNum) && dayNum >= 0 && dayNum <= 7) {
                descParts.push(`每周${dayNames[dayNum === 7 ? 0 : dayNum]}`);
            } else {
                descParts.push(`周(${dow})`);
            }
        }

        // 月
        if (month !== '*') {
            const monthNum = parseInt(month);
            if (!isNaN(monthNum)) {
                descParts.push(`${monthNum}月`);
            } else {
                descParts.push(`月(${month})`);
            }
        }

        // 日
        if (dom !== '*') {
            const domNum = parseInt(dom);
            if (!isNaN(domNum)) {
                descParts.push(`${domNum}号`);
            } else {
                descParts.push(`日(${dom})`);
            }
        } else if (dow === '*' && month === '*') {
            descParts.push('每天');
        }

        // 时:分
        const timeParts = [];
        if (hour === '*') {
            timeParts.push('每小时');
        } else {
            const h = parseInt(hour);
            timeParts.push(!isNaN(h) ? `${h}点` : `时(${hour})`);
        }

        if (minute === '*') {
            if (hour !== '*') timeParts.push('每分钟');
            else timeParts.push('每分钟');
        } else {
            const m = parseInt(minute);
            timeParts.push(!isNaN(m) ? `${String(m).padStart(2, '0')}分` : `分(${minute})`);
        }

        descParts.push(timeParts.join(''));

        // 特殊情况处理
        if (minute.includes('/')) {
            const interval = minute.split('/')[1];
            return `每 ${interval} 分钟执行一次`;
        }
        if (hour.includes('/')) {
            const interval = hour.split('/')[1];
            return `每 ${interval} 小时执行一次`;
        }

        return descParts.join(' ') + ' 执行';
    };

    const presets = [
        { label: '每分钟', value: '* * * * *' },
        { label: '每小时', value: '0 * * * *' },
        { label: '每天 0:00', value: '0 0 * * *' },
        { label: '每天 8:00', value: '0 8 * * *' },
        { label: '每天 12:00', value: '0 12 * * *' },
        { label: '每天 15:00', value: '0 15 * * *' },
        { label: '每周日 11:00', value: '0 11 * * 0' },
        { label: '每月 1 号', value: '0 0 1 * *' },
    ];

    return (
        <div className="field-group">
            <label className="field-label">
                {displayName}
                <span className="field-type-badge">{name}</span>
            </label>
            {help && <div className="field-help">{help}</div>}

            {/* Raw input */}
            <input
                type="text"
                className={`field-input ${!allValid ? 'cron-input-error' : ''}`}
                value={value ?? ''}
                onChange={(e) => onChange(e.target.value)}
                placeholder="0 15 * * *"
            />

            {/* Human readable description */}
            {allValid && (
                <div className="cron-description">
                    ⏰ {getReadable()}
                </div>
            )}
            {!allValid && (
                <div className="cron-error">
                    ⚠️ 格式无效，请检查表达式
                </div>
            )}

            {/* Visual segment editors */}
            <div className="cron-segments">
                {fieldDefs.map((fd) => (
                    <div key={fd.key} className="cron-segment">
                        <span className="cron-segment-label">{fd.label}</span>
                        <input
                            type="text"
                            className={`cron-segment-input ${!isValidSegment(segments[fd.key]) ? 'cron-input-error' : ''}`}
                            value={segments[fd.key]}
                            placeholder={fd.placeholder}
                            onChange={(e) => updateSegment(fd.key, e.target.value)}
                            title={`${fd.label}: ${fd.allowed}, 支持 * , - /`}
                        />
                        <span className="cron-segment-range">{fd.allowed}</span>
                    </div>
                ))}
            </div>

            {/* Quick presets */}
            <div className="cron-presets">
                {presets.map((p) => (
                    <button
                        key={p.value}
                        type="button"
                        className={`cron-preset-btn ${value === p.value ? 'active' : ''}`}
                        onClick={() => onChange(p.value)}
                    >
                        {p.label}
                    </button>
                ))}
            </div>
        </div>
    );
}
