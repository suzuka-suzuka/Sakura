import { useEffect, useRef, useState } from 'react';

export function useWebSocket(token, onConfigChanged, onPluginConfigChanged, onUnauthorized) {
    const [connected, setConnected] = useState(false);
    const wsRef = useRef(null);
    const reconnectTimerRef = useRef(null);
    const shouldReconnectRef = useRef(false);
    const handlersRef = useRef({
        onConfigChanged,
        onPluginConfigChanged,
        onUnauthorized,
    });

    useEffect(() => {
        handlersRef.current = {
            onConfigChanged,
            onPluginConfigChanged,
            onUnauthorized,
        };
    }, [onConfigChanged, onPluginConfigChanged, onUnauthorized]);

    useEffect(() => {
        clearTimeout(reconnectTimerRef.current);

        if (!token) {
            shouldReconnectRef.current = false;
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
            return undefined;
        }

        shouldReconnectRef.current = true;

        const connect = () => {
            if (!shouldReconnectRef.current) {
                return;
            }

            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const url = new URL(`${protocol}//${window.location.host}`);
            url.searchParams.set('token', token);

            try {
                const ws = new WebSocket(url.toString());
                wsRef.current = ws;

                ws.onopen = () => {
                    setConnected(true);
                };

                ws.onmessage = (event) => {
                    try {
                        const msg = JSON.parse(event.data);

                        if (msg.type === 'config_changed' && msg.data) {
                            handlersRef.current.onConfigChanged?.(msg.data);
                        }

                        if (msg.type === 'plugin_config_changed' && msg.pluginName && msg.moduleName) {
                            handlersRef.current.onPluginConfigChanged?.(
                                msg.pluginName,
                                msg.moduleName,
                                msg.data,
                                msg.selfId ?? null,
                            );
                        }
                    } catch (error) {
                        console.error('[WS] Failed to parse message:', error);
                    }
                };

                ws.onclose = (event) => {
                    setConnected(false);
                    if (wsRef.current === ws) {
                        wsRef.current = null;
                    }

                    clearTimeout(reconnectTimerRef.current);
                    if (event.code === 1008) {
                        shouldReconnectRef.current = false;
                        handlersRef.current.onUnauthorized?.();
                        return;
                    }

                    if (shouldReconnectRef.current) {
                        reconnectTimerRef.current = window.setTimeout(connect, 3000);
                    }
                };

                ws.onerror = () => {
                    ws.close();
                };
            } catch (error) {
                console.error('[WS] Failed to connect:', error);
                reconnectTimerRef.current = window.setTimeout(connect, 3000);
            }
        };

        connect();

        return () => {
            shouldReconnectRef.current = false;
            clearTimeout(reconnectTimerRef.current);
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
        };
    }, [token]);

    return { connected: token ? connected : false };
}
