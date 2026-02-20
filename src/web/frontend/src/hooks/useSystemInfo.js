import { useState, useEffect, useCallback, useRef } from 'react';

const API_BASE = '';

/**
 * 系统信息管理 Hook
 * 获取静态系统信息和动态监控数据
 */
export function useSystemInfo(token, enabled = true) {
    // 静态信息（不常变化）
    const [staticInfo, setStaticInfo] = useState(null);
    // 动态信息（实时变化）
    const [dynamicInfo, setDynamicInfo] = useState(null);
    // Bot 信息
    const [botInfo, setBotInfo] = useState(null);
    // 加载状态
    const [loading, setLoading] = useState(true);
    // 错误状态
    const [error, setError] = useState(null);
    // 网络历史数据（用于计算速率）
    const [networkHistory, setNetworkHistory] = useState([]);
    // 上次获取时间
    const lastFetchRef = useRef(0);

    const headers = useCallback(() => ({
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }), [token]);

    // 获取静态系统信息
    const fetchStaticInfo = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/system/static`, { headers: headers() });
            if (res.status === 401) {
                setError('认证失败');
                return;
            }
            const data = await res.json();
            if (data.success) {
                setStaticInfo(data.data);
            }
        } catch (e) {
            console.error('获取静态系统信息失败:', e);
            setError('获取系统信息失败');
        }
    }, [headers]);

    // 获取动态系统信息
    const fetchDynamicInfo = useCallback(async () => {
        try {
            const now = Date.now();
            const res = await fetch(`${API_BASE}/api/system/dynamic`, { headers: headers() });
            if (res.status === 401) {
                setError('认证失败');
                return;
            }
            const data = await res.json();
            if (data.success) {
                const dynamicData = data.data;
                
                // 计算网络速率
                if (dynamicData.networkStats && lastFetchRef.current > 0) {
                    const timeDiff = (now - lastFetchRef.current) / 1000; // 秒
                    setNetworkHistory(prev => {
                        const newEntry = {
                            timestamp: now,
                            stats: dynamicData.networkStats,
                        };
                        // 保留最近 60 条记录
                        const updated = [...prev, newEntry].slice(-60);
                        return updated;
                    });
                }
                
                lastFetchRef.current = now;
                setDynamicInfo(dynamicData);
            }
        } catch (e) {
            console.error('获取动态系统信息失败:', e);
        }
    }, [headers]);

    // 获取 Bot 信息
    const fetchBotInfo = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/bot/info`, { headers: headers() });
            if (res.status === 401) {
                return;
            }
            const data = await res.json();
            if (data.success) {
                setBotInfo(data.data);
            }
        } catch (e) {
            console.error('获取 Bot 信息失败:', e);
        }
    }, [headers]);

    // 初始加载
    useEffect(() => {
        if (!token || !enabled) {
            setLoading(false);
            return;
        }

        const loadAll = async () => {
            setLoading(true);
            await Promise.all([
                fetchStaticInfo(),
                fetchDynamicInfo(),
                fetchBotInfo(),
            ]);
            setLoading(false);
        };

        loadAll();
    }, [token, enabled, fetchStaticInfo, fetchDynamicInfo, fetchBotInfo]);

    // 定时刷新动态信息
    useEffect(() => {
        if (!token || !enabled) return;

        const interval = setInterval(() => {
            fetchDynamicInfo();
            fetchBotInfo();
        }, 2000); // 每 2 秒刷新一次

        return () => clearInterval(interval);
    }, [token, enabled, fetchDynamicInfo, fetchBotInfo]);

    // 手动刷新
    const refresh = useCallback(async () => {
        setLoading(true);
        await Promise.all([
            fetchStaticInfo(),
            fetchDynamicInfo(),
            fetchBotInfo(),
        ]);
        setLoading(false);
    }, [fetchStaticInfo, fetchDynamicInfo, fetchBotInfo]);

    // 计算网络速率
    const networkSpeed = useCallback(() => {
        if (networkHistory.length < 2) return null;
        
        const latest = networkHistory[networkHistory.length - 1];
        const previous = networkHistory[networkHistory.length - 2];
        const timeDiff = (latest.timestamp - previous.timestamp) / 1000;
        
        if (timeDiff <= 0) return null;
        
        const speeds = [];
        for (let i = 0; i < latest.stats.length; i++) {
            const latestStat = latest.stats[i];
            const prevStat = previous.stats.find(s => s.iface === latestStat.iface);
            if (prevStat) {
                speeds.push({
                    iface: latestStat.iface,
                    rxSpeed: (latestStat.rx_bytes - prevStat.rx_bytes) / timeDiff,
                    txSpeed: (latestStat.tx_bytes - prevStat.tx_bytes) / timeDiff,
                    rx_bytes: latestStat.rx_bytes,
                    tx_bytes: latestStat.tx_bytes,
                });
            }
        }
        return speeds;
    }, [networkHistory]);

    return {
        staticInfo,
        dynamicInfo,
        botInfo,
        loading,
        error,
        refresh,
        networkSpeed: networkSpeed(),
    };
}
