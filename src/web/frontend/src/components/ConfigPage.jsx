import { useCallback, useMemo, useState } from 'react';
import { buildFieldCards } from '../utils/fieldCards';
import CardBoard from './CardBoard';
import Icon from './Icon';
import { DraftContext } from '../hooks/draftContext';

function isSame(left, right) {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function describeIssue(issue, meta) {
    const path = Array.isArray(issue?.path) ? issue.path : [];
    const labels = [];
    let current = meta;
    for (const part of path) {
        if (typeof part === 'number') {
            labels.push(`第 ${part + 1} 项`);
            current = current?.items;
            continue;
        }
        const child = current?.children?.[part];
        labels.push(child?.label || child?.description || String(part));
        current = child;
    }
    const where = labels.join(' › ');
    return where ? `${where}：${issue.message}` : issue?.message || '配置无效';
}

export function PageHeader({ title, icon = null, actions }) {
    return (
        <header className="page-header">
            <div className="page-heading">
                {icon && <span className="page-title-icon"><Icon name={icon} size={20} /></span>}
                <h1 className="page-title">{title}</h1>
            </div>
            {actions && <div className="page-actions">{actions}</div>}
        </header>
    );
}

export function SaveBar({ dirtyCount, saving, onSave, onDiscard, label }) {
    if (dirtyCount === 0 && !saving) return null;
    return (
        <div className="save-bar" role="region" aria-label="保存修改">
            <div className="save-bar-inner">
                <span className="save-bar-dot" />
                <span className="save-bar-text">{label || `有 ${dirtyCount} 处未保存的修改`}</span>
                <div className="save-bar-actions">
                    <button type="button" className="btn btn-ghost" disabled={saving} onClick={onDiscard}>
                        <Icon name="undo" size={15} />
                        放弃
                    </button>
                    <button type="button" className="btn btn-primary" disabled={saving} onClick={onSave}>
                        <Icon name="check" size={15} />
                        {saving ? '保存中…' : '保存'}
                    </button>
                </div>
            </div>
        </div>
    );
}

function IssueList({ issues, meta, title = '' }) {
    if (!issues || issues.length === 0) return null;
    return (
        <div className="callout callout-error" role="alert">
            <Icon name="alert" size={16} />
            <div>
                <div className="callout-title">{title ? `${title}：` : ''}保存失败，请修改以下内容</div>
                <ul>
                    {issues.slice(0, 8).map((issue, index) => <li key={index}>{describeIssue(issue, meta)}</li>)}
                </ul>
            </div>
        </div>
    );
}

/**
 * 插件配置页：一个页面可以包含多个模块，共用一个保存栏。
 */
export function PluginConfigPage({
    page,
    schemas,
    configs,
    onSaveModule,
    headerActions = null,
}) {
    const modules = page.modules;
    // 切换页面时由外层用 key 重新挂载，草稿自然清空
    const [drafts, setDrafts] = useState({});
    const [issues, setIssues] = useState({});
    const [saving, setSaving] = useState(false);

    const moduleValues = useMemo(() => {
        const values = {};
        for (const module of modules) values[module] = drafts[module] ?? configs?.[module] ?? null;
        return values;
    }, [modules, drafts, configs]);

    const changed = modules.filter((module) => drafts[module] !== undefined && !isSame(drafts[module], configs?.[module]));

    const updateModule = useCallback((module, nextValue) => {
        setDrafts((prev) => {
            if (isSame(nextValue, configs?.[module])) {
                const { [module]: _removed, ...rest } = prev;
                return rest;
            }
            return { ...prev, [module]: nextValue };
        });
    }, [configs]);

    const save = async () => {
        setSaving(true);
        const nextIssues = {};
        const saved = [];
        for (const module of changed) {
            const result = await onSaveModule(module, drafts[module]);
            if (result?.success) saved.push(module);
            else nextIssues[module] = result?.errors?.length ? result.errors : [{ message: result?.error || '保存失败' }];
        }
        setDrafts((prev) => {
            const next = { ...prev };
            for (const module of saved) delete next[module];
            return next;
        });
        setIssues(nextIssues);
        setSaving(false);
    };

    const discard = () => {
        setDrafts({});
        setIssues({});
    };

    const cards = [];
    for (const module of modules) {
        const schema = schemas?.[module];
        const value = moduleValues[module];
        if (!schema || !value) {
            cards.push({
                key: `${module}:loading`,
                node: (
                    <section className="card card-loading">
                        <div className="skeleton" />
                        <div className="skeleton short" />
                    </section>
                ),
            });
            continue;
        }
        const moduleTitle = schema.label || schema.description || module;
        // 模块名和页面标题一样时不再重复显示
        const title = moduleTitle !== page.title ? moduleTitle : '';
        if (!schema.children) {
            cards.push({
                key: module,
                node: (
                    <section className="card">
                        {title && <header className="card-header"><h3 className="card-title">{title}</h3></header>}
                        <div className="card-body">
                            <textarea
                                className="field-input field-textarea code"
                                value={JSON.stringify(value, null, 2)}
                                onChange={(event) => {
                                    try {
                                        updateModule(module, JSON.parse(event.target.value));
                                    } catch { /* 输入中途的 JSON 无效时忽略 */ }
                                }}
                            />
                        </div>
                    </section>
                ),
            });
            continue;
        }
        cards.push(...buildFieldCards({
            keyPrefix: module,
            children: schema.children,
            value,
            onFieldChange: (key, next) => updateModule(module, { ...value, [key]: next }),
            anchorScope: module,
            title,
            help: schema.help,
            cardId: `module-${module}`,
        }));
    }

    return (
        <DraftContext.Provider value={moduleValues}>
            <div className="page page--settings">
                <PageHeader title={page.title} icon={page.icon || 'puzzle'} actions={headerActions} />
                <CardBoard cards={cards}>
                    {modules.map((module) => (
                        <IssueList
                            key={module}
                            issues={issues[module]}
                            meta={schemas?.[module]}
                            title={modules.length > 1 ? (schemas?.[module]?.label || module) : ''}
                        />
                    ))}
                </CardBoard>
                <SaveBar
                    dirtyCount={changed.length}
                    saving={saving}
                    onSave={save}
                    onDiscard={discard}
                    label={changed.length > 1 ? `${changed.length} 个模块有未保存的修改` : '有未保存的修改'}
                />
            </div>
        </DraftContext.Provider>
    );
}

/**
 * 单个配置对象的页面（框架配置、权限设置）。
 * sections: [{ key, title, help, meta }]，key 为 null 表示根上的普通字段。
 */
export function ObjectConfigPage({
    title,
    icon = null,
    schema,
    config,
    sections,
    onSave,
    headerActions = null,
    warnings = null,
}) {
    // 草稿只对它开始编辑时的那份配置有效；配置在别处被改动后自动丢弃
    const [draftState, setDraftState] = useState({ base: null, value: null });
    const [issues, setIssues] = useState(null);
    const [saving, setSaving] = useState(false);
    const draft = draftState.base === config ? draftState.value : null;
    const setDraft = (next) => setDraftState({ base: config, value: next });

    const value = draft ?? config;
    const dirty = draft !== null && !isSame(draft, config);

    const save = async () => {
        setSaving(true);
        const result = await onSave(draft);
        if (result?.success) {
            setDraft(null);
            setIssues(null);
        } else {
            setIssues(result?.errors?.length ? result.errors : [{ message: result?.error || '保存失败' }]);
        }
        setSaving(false);
    };

    if (!value || !schema) {
        return (
            <div className="page page--settings">
                <PageHeader title={title} icon={icon} actions={headerActions} />
                <section className="card card-loading"><div className="skeleton" /><div className="skeleton short" /></section>
            </div>
        );
    }

    const cards = sections.flatMap((section) => {
        if (section.key == null) {
            return buildFieldCards({
                keyPrefix: '__root__',
                children: section.meta.children,
                value,
                onFieldChange: (key, next) => setDraft({ ...value, [key]: next }),
                anchorScope: 'root',
                groupByCard: false,
                title: section.title,
                help: section.help,
            });
        }
        const sectionValue = value?.[section.key] || {};
        return buildFieldCards({
            keyPrefix: section.key,
            children: section.meta.children,
            value: sectionValue,
            onFieldChange: (key, next) => setDraft({ ...value, [section.key]: { ...sectionValue, [key]: next } }),
            anchorScope: section.key,
            groupByCard: false,
            title: section.title,
            help: section.help,
            cardId: `section-${section.key}`,
        });
    });

    return (
        <div className="page page--settings">
            <PageHeader title={title} icon={icon} actions={headerActions} />
            <CardBoard cards={cards}>
                {warnings}
                <IssueList issues={issues} meta={schema} />
            </CardBoard>
            <SaveBar dirtyCount={dirty ? 1 : 0} saving={saving} onSave={save} onDiscard={() => { setDraft(null); setIssues(null); }} label="有未保存的修改" />
        </div>
    );
}
