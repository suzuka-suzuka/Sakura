// schema 元数据 → 面板布局的公共逻辑：字段可见性、分组、摘要文本、导航结构。

function asText(value) {
    if (value === true) return 'true';
    if (value === false) return 'false';
    if (value == null) return '';
    return String(value);
}

/**
 * 字段在当前表单值下是否显示。
 * - showIf：所有条件都满足才显示
 * - protocol：只在所选供应商是该协议时显示（context.protocol 由模型编辑器提供）
 */
export function isFieldVisible(meta, formValue, context = {}) {
    if (!meta) return false;
    for (const condition of meta.showIf || []) {
        const current = asText(formValue?.[condition.field]);
        const matched = condition.values.includes(current);
        if (condition.negate ? matched : !matched) return false;
    }
    if (meta.protocol && meta.protocol !== context.protocol) return false;
    return true;
}

/** 隐藏字段恢复默认值，避免切换选项后残留无效配置。 */
export function resetHiddenFields(children, value, context = {}) {
    if (!children || !value || typeof value !== 'object') return value;
    const next = { ...value };
    for (const [key, meta] of Object.entries(children)) {
        if (!isFieldVisible(meta, next, context) && meta.default !== undefined) {
            next[key] = structuredClone(meta.default);
        }
    }
    return next;
}

/**
 * 按 group 指令把字段分成若干卡片，保持字段原有顺序。
 * 没有分组的字段放在第一组（标题为空）。
 */
export function groupFields(children) {
    const groups = [];
    const byTitle = new Map();
    for (const [key, meta] of Object.entries(children || {})) {
        const title = meta.group || '';
        if (!byTitle.has(title)) {
            const group = { title, fields: [] };
            byTitle.set(title, group);
            if (title) groups.push(group);
            else groups.unshift(group);
        }
        byTitle.get(title).fields.push([key, meta]);
    }
    return groups;
}

/** 列表行摘要里显示字段值。 */
export function formatSummaryValue(meta, value) {
    if (value == null || value === '') return '';
    if (Array.isArray(value)) {
        if (value.length === 0) return '';
        const isOrdered = meta?.uiType?.startsWith('modelList');
        const text = value.map((item) => (typeof item === 'object' ? JSON.stringify(item) : String(item)))
            .join(isOrdered ? ' → ' : '、');
        return truncate(text, 60);
    }
    if (meta?.type === 'boolean') return value ? (meta.label || meta.description || '是') : '';
    if (meta?.type === 'enum') return meta.optionLabels?.[value] || String(value);
    if (typeof value === 'object') return '';
    return truncate(String(value).replace(/\s+/g, ' '), 60);
}

function truncate(text, length) {
    return text.length > length ? `${text.slice(0, length)}…` : text;
}

/** 对象数组某一项的标题。 */
export function itemTitle(item, index, nameField) {
    const pick = (field) => {
        const value = item?.[field];
        if (Array.isArray(value)) return value.filter(Boolean).join('、');
        if (value === 0 || value) return String(value);
        return '';
    };
    if (nameField) {
        const text = pick(nameField);
        if (text) return text;
    }
    for (const field of ['name', 'model', 'trigger', 'cmd', 'prefix', 'group', 'id']) {
        const text = pick(field);
        if (text) return text;
    }
    return `第 ${index + 1} 项`;
}

/**
 * 插件导航：支持新格式（数组：分组 → 页面 → 模块）和旧格式（对象：分类 → 模块）。
 * 返回 [{ title, pages: [{ key, title, icon, description, modules }] }]
 */
export function buildPluginNavigation(pluginName, categories, modules = []) {
    const known = new Set(modules);
    const used = new Set();
    const groups = [];

    if (Array.isArray(categories)) {
        for (const group of categories) {
            const pages = (group.pages || [])
                .map((page) => ({
                    ...page,
                    key: page.key || page.title,
                    modules: (page.modules || []).filter((module) => known.has(module)),
                }))
                .filter((page) => page.modules.length > 0);
            pages.forEach((page) => page.modules.forEach((module) => used.add(module)));
            if (pages.length > 0) groups.push({ title: group.title || '', pages });
        }
    } else if (categories && typeof categories === 'object') {
        const pages = Object.entries(categories)
            .map(([title, list]) => ({
                key: title,
                title,
                icon: 'puzzle',
                modules: (Array.isArray(list) ? list : []).filter((module) => known.has(module)),
            }))
            .filter((page) => page.modules.length > 0);
        pages.forEach((page) => page.modules.forEach((module) => used.add(module)));
        if (pages.length > 0) groups.push({ title: '', pages });
    }

    const rest = modules.filter((module) => !used.has(module));
    if (rest.length > 0) {
        const page = { key: '__other__', title: groups.length > 0 ? '其他' : '全部配置', icon: 'puzzle', modules: rest };
        if (groups.length > 0) groups.push({ title: '其他', pages: [page] });
        else groups.push({ title: '', pages: [page] });
    }

    return groups.map((group) => ({
        ...group,
        pages: group.pages.map((page) => ({ ...page, pluginName })),
    }));
}

/** 统计字段树里的标签，用于全局搜索。 */
export function collectFieldLabels(meta, prefix = '') {
    const results = [];
    for (const [key, child] of Object.entries(meta?.children || {})) {
        const label = child.label || child.description || key;
        results.push({ key: prefix ? `${prefix}.${key}` : key, label, help: child.help || '', group: child.group || '' });
        if (child.type === 'object' && child.children) {
            results.push(...collectFieldLabels(child, prefix ? `${prefix}.${key}` : key));
        }
    }
    return results;
}

export function fieldAnchorId(scope, key) {
    return `field-${String(scope).replace(/[^\w-]/g, '_')}-${String(key).replace(/[^\w-]/g, '_')}`;
}
