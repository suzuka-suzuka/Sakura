import { useCallback, useEffect, useRef, useState } from 'react';

const API_BASE = '';
const RUNTIME_REFRESH_INTERVAL_MS = 3000;

export function useSystemInfo(token, enabled = true, onUnauthorized) {
    const [staticInfo, setStaticInfo] = useState(null);
    const [dynamicInfo, setDynamicInfo] = useState(null);
    const [botInfo, setBotInfo] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const unauthorizedRef = useRef(onUnauthorized);

    useEffect(() => {
        unauthorizedRef.current = onUnauthorized;
    }, [onUnauthorized]);

    const headers = useCallback(() => ({
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }), [token]);

    const fetchJson = useCallback(async (path) => {
        const res = await fetch(`${API_BASE}${path}`, { headers: headers() });
        if (res.status === 401) {
            setError('认证已失效');
            unauthorizedRef.current?.();
            return null;
        }

        return res.json();
    }, [headers]);

    const loadOverview = useCallback(async () => {
        try {
            const data = await fetchJson('/api/system/all');
            if (!data) return false;

            if (data.success) {
                setStaticInfo(data.data?.static ?? null);
                setDynamicInfo(data.data?.dynamic ?? null);
                setBotInfo(data.data?.bot ?? null);
                setError(null);
                return true;
            }

            setError(data.error || '获取系统信息失败');
            return false;
        } catch (err) {
            console.error('Failed to fetch system overview:', err);
            setError('获取系统信息失败');
            return false;
        }
    }, [fetchJson]);

    const loadRuntime = useCallback(async () => {
        try {
            const data = await fetchJson('/api/system/runtime');
            if (!data) return false;

            if (data.success) {
                setDynamicInfo(data.data?.dynamic ?? null);
                setBotInfo(data.data?.bot ?? null);
                setError(null);
                return true;
            }

            setError(data.error || '获取系统信息失败');
            return false;
        } catch (err) {
            console.error('Failed to fetch system runtime:', err);
            return false;
        }
    }, [fetchJson]);

    useEffect(() => {
        if (!token || !enabled) {
            return undefined;
        }

        let cancelled = false;

        const init = async () => {
            setLoading(true);
            await loadOverview();
            if (!cancelled) {
                setLoading(false);
            }
        };

        init();

        return () => {
            cancelled = true;
        };
    }, [token, enabled, loadOverview]);

    useEffect(() => {
        if (!token || !enabled) {
            return undefined;
        }

        const interval = window.setInterval(() => {
            void loadRuntime();
        }, RUNTIME_REFRESH_INTERVAL_MS);

        return () => window.clearInterval(interval);
    }, [token, enabled, loadRuntime]);

    const refresh = useCallback(async () => {
        setLoading(true);
        await loadOverview();
        setLoading(false);
    }, [loadOverview]);

    return {
        staticInfo,
        dynamicInfo,
        botInfo,
        loading: token && enabled ? loading : false,
        error,
        refresh,
    };
}
