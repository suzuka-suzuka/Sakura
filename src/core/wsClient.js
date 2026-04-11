import { WebSocket, WebSocketServer } from "ws";
import { EventEmitter } from "events";

let nextClientId = 1;

export class OneBotWsClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this._ws = null;
    this._wsServer = null;
    this._pending = new Map();
    this._reconnectTimer = null;
    this._reconnectCount = 0;
    this._heartbeatTimer = null;
    this._disconnecting = false;

    this._clientId = `onebot-${nextClientId++}`;
    this._connections = new Map();
    this._selfIdToConnection = new Map();
    this._nextConnectionId = 1;

    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        if (typeof prop !== "string") {
          return undefined;
        }
        if (/^[a-z][a-z_0-9]*$/.test(prop)) {
          return (params, options) => target.send(prop, params, options);
        }
        return undefined;
      },
    });
  }

  async connect() {
    const { mode = "forward" } = this.config;
    if (mode === "reverse") {
      await this._startServer();
      return;
    }
    await this._connectForward();
  }

  disconnect() {
    this._disconnecting = true;
    this._stopHeartbeat();

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    if (this._ws) {
      this._ws.close(1000, "disconnect");
      this._ws = null;
    }

    for (const connection of this._connections.values()) {
      try {
        connection.ws.close(1000, "disconnect");
      } catch {
      }
    }
    this._connections.clear();
    this._selfIdToConnection.clear();

    if (this._wsServer) {
      this._wsServer.close();
      this._wsServer = null;
    }

    for (const [, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("WebSocket disconnected"));
    }
    this._pending.clear();
  }

  async send(action, params = {}, options = {}) {
    const ws = this._resolveSocketForSend(options?.selfId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`WebSocket 未连接，无法调用 ${action}`);
    }

    const echo = `${action}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(echo);
        reject(new Error(`请求超时: ${action}`));
      }, 30000);

      this._pending.set(echo, { resolve, reject, timer });

      ws.send(JSON.stringify({ action, params, echo }), (err) => {
        if (err) {
          this._pending.delete(echo);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  _resolveSocketForSend(selfId) {
    if (this.config.mode !== "reverse") {
      return this._ws;
    }

    const normalizedSelfId = Number(selfId);
    if (Number.isFinite(normalizedSelfId)) {
      return this._selfIdToConnection.get(normalizedSelfId)?.ws || null;
    }

    const openConnections = Array.from(this._connections.values()).filter(
      (connection) => connection.ws.readyState === WebSocket.OPEN
    );

    if (openConnections.length === 1) {
      return openConnections[0].ws;
    }

    return null;
  }

  _startHeartbeat(ws) {
    const interval = this.config.heartbeatInterval ?? 30000;
    if (!interval) return;

    this._heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, interval);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  _connectForward() {
    const { url, accessToken } = this.config;
    return new Promise((resolve, reject) => {
      const headers = {};
      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
      }

      const ws = new WebSocket(url, { headers });
      this._ws = ws;

      const routeKey = `${this._clientId}:forward`;
      let settled = false;
      const settle = (fn, value) => {
        if (!settled) {
          settled = true;
          fn(value);
        }
      };

      ws.on("open", () => {
        this._reconnectCount = 0;
        this._startHeartbeat(ws);
        this.emit("socket.open", { routeKey });
        settle(resolve);
      });

      ws.on("message", (data) => this._handleMessage(data, { routeKey }));

      ws.on("close", (code, reason) => {
        this._stopHeartbeat();
        this._ws = null;
        this.emit("socket.close", {
          code,
          reason: reason?.toString() || "",
          routeKey,
        });
        if (!this._disconnecting) {
          this._scheduleReconnect();
        }
        settle(reject, new Error(`连接关闭 code=${code}`));
      });

      ws.on("error", (err) => {
        this.emit("socket.error", {
          error_type: err.message,
          routeKey,
        });
        settle(reject, err);
      });
    });
  }

  _scheduleReconnect() {
    const delay = this.config.reconnectDelay ?? 5000;
    if (!delay) return;

    this._reconnectCount += 1;
    this.emit("socket.connecting", {
      reconnection: { nowAttempts: this._reconnectCount },
    });

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connectForward().catch(() => {});
    }, delay);
  }

  _startServer() {
    const { reversePort = 3002, accessToken } = this.config;
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({ port: reversePort });
      this._wsServer = server;

      server.on("error", reject);
      server.on("listening", resolve);

      server.on("connection", (ws, req) => {
        if (accessToken) {
          const authHeader = req.headers.authorization || "";
          const queryToken = (() => {
            try {
              return new URL(req.url || "/", "http://localhost").searchParams.get("access_token") || "";
            } catch {
              return "";
            }
          })();
          const provided = authHeader.replace(/^Bearer\s+/i, "").trim() || queryToken;
          if (provided !== accessToken) {
            ws.close(1008, "Unauthorized");
            return;
          }
        }

        const connectionId = `${this._clientId}:reverse:${this._nextConnectionId++}`;
        const connection = {
          id: connectionId,
          ws,
          selfIds: new Set(),
        };
        this._connections.set(connectionId, connection);
        this.emit("socket.open", { routeKey: connectionId });

        ws.on("message", (data) => this._handleMessage(data, { routeKey: connectionId, connection }));

        ws.on("close", (code, reason) => {
          this._removeConnection(connection);
          this.emit("socket.close", {
            code,
            reason: reason?.toString() || "",
            routeKey: connectionId,
            selfIds: Array.from(connection.selfIds),
          });
        });

        ws.on("error", (err) => {
          this.emit("socket.error", {
            error_type: err.message,
            routeKey: connectionId,
          });
        });
      });
    });
  }

  _removeConnection(connection) {
    this._connections.delete(connection.id);
    for (const selfId of connection.selfIds) {
      const owner = this._selfIdToConnection.get(selfId);
      if (owner?.id === connection.id) {
        this._selfIdToConnection.delete(selfId);
      }
    }
  }

  _rememberConnectionSelfId(connection, selfId) {
    const normalizedSelfId = Number(selfId);
    if (!Number.isFinite(normalizedSelfId)) return;

    connection.selfIds.add(normalizedSelfId);
    this._selfIdToConnection.set(normalizedSelfId, connection);
  }

  _handleMessage(raw, meta = {}) {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.echo != null && this._pending.has(data.echo)) {
      const pending = this._pending.get(data.echo);
      this._pending.delete(data.echo);
      clearTimeout(pending.timer);

      if (data.status === "ok" || data.retcode === 0) {
        pending.resolve(data.data ?? null);
      } else {
        pending.reject(new Error(data.message || `API 错误 retcode=${data.retcode}`));
      }
      return;
    }

    if (!data.post_type) return;

    if (meta.connection && data.self_id != null) {
      this._rememberConnectionSelfId(meta.connection, data.self_id);
    }

    if (meta.routeKey) {
      data.__routeKey = meta.routeKey;
    }

    this.emit(data.post_type, data);

    if (data.post_type === "meta_event" && data.meta_event_type) {
      this.emit(`meta_event.${data.meta_event_type}`, data);
      if (data.sub_type) {
        this.emit(`meta_event.${data.meta_event_type}.${data.sub_type}`, data);
      }
    } else if (data.sub_type) {
      this.emit(`${data.post_type}.${data.sub_type}`, data);
    }
  }
}
