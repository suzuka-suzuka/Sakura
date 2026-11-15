import { createContext, useContext, useState, useRef, useCallback, useEffect, useMemo, useId } from 'react';
import { createPortal } from 'react-dom';
import DraftInput from './DraftInput';
import Icon from './Icon';
import { readAuthToken } from '../utils/authStorage';
import { useDynamicOptions } from '../hooks/useDynamicOptions';
import { moveItem, useDragReorder } from '../hooks/useDragReorder';
import {
    fieldAnchorId,
    formatSummaryValue,
    groupFields,
    isFieldVisible,
    itemTitle,
    resetHiddenFields,
} from '../utils/schemaLayout';

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

function getAuthToken() {
    return readAuthToken({ touch: true });
}

/**
 * 说明气泡：标签旁的小问号，悬停或点按时显示说明，平时不占版面。
 */
export function HelpTip({ text }) {
    const [anchor, setAnchor] = useState(null);
    const tipId = useId();
    if (!text) return null;

    const show = (event) => setAnchor(event.currentTarget.getBoundingClientRect());
    const hide = () => setAnchor(null);

    let style = null;
    if (anchor) {
        // 气泡从问号左侧展开，靠近右边缘时整体左移，保证不超出窗口
        const maxWidth = Math.min(300, window.innerWidth - 24);
        const left = Math.max(12, Math.min(anchor.left - 10, window.innerWidth - maxWidth - 12));
        const below = anchor.top < 120;
        style = below
            ? { left, maxWidth, top: anchor.bottom + 8 }
            : { left, maxWidth, bottom: window.innerHeight - anchor.top + 8 };
    }

    return (
        <>
            <button
                type="button"
                className="help-tip"
                aria-label="说明"
                aria-describedby={anchor ? tipId : undefined}
                onMouseEnter={show}
                onMouseLeave={hide}
                onFocus={show}
                onBlur={hide}
                onClick={(event) => (anchor ? hide() : show(event))}
            >
                ?
            </button>
            {anchor && createPortal(
                <div id={tipId} role="tooltip" className="help-tip-bubble" style={style}>{text}</div>,
                document.body
            )}
        </>
    );
}

/**
 * 字段外壳：设置列表里的一行。说明收进标签旁的问号。
 * layout:
 *   switch：名称在左、开关在右
 *   inline：名称在左、控件在右，控件按 size 定宽（sm 数字 / md 文本和下拉 / auto 按内容）
 *   stack：名称在上、控件占满整行（长文本、各种列表）
 */
// 为 true 时字段只渲染控件（标签已经作为卡片标题显示）
const BareFieldContext = createContext(false);

export function FieldShell({ label, help, extra = null, layout = 'inline', size = 'md', children }) {
    const bare = useContext(BareFieldContext);
    if (bare) return <div className="field-bare">{children}</div>;
    const sized = layout === 'inline' ? ` setting-row--${size}` : '';
    return (
        <div className={`setting-row setting-row--${layout}${sized}`}>
            <div className="setting-label">
                <span className="setting-label-text">{label}</span>
                <HelpTip text={help} />
                {extra}
            </div>
            <div className="setting-control">{children}</div>
        </div>
    );
}

/** 选项少且短的枚举用分段选择 */
function isSegmented(meta) {
    return meta.type === 'enum' && Array.isArray(meta.options)
        && meta.options.length <= 4
        && meta.options.every((opt) => (meta.optionLabels?.[opt] || opt).length <= 8);
}

const MASTER_SWITCH_KEYS = ['enable', 'enabled'];

/**
 * 渲染一组字段：按 group 分卡片、处理 showIf / 协议过滤、把高级选项折叠起来。
 * value 是包含这些字段的对象，onChange(key, nextValue) 修改单个字段。
 * variant: page（页面卡片）| drawer（抽屉内，紧凑）
 */
export function FieldList({
    children,
    value,
    onFieldChange,
    scopeSelfId = null,
    context = {},
    variant = 'page',
    anchorScope = '',
    groupByCard = true,
}) {
    const groups = useMemo(
        () => (groupByCard ? groupFields(children) : [{ title: '', fields: Object.entries(children || {}) }]),
        [children, groupByCard]
    );

    return (
        <>
            {groups.map((group, index) => (
                <FieldGroup
                    key={group.title || `__group_${index}`}
                    title={group.title}
                    fields={group.fields}
                    value={value}
                    onFieldChange={onFieldChange}
                    scopeSelfId={scopeSelfId}
                    context={context}
                    variant={variant}
                    anchorScope={anchorScope}
                />
            ))}
        </>
    );
}

export function FieldGroup({ title, help = '', cardId, fields, value, onFieldChange, scopeSelfId, context, variant, anchorScope }) {
    const [showAdvanced, setShowAdvanced] = useState(false);
    const visible = fields.filter(([, meta]) => isFieldVisible(meta, value, context));
    const advanced = visible.filter(([, meta]) => meta.advanced);
    // 模块的总开关放到卡片标题右边，卡片里不再单独占一格
    const master = variant === 'page' && title
        ? visible.find(([key, meta]) => !meta.advanced && meta.type === 'boolean' && MASTER_SWITCH_KEYS.includes(key)) || null
        : null;
    const basic = visible.filter((field) => !field[1].advanced && field !== master);

    if (visible.length === 0) return null;

    const renderField = ([key, meta]) => {
        if (meta.type === 'object' && meta.children) {
            return (
                <div key={key} className="setting-subgroup field-anchor" id={anchorScope ? fieldAnchorId(anchorScope, key) : undefined}>
                    <div className="setting-subgroup-title">
                        {meta.label || meta.description || key}
                        <HelpTip text={meta.help} />
                    </div>
                    <FieldList
                        children={meta.children}
                        value={value?.[key] || {}}
                        onFieldChange={(childKey, childValue) => onFieldChange(key, { ...(value?.[key] || {}), [childKey]: childValue })}
                        scopeSelfId={scopeSelfId}
                        context={context}
                        variant="nested"
                        groupByCard={false}
                    />
                </div>
            );
        }
        return (
            <div key={key} className="field-anchor" id={anchorScope ? fieldAnchorId(anchorScope, key) : undefined}>
                <ConfigField
                    name={key}
                    meta={meta}
                    value={value?.[key]}
                    onChange={(next) => onFieldChange(key, next)}
                    scopeSelfId={scopeSelfId}
                    formValue={value}
                />
            </div>
        );
    };

    const body = (
        <>
            {basic.length > 0 && <div className="setting-list">{basic.map(renderField)}</div>}
            {advanced.length > 0 && (
                <>
                    <button
                        type="button"
                        className={`advanced-toggle ${showAdvanced ? 'open' : ''}`}
                        onClick={() => setShowAdvanced((open) => !open)}
                    >
                        <Icon name="chevronDown" size={15} />
                        {showAdvanced ? '收起高级选项' : `高级选项（${advanced.length}）`}
                    </button>
                    {showAdvanced && <div className="setting-list advanced-fields">{advanced.map(renderField)}</div>}
                </>
            )}
        </>
    );

    // 只有一个列表字段时，把字段标签提升为卡片标题，避免标题重复
    const sole = variant === 'page' && fields.length === 1 && visible.length === 1
        && visible[0][1].type === 'array' ? visible[0] : null;
    if (sole) {
        const [, soleMeta] = sole;
        const count = Array.isArray(value?.[sole[0]]) ? value[sole[0]].length : 0;
        return (
            <section className="card" id={cardId}>
                <header className="card-header">
                    <h3 className="card-title">
                        {title || soleMeta.label || soleMeta.description}
                        <HelpTip text={soleMeta.help || help} />
                    </h3>
                    {count > 0 && <span className="field-count">{count}</span>}
                </header>
                <div className="card-body card-body--bare">
                    <BareFieldContext.Provider value>
                        {renderField(sole)}
                    </BareFieldContext.Provider>
                </div>
            </section>
        );
    }

    if (variant !== 'page') {
        return (
            <div className="field-group-plain">
                {title && <div className="field-group-title">{title}</div>}
                {body}
            </div>
        );
    }

    return (
        <section className="card" id={cardId}>
            {title && (
                <header className="card-header">
                    <h3 className="card-title">{title}<HelpTip text={help} /></h3>
                    {master && (
                        <div className="card-switch field-anchor" id={anchorScope ? fieldAnchorId(anchorScope, master[0]) : undefined}>
                            <HelpTip text={master[1].help} />
                            <button
                                type="button"
                                role="switch"
                                aria-checked={Boolean(value?.[master[0]])}
                                aria-label={master[1].label || master[1].description || '启用'}
                                title={master[1].label || master[1].description || '启用'}
                                className={`toggle ${value?.[master[0]] ? 'active' : ''}`}
                                onClick={() => onFieldChange(master[0], !value?.[master[0]])}
                            >
                                <span className="toggle-knob" />
                            </button>
                        </div>
                    )}
                </header>
            )}
            {(basic.length > 0 || advanced.length > 0) && <div className="card-body">{body}</div>}
        </section>
    );
}

/**
 * 单个配置字段渲染器：根据 schema 元数据选择控件。
 */
export default function ConfigField({ name, meta, value, onChange, scopeSelfId = null, formValue = null }) {
    const { type, description, options, label, help, uiType } = meta;
    const displayName = label || description || name;

    if (uiType === 'commandCost') {
        return <CommandCostField name={name} displayName={displayName} help={help} value={value} onChange={onChange} />;
    }

    if (type === 'boolean') {
        return (
            <FieldShell label={displayName} help={help} layout="switch">
                <button
                    type="button"
                    role="switch"
                    aria-checked={Boolean(value)}
                    aria-label={displayName}
                    className={`toggle ${value ? 'active' : ''}`}
                    onClick={() => onChange(!value)}
                >
                    <span className="toggle-knob" />
                </button>
            </FieldShell>
        );
    }

    if (type === 'enum' && options) {
        if (isSegmented(meta)) {
            return (
                <FieldShell label={displayName} help={help} size="auto">
                    <div className="segmented" role="radiogroup" aria-label={displayName}>
                        {options.map((opt) => (
                            <button
                                key={opt}
                                type="button"
                                role="radio"
                                aria-checked={value === opt}
                                className={value === opt ? 'active' : ''}
                                onClick={() => onChange(opt)}
                            >
                                {meta.optionLabels?.[opt] || opt}
                            </button>
                        ))}
                    </div>
                </FieldShell>
            );
        }
        return (
            <FieldShell label={displayName} help={help}>
                <select className="field-input" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
                    {options.map((opt) => (
                        <option key={opt} value={opt}>{meta.optionLabels?.[opt] || opt}</option>
                    ))}
                </select>
            </FieldShell>
        );
    }

    if (type === 'array') {
        if (uiType?.startsWith('modelList')) {
            return (
                <ModelListField
                    displayName={displayName}
                    help={help}
                    value={value}
                    onChange={onChange}
                    uiType={uiType}
                    scopeSelfId={scopeSelfId}
                />
            );
        }
        if (uiType === 'secretList') {
            return <SecretListField displayName={displayName} help={help} value={value} onChange={onChange} />;
        }
        if (uiType === 'vertexCredentialList') {
            return <VertexCredentialListField displayName={displayName} help={help} value={value} onChange={onChange} />;
        }
        if (uiType === 'modelEntries' && meta.items?.type === 'object') {
            return (
                <ModelEntriesField
                    displayName={displayName}
                    help={help}
                    value={value}
                    onChange={onChange}
                    meta={meta}
                    scopeSelfId={scopeSelfId}
                />
            );
        }
        if (uiType === 'repeatRules' && meta.items?.type === 'object') {
            return (
                <RepeatRulesField
                    displayName={displayName}
                    help={help}
                    value={value}
                    onChange={onChange}
                    meta={meta}
                    scopeSelfId={scopeSelfId}
                />
            );
        }
        if (meta.items?.type === 'object' && meta.items?.children) {
            return (
                <ObjectArrayField
                    displayName={displayName}
                    help={help}
                    value={value}
                    onChange={onChange}
                    meta={meta}
                    scopeSelfId={scopeSelfId}
                />
            );
        }
        if (uiType === 'groupSelect' || meta.items?.uiType === 'groupSelect') {
            return <GroupSelectField name={name} displayName={displayName} help={help} value={value} onChange={onChange} scopeSelfId={scopeSelfId} />;
        }
        if (uiType === 'toolMultiSelect') {
            return <ToolMultiSelectField name={name} displayName={displayName} help={help} value={value} onChange={onChange} />;
        }
        if (uiType && uiType.endsWith('Array')) {
            return <DynamicSelectArrayField name={name} displayName={displayName} help={help} value={value} onChange={onChange} uiType={uiType} scopeSelfId={scopeSelfId} />;
        }
        return (
            <ArrayField
                name={name}
                displayName={displayName}
                help={help}
                value={value}
                onChange={onChange}
                itemType={meta.items?.type || 'string'}
                placeholder={meta.placeholder}
            />
        );
    }

    if (type === 'number') {
        if (uiType === 'groupSelect') {
            return <SingleGroupSelectField name={name} displayName={displayName} help={help} value={value} onChange={onChange} scopeSelfId={scopeSelfId} />;
        }

        const hasStep = meta.step != null;
        const hideSpinner = meta.hideSpinner || !hasStep;

        return (
            <FieldShell
                label={displayName}
                size="sm"
                help={meta.min != null && meta.max != null
                    ? [help, `取值范围 ${meta.min} ~ ${meta.max}`].filter(Boolean).join('\n')
                    : help}
            >
                <DraftInput
                    type={hideSpinner ? 'text' : 'number'}
                    inputMode="decimal"
                    className="field-input field-input--number"
                    value={value}
                    step={meta.step ?? 'any'}
                    min={meta.min ?? undefined}
                    max={meta.max ?? undefined}
                    placeholder={meta.placeholder || undefined}
                    parse={(text) => {
                        if (!text.trim() || !Number.isFinite(Number(text))) return undefined;
                        let number = Number(text);
                        if (meta.min != null) number = Math.max(meta.min, number);
                        if (meta.max != null) number = Math.min(meta.max, number);
                        return number;
                    }}
                    onChange={onChange}
                />
            </FieldShell>
        );
    }

    const isString = type === 'string' || !type;

    if (isString && uiType === 'serverDirectory') {
        return <ServerDirectoryField name={name} displayName={displayName} help={help} value={value} onChange={onChange} />;
    }

    if (isString && uiType === 'textarea') {
        return (
            <FieldShell label={displayName} help={help} layout="stack">
                <textarea
                    className="field-input field-textarea"
                    value={value ?? ''}
                    placeholder={meta.placeholder || undefined}
                    onChange={(e) => onChange(e.target.value)}
                />
            </FieldShell>
        );
    }

    if (isString && uiType === 'cron') {
        return <CronField name={name} displayName={displayName} help={help} value={value} onChange={onChange} />;
    }

    if (isString && uiType === 'modelSelect') {
        return (
            <ModelSelectField
                displayName={displayName}
                help={help}
                value={value}
                onChange={onChange}
                providerId={formValue?.provider || ''}
                scopeSelfId={scopeSelfId}
            />
        );
    }

    if (isString && uiType && !uiType.endsWith('Array')) {
        return <DynamicSelectField name={name} displayName={displayName} help={help} value={value} onChange={onChange} uiType={uiType} scopeSelfId={scopeSelfId} />;
    }

    const isSecret = /api.?key|password|token|secret/i.test(name);

    return (
        <FieldShell label={displayName} help={help}>
            {isSecret ? (
                <SecretInput value={value} onChange={onChange} placeholder={meta.placeholder || undefined} />
            ) : (
                <DraftInput
                    type="text"
                    className="field-input"
                    value={value}
                    placeholder={meta.placeholder || undefined}
                    parse={(text) => {
                        if (type === 'number|string' || type === 'string|number') {
                            const number = Number(text);
                            return text.trim() !== '' && Number.isFinite(number) ? number : text;
                        }
                        return text;
                    }}
                    onChange={onChange}
                />
            )}
        </FieldShell>
    );
}

// 用样式遮挡而不是 password 类型：浏览器不会往里自动填登录密码，也不会弹“保存密码”
const MASK_BY_STYLE = typeof CSS !== 'undefined' && Boolean(CSS.supports?.('-webkit-text-security', 'disc'));

/** 密钥输入框：平时显示成圆点，点进去才是明文，方便核对粘贴的内容。 */
function SecretInput({ value, onChange, onBlur, className = 'field-input', ...rest }) {
    const [focused, setFocused] = useState(false);
    return (
        <input
            {...rest}
            type={MASK_BY_STYLE || focused ? 'text' : 'password'}
            className={`${className} input-secret ${focused ? '' : 'is-masked'}`}
            value={value ?? ''}
            autoComplete="off"
            spellCheck={false}
            onFocus={() => setFocused(true)}
            onBlur={(event) => {
                setFocused(false);
                onBlur?.(event);
            }}
            onChange={(event) => onChange(event.target.value)}
        />
    );
}

function ServerDirectoryField({ displayName, help, value, onChange }) {
    const [showBrowser, setShowBrowser] = useState(false);

    return (
        <FieldShell label={displayName} help={help}>
            <div className="input-box">
                <input
                    type="text"
                    value={value ?? ''}
                    placeholder="例如 D:\\code\\Sakura"
                    onChange={(event) => onChange(event.target.value)}
                />
                <button
                    type="button"
                    className="input-box-btn"
                    title="浏览服务器目录"
                    aria-label="浏览服务器目录"
                    onClick={() => setShowBrowser(true)}
                >
                    <Icon name="folder" size={16} />
                </button>
            </div>
            {showBrowser && (
                <ServerDirectoryModal
                    initialPath={value}
                    onCancel={() => setShowBrowser(false)}
                    onConfirm={(selectedPath) => {
                        onChange(selectedPath);
                        setShowBrowser(false);
                    }}
                />
            )}
        </FieldShell>
    );
}

function ServerDirectoryModal({ initialPath, onCancel, onConfirm }) {
    const [currentPath, setCurrentPath] = useState('');
    const [pathInput, setPathInput] = useState(initialPath || '');
    const [parentPath, setParentPath] = useState(null);
    const [directories, setDirectories] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const loadDirectory = useCallback(async (requestedPath = '') => {
        setLoading(true);
        setError('');
        try {
            const query = requestedPath ? `?path=${encodeURIComponent(requestedPath)}` : '';
            const response = await fetch(`/api/system/directories${query}`, {
                headers: { Authorization: `Bearer ${getAuthToken()}` },
            });
            const payload = await response.json();
            if (!response.ok || !payload.success) {
                throw new Error(payload.error || '文件夹读取失败');
            }

            const data = payload.data || {};
            setCurrentPath(data.path || '');
            setPathInput(data.path || '');
            setParentPath(data.parent || null);
            setDirectories(Array.isArray(data.directories) ? data.directories : []);
        } catch (loadError) {
            setError(loadError.message || '文件夹读取失败');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            void loadDirectory(initialPath || '');
        }, 0);

        return () => window.clearTimeout(timer);
    }, [initialPath, loadDirectory]);

    useEffect(() => {
        const handleKeyDown = (event) => {
            // 下拉框会先处理 Esc 并 preventDefault，这时只关下拉、不关外层
            if (event.key === 'Escape' && !event.defaultPrevented) onCancel();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onCancel]);

    const openTypedPath = (event) => {
        event.preventDefault();
        loadDirectory(pathInput);
    };

    return createPortal(
        <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
            <div className="modal-card directory-browser-modal" onClick={(event) => event.stopPropagation()}>
                <div className="modal-header">
                    <span className="modal-title">选择服务器文件夹</span>
                    <button type="button" className="icon-btn" onClick={onCancel} aria-label="关闭"><Icon name="x" size={18} /></button>
                </div>
                <div className="modal-body directory-browser-body">
                    <form className="directory-browser-path" onSubmit={openTypedPath}>
                        <input
                            type="text"
                            className="field-input"
                            value={pathInput}
                            onChange={(event) => setPathInput(event.target.value)}
                            aria-label="服务器文件夹路径"
                        />
                        <button type="submit" className="btn btn-secondary" disabled={loading}>打开</button>
                    </form>
                    <div className="directory-browser-toolbar">
                        <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={!parentPath || loading}
                            onClick={() => loadDirectory(parentPath)}
                        >
                            返回上级
                        </button>
                        <span className="directory-browser-current" title={currentPath}>{currentPath}</span>
                    </div>
                    {error && <div className="directory-browser-error">{error}</div>}
                    <div className="directory-browser-list">
                        {loading && <div className="directory-browser-empty">读取中...</div>}
                        {!loading && directories.length === 0 && !error && (
                            <div className="directory-browser-empty">这里没有子文件夹</div>
                        )}
                        {!loading && directories.map((directory) => (
                            <button
                                type="button"
                                className="directory-browser-item"
                                key={directory.path}
                                onClick={() => loadDirectory(directory.path)}
                            >
                                <Icon name="folder" size={16} />
                                <span>{directory.name}</span>
                            </button>
                        ))}
                    </div>
                </div>
                <div className="modal-footer">
                    <button type="button" className="btn btn-secondary" onClick={onCancel}>取消</button>
                    <button
                        type="button"
                        className="btn btn-primary"
                        disabled={!currentPath || loading}
                        onClick={() => onConfirm(currentPath)}
                    >
                        选择此文件夹
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
}

/**
 * 数组字段渲染器 - Tag 式添加/删除（基本类型数组）
 */
function ArrayField({ displayName, help, value, onChange, itemType, placeholder }) {
    const [inputValue, setInputValue] = useState('');
    const inputRef = useRef(null);
    const items = Array.isArray(value) ? value : [];
    const numericItem = itemType === 'number' || itemType === 'number|string' || itemType === 'string|number';

    const addItem = () => {
        const trimmed = inputValue.trim();
        if (!trimmed) return;

        let newValue = trimmed;
        if (numericItem) {
            const number = Number(trimmed);
            if (Number.isFinite(number)) newValue = number;
            else if (itemType === 'number') return;
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
        <FieldShell label={displayName} help={help} layout="stack" extra={<><span className="field-count">{items.length}</span></>}>
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
                    inputMode={itemType === 'number' ? 'decimal' : 'text'}
                    className="array-input"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onBlur={addItem}
                    placeholder={items.length === 0 ? (placeholder || '输入后按回车添加') : ''}
                />
            </div>
        </FieldShell>
    );
}

/**
 * 群号选择字段 — 弹窗多选 bot 已加入的群，标签显示群名
 */
function GroupSelectField({ displayName, help, value, onChange, scopeSelfId = null }) {
    const [showModal, setShowModal] = useState(false);
    const [groupMap, setGroupMap] = useState(new Map());
    const items = Array.isArray(value) ? value : [];

    // 获取群列表，建立 群号→群名 映射
    useEffect(() => {
        const token = getAuthToken();
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
        <FieldShell layout="stack" label={displayName} help={help} extra={<><span className="field-count">{items.length}</span></>}>
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
        </FieldShell>
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
        const token = getAuthToken();
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
                    <button type="button" className="icon-btn" onClick={onCancel} aria-label="关闭"><Icon name="x" size={18} /></button>
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
function SingleGroupSelectField({ displayName, help, value, onChange, scopeSelfId = null }) {
    const [groups, setGroups] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const token = getAuthToken();
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

    return (
        <FieldShell label={displayName} help={help}>
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
        </FieldShell>
    );
}

function buildDefaultFieldValue(meta) {
    if (meta?.default !== undefined) return structuredClone(meta.default);
    if (meta?.type === 'boolean') return false;
    if (meta?.type === 'number') return 0;
    if (meta?.type === 'array') return [];
    if (meta?.type === 'object') {
        const obj = {};
        for (const [childKey, childMeta] of Object.entries(meta.children || {})) {
            obj[childKey] = buildDefaultFieldValue(childMeta);
        }
        return obj;
    }
    return '';
}

function buildEmptyObjectItem(itemMeta) {
    const item = {};
    for (const [key, childMeta] of Object.entries(itemMeta.children || {})) {
        item[key] = buildDefaultFieldValue(childMeta);
    }
    return item;
}

/**
 * 对象数组：一格一张小卡片（标题 + 摘要），点开在右侧抽屉里编辑。
 * getContext(item) 为抽屉里的字段提供额外上下文（例如所选供应商的协议）。
 * renderBadges(item) 在行尾附加状态标签。
 */
function ObjectArrayField({
    displayName,
    help,
    value,
    onChange,
    meta,
    scopeSelfId = null,
    getContext = null,
    renderBadges = null,
    emptyText = null,
    addLabel = '添加',
}) {
    const items = Array.isArray(value) ? value : [];
    const itemMeta = meta.items;
    const [editing, setEditing] = useState(null); // { index, draft } index=-1 表示新增
    const [confirmIndex, setConfirmIndex] = useState(-1);
    // 没配摘要字段时，用地址/端口这类最能区分各项的字段当摘要
    const summaryFields = meta.summary
        || ['url', 'baseURL', 'host', 'port'].filter((key) => itemMeta.children?.[key]).slice(0, 1);
    const fixed = meta.fixed === true;

    const openEditor = (index) => {
        setConfirmIndex(-1);
        setEditing({
            index,
            draft: index >= 0 ? structuredClone(items[index]) : buildEmptyObjectItem(itemMeta),
        });
    };

    const commit = (draft) => {
        const context = getContext?.(draft) || {};
        const cleaned = resetHiddenFields(itemMeta.children, draft, context);
        if (editing.index >= 0) {
            const next = [...items];
            next[editing.index] = cleaned;
            onChange(next);
        } else {
            onChange([...items, cleaned]);
        }
        setEditing(null);
    };

    const { listRef, rowProps, handleProps, dragging } = useDragReorder((from, to) => {
        setConfirmIndex(-1);
        onChange(moveItem(items, from, to));
    });

    const remove = (index) => {
        onChange(items.filter((_, i) => i !== index));
        setConfirmIndex(-1);
    };

    // 每项自带的启用开关（enabled / enable），直接在列表行上切换，不用点进去看
    const toggleKey = ['enabled', 'enable'].find((key) => itemMeta.children?.[key]?.type === 'boolean') || null;
    const toggleDefault = toggleKey ? itemMeta.children[toggleKey].default !== false : true;
    const isOn = (item) => (toggleKey ? (item?.[toggleKey] ?? toggleDefault) !== false : true);
    const setOn = (index, on) => {
        const next = [...items];
        next[index] = { ...items[index], [toggleKey]: on };
        onChange(next);
    };

    // 复制不常用，放在编辑抽屉里：把当前草稿作为新项插到原项后面
    const duplicate = (draft) => {
        const context = getContext?.(draft) || {};
        const cleaned = resetHiddenFields(itemMeta.children, draft, context);
        const at = editing.index + 1;
        onChange([...items.slice(0, at), cleaned, ...items.slice(at)]);
        setEditing(null);
    };


    return (
        <FieldShell label={displayName} help={help} layout="stack" extra={<span className="field-count">{items.length}</span>}>
            <div ref={listRef} className={`item-list ${dragging ? 'is-sorting' : ''}`}>
                {items.map((item, index) => {
                    const summaries = summaryFields
                        .map((field) => formatSummaryValue(itemMeta.children?.[field], item?.[field]))
                        .filter(Boolean);
                    const badges = renderBadges?.(item);
                    const disabled = !isOn(item);
                    const confirming = confirmIndex === index;
                    const name = itemTitle(item, index, meta.nameField);
                    return (
                        <div
                            key={index}
                            className={`item-row ${disabled ? 'is-disabled' : ''} ${confirming ? 'is-confirming' : ''}`}
                            onClick={() => { if (!confirming) openEditor(index); }}
                            {...rowProps(index)}
                        >
                            {!fixed && items.length > 1 && (
                                <button type="button" className="drag-handle" {...handleProps(index)}>
                                    <Icon name="grip" size={15} />
                                </button>
                            )}
                            {confirming ? (
                                <div className="item-row-confirm" onClick={(event) => event.stopPropagation()}>
                                    <span>删除“{name}”？</span>
                                    <button type="button" className="btn btn-danger btn-xs" onClick={() => remove(index)}>删除</button>
                                    <button type="button" className="btn btn-ghost btn-xs" onClick={() => setConfirmIndex(-1)}>取消</button>
                                </div>
                            ) : (
                                <>
                                    <button type="button" className="item-row-main" title={name}>
                                        <span className="item-row-title">{name}</span>
                                        {summaries.length > 0 && <span className="item-row-sub">{summaries.join(' · ')}</span>}
                                    </button>
                                    {badges && <span className="item-row-badges">{badges}</span>}
                                    <div className="item-row-tools" onClick={(event) => event.stopPropagation()}>
                                        {!fixed && (
                                            <button type="button" className="icon-btn icon-btn-danger item-row-delete" title="删除" aria-label="删除" onClick={() => setConfirmIndex(index)}>
                                                <Icon name="trash" size={14} />
                                            </button>
                                        )}
                                        {toggleKey && (
                                            <button
                                                type="button"
                                                role="switch"
                                                aria-checked={!disabled}
                                                aria-label={disabled ? '已停用，点击启用' : '已启用，点击停用'}
                                                title={disabled ? '已停用' : '已启用'}
                                                className={`toggle toggle-sm ${disabled ? '' : 'active'}`}
                                                onClick={() => setOn(index, disabled)}
                                            >
                                                <span className="toggle-knob" />
                                            </button>
                                        )}
                                    </div>
                                    <Icon name="chevronRight" size={16} className="item-row-chevron" />
                                </>
                            )}
                        </div>
                    );
                })}
                {items.length === 0 && <div className="item-list-empty">{emptyText || '还没有添加任何项'}</div>}
                {!fixed && (
                    <button type="button" className="item-row item-row-add" onClick={() => openEditor(-1)}>
                        <Icon name="plus" size={15} />
                        {addLabel}
                    </button>
                )}
            </div>

            {editing && (
                <ItemDrawer
                    title={editing.index >= 0
                        ? `编辑 · ${itemTitle(items[editing.index], editing.index, meta.nameField)}`
                        : `添加${displayName}`}
                    itemMeta={itemMeta}
                    initialDraft={editing.draft}
                    getContext={getContext}
                    submitLabel={editing.index >= 0 ? '完成' : '添加'}
                    onCancel={() => setEditing(null)}
                    onConfirm={commit}
                    onDuplicate={editing.index >= 0 && !fixed ? duplicate : null}
                    scopeSelfId={scopeSelfId}
                />
            )}
        </FieldShell>
    );
}

function ItemDrawer({ title, itemMeta, initialDraft, getContext, submitLabel, onCancel, onConfirm, onDuplicate, scopeSelfId }) {
    const [draft, setDraft] = useState(initialDraft);
    const context = getContext?.(draft) || {};
    const formRef = useRef(null);

    useEffect(() => {
        const handleKeyDown = (event) => {
            // 下拉框会先处理 Esc 并 preventDefault，这时只关下拉、不关外层
            if (event.key === 'Escape' && !event.defaultPrevented) onCancel();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onCancel]);

    useEffect(() => {
        const first = formRef.current?.querySelector('input, select, textarea');
        first?.focus({ preventScroll: true });
    }, []);

    const handleSubmit = (event) => {
        event.preventDefault();
        event.stopPropagation();
        onConfirm(draft);
    };

    return createPortal(
        <div className="drawer-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
            <form ref={formRef} className="drawer" onSubmit={handleSubmit} role="dialog" aria-modal="true" aria-label={String(title)}>
                <header className="drawer-header">
                    <h2 className="drawer-title">{title}</h2>
                    <button type="button" className="icon-btn" onClick={onCancel} aria-label="关闭">
                        <Icon name="x" size={18} />
                    </button>
                </header>
                <div className="drawer-body">
                    <BareFieldContext.Provider value={false}>
                        <FieldList
                            children={itemMeta.children}
                            value={draft}
                            onFieldChange={(key, next) => setDraft((prev) => ({ ...prev, [key]: next }))}
                            scopeSelfId={scopeSelfId}
                            context={context}
                            variant="drawer"
                        />
                    </BareFieldContext.Provider>
                </div>
                <footer className="drawer-footer">
                    {onDuplicate && (
                        <button type="button" className="btn btn-ghost drawer-footer-start" title="按当前填写的内容另存一份新的" onClick={() => onDuplicate(draft)}>
                            <Icon name="copy" size={15} />
                            另存为副本
                        </button>
                    )}
                    <button type="button" className="btn btn-ghost" onClick={onCancel}>取消</button>
                    <button type="submit" className="btn btn-primary">{submitLabel}</button>
                </footer>
            </form>
        </div>,
        document.body
    );
}

const REPEAT_TEXT_ACTIONS = new Set(['text', 'mute']);

function RepeatRulesField(props) {
    const getContext = useCallback(() => ({}), []);
    const meta = useMemo(() => {
        const children = props.meta.items.children;
        return {
            ...props.meta,
            items: {
                ...props.meta.items,
                children: {
                    ...children,
                    text: { ...children.text, showIf: [{ field: 'action', negate: false, values: [...REPEAT_TEXT_ACTIONS] }] },
                    muteDuration: { ...children.muteDuration, showIf: [{ field: 'action', negate: false, values: ['mute'] }] },
                },
            },
            summary: props.meta.summary || ['action', 'text'],
        };
    }, [props.meta]);
    return <ObjectArrayField {...props} meta={meta} getContext={getContext} />;
}

const MODEL_TYPE_LABELS = { chat: '对话', image: '图片', video: '视频' };

/** 模型列表：按所选供应商的协议显示对应的思考参数。 */
function ModelEntriesField(props) {
    const { details: providerDetails } = useDynamicOptions(props.scopeSelfId, 'providerSelect');
    const getContext = useCallback(
        (item) => ({ protocol: providerDetails?.[item?.provider]?.protocol || '' }),
        [providerDetails]
    );
    const renderBadges = useCallback((item) => (
        <>
            {item?.name && <span className="chip chip-outline">{item.model}</span>}
            {item?.nativeWebSearch && item?.type === 'chat' && <span className="chip chip-accent">联网</span>}
            {!providerDetails?.[item?.provider] && item?.provider && <span className="chip chip-warn">供应商不存在</span>}
        </>
    ), [providerDetails]);
    const meta = useMemo(() => ({
        ...props.meta,
        nameField: 'name',
        summary: ['provider', 'type'],
        items: {
            ...props.meta.items,
            children: {
                ...props.meta.items.children,
                type: { ...props.meta.items.children.type, optionLabels: { ...MODEL_TYPE_LABELS, ...(props.meta.items.children.type?.optionLabels || {}) } },
            },
        },
    }), [props.meta]);
    return (
        <ObjectArrayField
            {...props}
            meta={meta}
            getContext={getContext}
            renderBadges={renderBadges}
            addLabel="添加模型"
            emptyText="还没有模型。先在上面添加供应商，再点“添加模型”从它的模型列表里挑选。"
        />
    );
}

/**
 * 使用处的模型列表：有序、可调整顺序，排在前面的优先，失败时换下一个。
 * uiType 形如 modelList:chat 或 modelList:chat:gemini（只显示 Gemini 协议的模型），
 * modelList:chat:search 只显示开启了自带联网搜索的模型。
 */
function ModelListField({ displayName, help, value, onChange, uiType, scopeSelfId }) {
    const [, kind = 'chat', filter = ''] = uiType.split(':');
    const searchOnly = filter === 'search';
    const protocolFilter = searchOnly ? '' : filter;
    const items = Array.isArray(value) ? value : [];
    const { options, details, loading } = useDynamicOptions(scopeSelfId, 'modelEntrySelect');
    const { details: providerDetails } = useDynamicOptions(scopeSelfId, 'providerSelect');
    const [picking, setPicking] = useState(false);

    const candidates = options.filter((name) => {
        const info = details?.[name] || {};
        if ((info.type || 'chat') !== kind) return false;
        if (protocolFilter && providerDetails?.[info.provider]?.protocol !== protocolFilter) return false;
        if (searchOnly && info.nativeWebSearch !== true) return false;
        return true;
    });
    const available = candidates.filter((name) => !items.includes(name));

    const { listRef, rowProps, handleProps, dragging } = useDragReorder((from, to) => onChange(moveItem(items, from, to)));

    return (
        <FieldShell label={displayName} help={help} layout="stack">
            <div ref={listRef} className={`model-list ${dragging ? 'is-sorting' : ''}`}>
                {items.length === 0 && <div className="model-list-empty">未选择模型</div>}
                {items.map((name, index) => {
                    const info = details?.[name];
                    const missing = !loading && !info;
                    const wrongKind = info && (info.type || 'chat') !== kind;
                    const wrongProtocol = info && protocolFilter && providerDetails?.[info.provider]
                        && providerDetails[info.provider].protocol !== protocolFilter;
                    const noSearch = info && searchOnly && info.nativeWebSearch !== true;
                    return (
                        <div key={name} className={`model-pill ${missing || wrongKind || wrongProtocol || noSearch ? 'is-invalid' : ''}`} {...rowProps(index)}>
                            {items.length > 1 && (
                                <button type="button" className="drag-handle" {...handleProps(index)}>
                                    <Icon name="grip" size={15} />
                                </button>
                            )}
                            <span className="model-pill-order">{index + 1}</span>
                            <span className="model-pill-name">{name}</span>
                            {info?.provider && <span className="model-pill-provider">{info.provider}</span>}
                            {missing && <span className="chip chip-warn">模型不存在</span>}
                            {wrongKind && <span className="chip chip-warn">用途不符</span>}
                            {wrongProtocol && <span className="chip chip-warn">不是 {protocolFilter === 'gemini' ? 'Gemini' : protocolFilter} 供应商，会被跳过</span>}
                            {noSearch && <span className="chip chip-warn">未开启联网搜索，会被跳过</span>}
                            <span className="model-pill-actions">
                                <button type="button" className="icon-btn icon-btn-danger" aria-label="移除" title="移除" onClick={() => onChange(items.filter((item) => item !== name))}>
                                    <Icon name="x" size={14} />
                                </button>
                            </span>
                        </div>
                    );
                })}
                {picking ? (
                    <select
                        className="field-input"
                        autoFocus
                        value=""
                        onBlur={() => setPicking(false)}
                        onChange={(event) => {
                            if (event.target.value) onChange([...items, event.target.value]);
                            setPicking(false);
                        }}
                    >
                        <option value="">{available.length > 0 ? '选择要添加的模型…' : '没有更多可选的模型'}</option>
                        {available.map((name) => (
                            <option key={name} value={name}>
                                {name}{details?.[name]?.provider ? ` · ${details[name].provider}` : ''}
                            </option>
                        ))}
                    </select>
                ) : (
                    <button type="button" className="item-add item-add--compact" onClick={() => setPicking(true)} disabled={loading}>
                        <Icon name="plus" size={15} />
                        {loading ? '加载模型…' : candidates.length === 0 ? '还没有可选的模型，请先在“模型与供应商”里添加' : '添加模型'}
                    </button>
                )}
            </div>
        </FieldShell>
    );
}

/** API Key 列表：每个 Key 一行，默认隐藏。 */
function SecretListField({ displayName, help, value, onChange }) {
    const items = Array.isArray(value) ? value : [];
    const [draft, setDraft] = useState('');

    const add = () => {
        const text = draft.trim();
        if (!text || items.includes(text)) return;
        onChange([...items, text]);
        setDraft('');
    };

    return (
        <FieldShell label={displayName} help={help} layout="stack" extra={<span className="field-count">{items.length}</span>}>
            <div className="secret-list">
                {items.map((secret, index) => (
                    <div key={index} className="input-box">
                        <span className="input-box-prefix">{index + 1}</span>
                        <SecretInput
                            className=""
                            value={secret}
                            onChange={(text) => {
                                const next = [...items];
                                next[index] = text;
                                onChange(next);
                            }}
                        />
                        <button
                            type="button"
                            className="input-box-btn input-box-btn--danger"
                            title="删除"
                            aria-label="删除"
                            onClick={() => onChange(items.filter((_, i) => i !== index))}
                        >
                            <Icon name="trash" size={15} />
                        </button>
                    </div>
                ))}
                <div className="input-box">
                    <span className="input-box-prefix"><Icon name="key" size={14} /></span>
                    <SecretInput
                        className=""
                        value={draft}
                        placeholder="粘贴新的 Key，按回车添加"
                        onChange={setDraft}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                event.preventDefault();
                                add();
                            }
                        }}
                        onBlur={add}
                    />
                </div>
            </div>
        </FieldShell>
    );
}

function useVertexCredentials() {
    const [credentials, setCredentials] = useState([]);
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        try {
            const response = await fetch('/api/ai/vertex-credentials', {
                headers: { Authorization: `Bearer ${getAuthToken()}` },
            });
            const payload = await response.json();
            if (!response.ok || !payload.success) throw new Error(payload.error || '服务账号列表加载失败');
            setCredentials(Array.isArray(payload.data) ? payload.data : []);
        } catch (loadError) {
            setError(loadError.message || '服务账号列表加载失败');
        }
    }, []);

    useEffect(() => {
        const timer = window.setTimeout(() => { void load(); }, 0);
        return () => window.clearTimeout(timer);
    }, [load]);
    return { credentials, error, reload: load };
}

async function importVertexCredentialFile(file) {
    if (file.size > 64 * 1024) throw new Error('服务账号 JSON 不能超过 64 KB');
    let credential;
    try {
        credential = JSON.parse(await file.text());
    } catch {
        throw new Error('文件不是有效的 JSON');
    }
    const response = await fetch('/api/ai/vertex-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAuthToken()}` },
        body: JSON.stringify({ credential }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.error || '服务账号校验失败');
    return payload.data;
}

/** Vertex 服务账号列表：导入 JSON 后保存引用。 */
function VertexCredentialListField({ displayName, help, value, onChange }) {
    const items = Array.isArray(value) ? value : [];
    const { credentials, error: loadError, reload } = useVertexCredentials();
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState('');
    const [error, setError] = useState('');
    const fileInputRef = useRef(null);

    const describe = (reference) => {
        const found = credentials.find((item) => item.reference === reference);
        if (!found) return { text: `${reference}（未找到文件）`, invalid: true };
        if (found.validation === 'invalid' || !found.clientEmail) return { text: `${reference}（无效）`, invalid: true };
        return { text: `${found.projectId} / ${found.clientEmail}`, invalid: false };
    };

    const handleFile = async (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        setBusy(true);
        setError('');
        setStatus('正在校验凭据和 Vertex 权限…');
        try {
            const data = await importVertexCredentialFile(file);
            if (!items.includes(data.reference)) onChange([...items, data.reference]);
            setStatus(`验证通过：${data.projectId} / ${data.clientEmail}`);
            await reload();
        } catch (uploadError) {
            setStatus('');
            setError(uploadError.message || '服务账号导入失败');
        } finally {
            setBusy(false);
        }
    };

    const unused = credentials.filter((item) => !items.includes(item.reference) && item.validation !== 'invalid');

    return (
        <FieldShell label={displayName} help={help} layout="stack">
            <div className="secret-list">
                {items.map((reference) => {
                    const info = describe(reference);
                    return (
                        <div key={reference} className={`credential-row ${info.invalid ? 'is-invalid' : ''}`}>
                            <Icon name="key" size={15} />
                            <span className="credential-text">{info.text}</span>
                            <button type="button" className="icon-btn icon-btn-danger" aria-label="移除" onClick={() => onChange(items.filter((item) => item !== reference))}>
                                <Icon name="x" size={15} />
                            </button>
                        </div>
                    );
                })}
                <div className="credential-actions">
                    {unused.length > 0 && (
                        <select
                            className="field-input"
                            value=""
                            onChange={(event) => {
                                if (event.target.value) onChange([...items, event.target.value]);
                            }}
                        >
                            <option value="">选择已导入的服务账号…</option>
                            {unused.map((item) => (
                                <option key={item.reference} value={item.reference}>{item.projectId} / {item.clientEmail}</option>
                            ))}
                        </select>
                    )}
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => fileInputRef.current?.click()}>
                        <Icon name="upload" size={15} />
                        {busy ? '校验中…' : '导入 JSON'}
                    </button>
                    <input ref={fileInputRef} type="file" accept=".json,application/json" hidden onChange={handleFile} />
                </div>
                {status && <div className="field-note field-note--ok">{status}</div>}
                {(error || loadError) && <div className="field-note field-note--warn">{error || loadError}</div>}
            </div>
        </FieldShell>
    );
}

/**
 * 可输入的下拉框：点开时列出全部选项，输入后按关键字筛选，也允许填列表外的值。
 * 不用原生 datalist——它会按输入框里已有的值过滤，已经填了模型名时下拉几乎是空的。
 */
function Combobox({ value, options, onChange, disabled = false, loading = false, placeholder, emptyText = '没有匹配的选项', action = null }) {
    const inputRef = useRef(null);
    const listRef = useRef(null);
    const listId = useId();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState(''); // 空字符串表示刚打开，显示全部
    const [active, setActive] = useState(-1);
    const [box, setBox] = useState(null);

    const filtered = useMemo(() => {
        const keyword = query.trim().toLowerCase();
        return keyword ? options.filter((option) => option.toLowerCase().includes(keyword)) : options;
    }, [options, query]);

    const measure = useCallback(() => {
        const rect = inputRef.current?.getBoundingClientRect();
        if (rect) setBox({ left: rect.left, width: rect.width, top: rect.top, bottom: rect.bottom });
    }, []);

    // 打开期间每帧跟随输入框位置（滚动、窗口缩放、抽屉滑入动画都会让它移动）
    useEffect(() => {
        if (!open) return undefined;
        let frame = 0;
        const follow = () => {
            const rect = inputRef.current?.getBoundingClientRect();
            if (rect) {
                setBox((prev) => (prev && prev.left === rect.left && prev.top === rect.top && prev.width === rect.width
                    ? prev
                    : { left: rect.left, width: rect.width, top: rect.top, bottom: rect.bottom }));
            }
            frame = requestAnimationFrame(follow);
        };
        frame = requestAnimationFrame(follow);
        return () => cancelAnimationFrame(frame);
    }, [open]);

    useEffect(() => {
        if (open && active >= 0) listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
    }, [open, active]);

    const openList = () => {
        if (disabled) return;
        measure();
        setQuery('');
        setActive(options.indexOf(value));
        setOpen(true);
    };

    const close = () => {
        setOpen(false);
        setQuery('');
    };

    const choose = (option) => {
        onChange(option);
        close();
    };

    const handleKeyDown = (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) {
                openList();
                return;
            }
            if (filtered.length === 0) return;
            const step = event.key === 'ArrowDown' ? 1 : -1;
            setActive((current) => (current + step + filtered.length) % filtered.length);
        } else if (event.key === 'Enter' && open) {
            event.preventDefault();
            if (active >= 0 && filtered[active]) choose(filtered[active]);
            else close();
        } else if (event.key === 'Escape' && open) {
            // 只关下拉，不要连带关掉外面的抽屉
            event.preventDefault();
            event.stopPropagation();
            close();
        }
    };

    let popupStyle = null;
    if (open && box) {
        const below = window.innerHeight - box.bottom - 12;
        const above = box.top - 12;
        const placeAbove = below < 220 && above > below;
        popupStyle = placeAbove
            ? { left: box.left, width: box.width, bottom: window.innerHeight - box.top + 4, maxHeight: Math.min(300, above) }
            : { left: box.left, width: box.width, top: box.bottom + 4, maxHeight: Math.min(300, below) };
    }

    return (
        <div className={`combobox ${action ? 'has-action' : ''}`}>
            <input
                ref={inputRef}
                className="field-input"
                role="combobox"
                aria-expanded={open}
                aria-controls={listId}
                aria-autocomplete="list"
                autoComplete="off"
                value={value}
                disabled={disabled}
                placeholder={placeholder}
                onClick={() => { if (!open) openList(); }}
                onBlur={close}
                onKeyDown={handleKeyDown}
                onChange={(event) => {
                    onChange(event.target.value);
                    setQuery(event.target.value);
                    setActive(event.target.value.trim() ? 0 : -1);
                    if (!open) {
                        measure();
                        setOpen(true);
                    }
                }}
            />
            {action}
            <button
                type="button"
                className="combobox-toggle"
                tabIndex={-1}
                disabled={disabled}
                aria-label="展开选项"
                onMouseDown={(event) => {
                    event.preventDefault();
                    if (open) {
                        close();
                    } else {
                        inputRef.current?.focus();
                        openList();
                    }
                }}
            >
                <Icon name="chevronDown" size={16} />
            </button>
            {popupStyle && createPortal(
                <ul ref={listRef} id={listId} role="listbox" className="combobox-popup" style={popupStyle}>
                    {filtered.length === 0 && (
                        <li className="combobox-empty">
                            {loading ? '正在加载…' : options.length === 0 ? '暂无可选项，可以直接输入' : emptyText}
                        </li>
                    )}
                    {filtered.map((option, index) => (
                        <li
                            key={option}
                            role="option"
                            aria-selected={option === value}
                            className={`combobox-option ${index === active ? 'active' : ''} ${option === value ? 'selected' : ''}`}
                            onMouseDown={(event) => { event.preventDefault(); choose(option); }}
                            onMouseEnter={() => setActive(index)}
                        >
                            <span className="combobox-option-text">{option}</span>
                            {option === value && <Icon name="check" size={15} />}
                        </li>
                    ))}
                </ul>,
                document.body
            )}
        </div>
    );
}

/** 模型名：可以从供应商的模型列表里选，也可以直接输入。 */
function ModelSelectField({ displayName, help, value, onChange, providerId, scopeSelfId = null }) {
    const [models, setModels] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [cached, setCached] = useState(false);
    const requestIdRef = useRef(0);

    const loadModels = useCallback(async (force = false) => {
        const requestId = ++requestIdRef.current;
        if (!providerId) {
            setModels([]);
            setError('');
            setCached(false);
            return;
        }

        setLoading(true);
        setError('');
        try {
            const query = `/api/ai/models?providerId=${encodeURIComponent(providerId)}${force ? '&refresh=1' : ''}`;
            const response = await fetch(buildScopedUrl(query, scopeSelfId), {
                headers: { Authorization: `Bearer ${getAuthToken()}` },
            });
            const payload = await response.json();
            if (response.status === 404) throw new Error('这个供应商还没保存，保存后才能拉取模型列表');
            if (!response.ok || !payload.success) throw new Error(payload.error || '模型列表加载失败');
            if (requestId !== requestIdRef.current) return;
            setModels(Array.isArray(payload.data?.models) ? payload.data.models : []);
            setCached(payload.data?.cached === true);
        } catch (fetchError) {
            if (requestId !== requestIdRef.current) return;
            setModels([]);
            setCached(false);
            setError(fetchError.message || '模型列表加载失败');
        } finally {
            if (requestId === requestIdRef.current) setLoading(false);
        }
    }, [providerId, scopeSelfId]);

    useEffect(() => {
        const timer = window.setTimeout(() => { void loadModels(false); }, 0);
        return () => window.clearTimeout(timer);
    }, [loadModels]);

    return (
        <FieldShell
            label={displayName}
            help={help}
        >
            <Combobox
                value={value ?? ''}
                options={models}
                loading={loading}
                disabled={!providerId}
                placeholder={!providerId ? '请先选择供应商' : loading ? '正在加载模型列表…' : '输入或选择模型名'}
                emptyText="没有匹配的模型，将直接使用输入的名字"
                onChange={(next) => onChange(next.trim())}
                action={(
                    <button
                        type="button"
                        className="combobox-toggle combobox-action"
                        tabIndex={-1}
                        disabled={!providerId || loading}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => loadModels(true)}
                        title={models.length > 0 ? `重新拉取模型列表（当前 ${models.length} 个${cached ? '，来自缓存' : ''}）` : '重新拉取模型列表'}
                        aria-label="重新拉取模型列表"
                    >
                        <Icon name="refresh" size={15} className={loading ? 'spin' : ''} />
                    </button>
                )}
            />
            {error && <div className="field-note field-note--warn">{error}</div>}
            {value && models.length > 0 && !models.includes(value) && (
                <div className="field-note field-note--warn">供应商的模型列表里没有“{value}”，请确认名字是否正确</div>
            )}
        </FieldShell>
    );
}

function ToolMultiSelectField({ displayName, help, value, onChange }) {
    const [showModal, setShowModal] = useState(false);
    const [toolOptions, setToolOptions] = useState([]);
    const items = Array.isArray(value) ? value : [];

    useEffect(() => {
        const token = getAuthToken();
        fetch('/api/available-tools', {
            headers: { Authorization: `Bearer ${token}` },
        })
            .then(r => r.json())
            .then(d => {
                if (d.success && Array.isArray(d.data)) {
                    setToolOptions(d.data);
                }
            })
            .catch(() => {});
    }, []);

    const removeItem = (index) => {
        onChange(items.filter((_, i) => i !== index));
    };

    // key → label 查找
    const labelMap = Object.fromEntries(toolOptions.map(t => [t.key, t.label]));

    return (
        <FieldShell layout="stack" label={displayName} help={help} extra={<><span className="field-count">{items.length}</span></>}>
            <div className="array-field group-select-field">
                {items.map((item, index) => (
                    <span key={index} className="array-tag">
                        {labelMap[item] || item}
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
                    + 选择工具
                </button>
            </div>
            {showModal && (
                <ToolMultiSelectModal
                    title="选择工具"
                    options={toolOptions}
                    selected={items}
                    onConfirm={(selected) => { onChange(selected); setShowModal(false); }}
                    onCancel={() => setShowModal(false)}
                />
            )}
        </FieldShell>
    );
}

/**
 * 工具多选弹窗 — 显示中文 label，存储 key
 */
function ToolMultiSelectModal({ title, options, selected, onConfirm, onCancel }) {
    const [search, setSearch] = useState('');
    const [checked, setChecked] = useState(new Set(selected));

    const filtered = options.filter(opt => {
        if (!search) return true;
        const q = search.toLowerCase();
        return opt.label.toLowerCase().includes(q) || opt.key.toLowerCase().includes(q);
    });

    const toggleOption = (key) => {
        setChecked(prev => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    };

    const toggleAll = () => {
        const allChecked = filtered.every(opt => checked.has(opt.key));
        setChecked(prev => {
            const next = new Set(prev);
            if (allChecked) {
                filtered.forEach(opt => next.delete(opt.key));
            } else {
                filtered.forEach(opt => next.add(opt.key));
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
                    <button type="button" className="icon-btn" onClick={onCancel} aria-label="关闭"><Icon name="x" size={18} /></button>
                </div>
                <div className="group-select-search">
                    <input
                        type="text"
                        className="field-input"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="搜索工具..."
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
                                    checked={filtered.length > 0 && filtered.every(opt => checked.has(opt.key))}
                                    readOnly
                                />
                                <span className="group-select-info">
                                    <span className="group-select-name">全选 / 取消全选</span>
                                </span>
                            </label>
                            {filtered.map(opt => (
                                <div key={opt.key} className="group-select-item" onClick={() => toggleOption(opt.key)} style={{ cursor: 'pointer' }}>
                                    <input
                                        type="checkbox"
                                        checked={checked.has(opt.key)}
                                        readOnly
                                    />
                                    <span className="group-select-info">
                                        <span className="group-select-name">{opt.label}</span>
                                        <span className="group-select-id">{opt.key}</span>
                                    </span>
                                </div>
                            ))}
                        </>
                    )}
                </div>
                <div className="modal-footer">
                    <button className="btn btn-secondary" onClick={onCancel}>取消</button>
                    <button className="btn btn-primary" onClick={handleConfirm}>确定 ({checked.size})</button>
                </div>
            </div>
        </div>,
        document.body
    );
}

/**
 * 动态选择字段 — 从 API 获取选项列表
 * uiType: 动态选项类型标识（如 roleSelect, channelSelect）
 */
function DynamicSelectField({ displayName, help, value, onChange, uiType, scopeSelfId = null }) {
    const { options, label: configLabel, loading, isDynamic } = useDynamicOptions(scopeSelfId, uiType);

    // 如果不是动态类型，回退到普通文本输入
    if (!loading && !isDynamic) {
        return (
            <FieldShell label={displayName} help={help}>
                <input
                    type="text"
                    className="field-input"
                    value={value ?? ''}
                    onChange={(e) => onChange(e.target.value)}
                />
            </FieldShell>
        );
    }

    // 确保当前值在选项中，如果不在则添加
    const allOptions = options.includes(value) || !value ? options : [value, ...options];

    return (
        <FieldShell label={displayName} help={help}>
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
        </FieldShell>
    );
}

/**
 * 动态多选数组字段 — 从 API 获取选项列表，弹窗多选
 * uiType: 动态选项类型标识（如 roleSelectArray, channelSelectArray）
 */
function DynamicSelectArrayField({ displayName, help, value, onChange, uiType, scopeSelfId = null }) {
    const [showModal, setShowModal] = useState(false);
    const { options, label: configLabel } = useDynamicOptions(scopeSelfId, uiType);
    const items = Array.isArray(value) ? value : [];

    const removeItem = (index) => {
        onChange(items.filter((_, i) => i !== index));
    };

    return (
        <FieldShell label={displayName} help={help} layout="stack" extra={<><span className="field-count">{items.length}</span></>}>
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
        </FieldShell>
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
                    <button type="button" className="icon-btn" onClick={onCancel} aria-label="关闭"><Icon name="x" size={18} /></button>
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
function CommandCostField({ displayName, help, value, onChange }) {
    const [commandNames, setCommandNames] = useState({});
    const [loading, setLoading] = useState(true);

    // 从 API 获取指令映射表
    useEffect(() => {
        const token = getAuthToken();
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

        const costNum = newCost;

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
            <FieldShell layout="stack" label={displayName} help={help}>
                <div className="field-input" style={{ color: 'var(--text-secondary)' }}>加载中...</div>
            </FieldShell>
        );
    }

    if (commandList.length === 0) {
        return (
            <FieldShell layout="stack" label={displayName} help={help}>
                <div className="empty-state" style={{ padding: '12px', fontSize: '13px' }}>
                    暂无已定义的指令消耗配置
                </div>
            </FieldShell>
        );
    }

    return (
        <FieldShell layout="stack" label={displayName} help={help} extra={<><span className="field-count">{value?.length || 0}</span></>}>
            <div className="command-cost-grid">
                {commandList.map((cmdName) => (
                    <label key={cmdName} className="command-cost-item">
                        <span className="command-cost-label" title={cmdName}>{cmdName}</span>
                        <DraftInput
                            type="number"
                            inputMode="numeric"
                            className="command-cost-input"
                            min="0"
                            step="1"
                            placeholder="0"
                            value={costMap.get(cmdName) ?? 0}
                            parse={(text) => {
                                const number = Number(text);
                                return text.trim() && Number.isSafeInteger(number) && number >= 0
                                    ? number : undefined;
                            }}
                            onChange={(cost) => handleCostChange(cmdName, cost)}
                        />
                    </label>
                ))}
            </div>
        </FieldShell>
    );
}

/**
 * Cron 表达式可视化编辑器
 * 支持 5 段标准格式（分 时 日 月 周）
 */
function CronField({ displayName, help, value, onChange }) {
    const cronValue = value ?? '0 * * * *';
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
    const isValidSegment = (val) => /^[0-9*,/-]+$/.test(val);
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
        <FieldShell layout="stack" label={displayName} help={help}>

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
                    {getReadable()}
                </div>
            )}
            {!allValid && (
                <div className="cron-error">
                    格式无效，请检查表达式
                </div>
            )}

            {/* Visual segment editors */}
            <div className="cron-segments">
                {fieldDefs.map((fd) => (
                    <div key={fd.key} className="cron-segment">
                        <span className="cron-segment-label">{fd.label}</span>
                        <DraftInput
                            type="text"
                            className={`cron-segment-input ${!isValidSegment(segments[fd.key]) ? 'cron-input-error' : ''}`}
                            value={segments[fd.key]}
                            placeholder={fd.placeholder}
                            parse={(text) => text || '*'}
                            onChange={(text) => updateSegment(fd.key, text)}
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
        </FieldShell>
    );
}
