import { useEffect, useMemo, useState } from 'react';
import { readAuthToken } from '../utils/authStorage';
import { useDraftModules } from './draftContext';

const DEFAULT_SCOPE_KEY = '__default__';

/**
 * 动态选项共享缓存
 *
 * 所有 #xxxSelect 字段共用一份 /api/dynamic-options 结果：
 * - 同一账号作用域只发一次请求（并发去重）
 * - 配置保存 / WS 推送变更时整体失效，所有订阅字段一起重新拉取
 *
 * scopeKey -> { data, error, promise }
 */
const cache = new Map();
const listeners = new Set();
const EMPTY_OPTIONS = [];
const EMPTY_DETAILS = {};

function normalizeSelfId(value) {
    if (value == null) return null;
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : null;
}

function scopeKeyOf(selfId) {
    return selfId == null ? DEFAULT_SCOPE_KEY : String(selfId);
}

function buildUrl(selfId) {
    return selfId == null
        ? '/api/dynamic-options'
        : `/api/dynamic-options?selfId=${selfId}`;
}

function notify() {
    for (const listener of [...listeners]) {
        listener();
    }
}

async function requestOptions(selfId) {
    const token = readAuthToken({ touch: true });
    const res = await fetch(buildUrl(selfId), {
        headers: { Authorization: `Bearer ${token}` },
    });
    const payload = await res.json();
    if (!payload.success || !payload.data) {
        throw new Error(payload.error || '获取动态选项失败');
    }
    return payload.data;
}

/** 确保该作用域的数据已加载（已有缓存或请求在途时直接返回） */
function ensureLoaded(selfId) {
    const key = scopeKeyOf(selfId);
    let entry = cache.get(key);
    if (!entry) {
        entry = { data: null, error: null, promise: null };
        cache.set(key, entry);
    }
    if (entry.data || entry.error || entry.promise) {
        return;
    }

    entry.promise = requestOptions(selfId)
        .then((data) => { entry.data = data; })
        .catch((e) => { entry.error = e; })
        .finally(() => {
            entry.promise = null;
            notify();
        });
}

function readState(selfId, uiType) {
    const entry = cache.get(scopeKeyOf(selfId));

    if (!entry || (!entry.data && !entry.error)) {
        return {
            loading: true,
            isDynamic: true,
            options: EMPTY_OPTIONS,
            details: EMPTY_DETAILS,
            label: '',
        };
    }
    // 请求失败或该 uiType 未在 dynamicOptionsConfig 中声明 → 回退成普通文本输入
    if (entry.error) {
        return {
            loading: false,
            isDynamic: false,
            options: EMPTY_OPTIONS,
            details: EMPTY_DETAILS,
            label: '',
        };
    }

    const config = entry.data.config?.[uiType];
    if (!config) {
        return {
            loading: false,
            isDynamic: false,
            options: EMPTY_OPTIONS,
            details: EMPTY_DETAILS,
            label: '',
        };
    }

    return {
        loading: false,
        isDynamic: true,
        options: entry.data.options?.[uiType] || EMPTY_OPTIONS,
        details: entry.data.details?.[uiType] || EMPTY_DETAILS,
        label: config.label || '',
        sourceConfig: config,
    };
}

function pickValue(item, valueKey) {
    if (Array.isArray(valueKey)) {
        return valueKey.map((key) => String(item?.[key] ?? '').trim()).find(Boolean) || '';
    }
    return valueKey ? item?.[valueKey] : item;
}

/** 与后端 /api/dynamic-options 相同的取值规则，但数据来自页面草稿。 */
function computeFromDrafts(sourceConfig, drafts) {
    const values = [];
    const details = {};
    for (const source of sourceConfig.sources || []) {
        const moduleConfig = drafts[source.module];
        const items = source.path.split('.').reduce((obj, key) => obj?.[key], moduleConfig);
        if (!Array.isArray(items)) continue;
        for (const item of items) {
            const value = pickValue(item, source.valueKey);
            if (!value) continue;
            if (!values.includes(value)) values.push(value);
            if (Array.isArray(source.detailKeys)) {
                const picked = {};
                for (const key of source.detailKeys) {
                    const detail = item?.[key];
                    if (detail == null || ['string', 'number', 'boolean'].includes(typeof detail)) {
                        picked[key] = detail;
                    }
                }
                details[value] = { ...(details[value] || {}), ...picked };
            }
        }
    }
    return { values, details };
}

function sameState(a, b) {
    return a.loading === b.loading
        && a.isDynamic === b.isDynamic
        && a.label === b.label
        && a.options === b.options
        && a.details === b.details
        && a.sourceConfig === b.sourceConfig;
}

/**
 * 让所有动态选项失效并触发重新拉取
 * 配置保存成功、收到 WS 变更推送、或用户手动点刷新时调用
 */
export function invalidateDynamicOptions() {
    cache.clear();
    notify();
}

/**
 * 订阅某个 uiType 的动态选项
 * @returns {{ options: string[], details: object, label: string, loading: boolean, isDynamic: boolean }}
 */
export function useDynamicOptions(scopeSelfId, uiType) {
    const selfId = normalizeSelfId(scopeSelfId);
    const [state, setState] = useState(() => readState(selfId, uiType));

    useEffect(() => {
        let alive = true;

        const sync = () => {
            if (!alive) return;
            ensureLoaded(selfId);
            const next = readState(selfId, uiType);
            setState((prev) => (sameState(prev, next) ? prev : next));
        };

        listeners.add(sync);
        sync();

        return () => {
            alive = false;
            listeners.delete(sync);
        };
    }, [selfId, uiType]);

    const drafts = useDraftModules();
    return useMemo(() => {
        const sources = state.sourceConfig?.sources;
        if (!drafts || !Array.isArray(sources) || sources.length === 0) return state;
        if (!sources.every((source) => drafts[source.module])) return state;
        const { values, details } = computeFromDrafts(state.sourceConfig, drafts);
        return { ...state, options: values, details };
    }, [state, drafts]);
}
