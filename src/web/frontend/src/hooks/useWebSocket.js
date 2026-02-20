import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * WebSocket 实时连接 Hook
 * 监听框架配置和插件配置变更事件
 */
export function useWebSocket(token, onConfigChanged, onPluginConfigChanged) {
    const [connected, setConnected] = useState(false);
    const wsRef = useRef(null);
    const reconnectTimer = useRef(null);

    const connect = useCallback(() => {
        if (!token) return;

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        const url = `${protocol}//${host}`;

        try {
            const ws = new WebSocket(url);
            wsRef.current = ws;

            ws.onopen = () => {
                setConnected(true);
                console.log('[WS] 已连接');
            };

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);

                    // 框架配置变更
                    if (msg.type === 'config_changed' && msg.data) {
                        console.log('[WS] 框架配置已更新');
                        onConfigChanged?.(msg.data);
                    }

                    // 插件配置变更
                    if (msg.type === 'plugin_config_changed' && msg.pluginName && msg.moduleName) {
                        console.log(`[WS] 插件配置已更新: ${msg.pluginName}/${msg.moduleName}`);
                        onPluginConfigChanged?.(msg.pluginName, msg.moduleName, msg.data);
                    }
                } catch (e) {
                    console.error('[WS] 消息解析失败:', e);
                }
            };

            ws.onclose = () => {
                setConnected(false);
                wsRef.current = null;
                reconnectTimer.current = setTimeout(connect, 3000);
            };

            ws.onerror = () => {
                ws.close();
            };
        } catch (e) {
            console.error('[WS] 连接失败:', e);
            reconnectTimer.current = setTimeout(connect, 3000);
        }
    }, [token, onConfigChanged, onPluginConfigChanged]);

    useEffect(() => {
        connect();
        return () => {
            clearTimeout(reconnectTimer.current);
            if (wsRef.current) {
                wsRef.current.close();
            }
        };
    }, [connect]);

    return { connected };
}
