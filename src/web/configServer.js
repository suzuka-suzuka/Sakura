import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import si from 'systeminformation';
import Config from '../core/config.js';
import pluginConfigManager from '../core/pluginConfig.js';
import accountConfig from '../core/accountConfig.js';
import { logger } from '../utils/logger.js';
import { bot as botFacade, getBotSummaries } from '../api/client.js';
import yaml from 'js-yaml';
import { AVAILABLE_TOOL_OPTIONS } from '../../plugins/sakura-plugin/lib/AIUtils/tools/tools.js';
let cachedStaticInfo = null;
let staticInfoTime = 0;
const STATIC_INFO_CACHE_TIME = 60000;
const WEB_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_REQUEST_BODY_SIZE = 1024 * 1024;

async function getStaticSystemInfo() {
    const now = Date.now();
    if (cachedStaticInfo && (now - staticInfoTime) < STATIC_INFO_CACHE_TIME) {
        return cachedStaticInfo;
    }

    try {
        const [osInfo, cpu, graphics] = await Promise.all([
            si.osInfo(),
            si.cpu(),
            si.graphics(),
        ]);

        cachedStaticInfo = {
            os: {
                distro: osInfo.distro,
                release: osInfo.release,
                platform: osInfo.platform,
            },
            cpu: {
                brand: cpu.brand,
                manufacturer: cpu.manufacturer,
                physicalCores: cpu.physicalCores,
                cores: cpu.cores,
                speed: cpu.speed,
            },
            graphics: {
                controllers: (graphics.controllers || []).map((controller) => ({
                    model: controller.model,
                    vendor: controller.vendor,
                })),
            },
        };
        staticInfoTime = now;
        return cachedStaticInfo;
    } catch (e) {
        logger.error(`[ConfigServer] 获取静态系统信息失败: ${e}`);
        return null;
    }
}

let lastNetworkStats = null;
let lastNetworkTime = 0;

async function getDynamicSystemInfo() {
    try {
        const [currentLoad, mem, fsSize, networkStats, cpuCurrentSpeed, time] = await Promise.all([
            si.currentLoad(),
            si.mem(),
            si.fsSize(),
            si.networkStats('*'),
            si.cpuCurrentSpeed(),
            si.time(),
        ]);

        const now = Date.now();
        let networkStatsWithSpeed = networkStats;

        if (lastNetworkStats && lastNetworkTime > 0) {
            const timeDiff = (now - lastNetworkTime) / 1000;
            if (timeDiff > 0 && timeDiff < 10) {
                networkStatsWithSpeed = networkStats.map(current => {
                    const prev = lastNetworkStats.find(p => p.iface === current.iface);
                    if (prev) {
                        const rxDiff = current.rx_bytes - prev.rx_bytes;
                        const txDiff = current.tx_bytes - prev.tx_bytes;
                        return {
                            ...current,
                            rx_sec: current.rx_sec > 0 ? current.rx_sec : Math.max(0, rxDiff / timeDiff),
                            tx_sec: current.tx_sec > 0 ? current.tx_sec : Math.max(0, txDiff / timeDiff),
                        };
                    }
                    return current;
                });
            }
        }

        lastNetworkStats = networkStats.map(s => ({
            iface: s.iface,
            rx_bytes: s.rx_bytes,
            tx_bytes: s.tx_bytes
        }));
        lastNetworkTime = now;

        const networkSummary = networkStatsWithSpeed.reduce((summary, current) => ({
            rx_sec: summary.rx_sec + (current.rx_sec || 0),
            tx_sec: summary.tx_sec + (current.tx_sec || 0),
        }), { rx_sec: 0, tx_sec: 0 });

        const nodeProcess = {
            pid: process.pid,
            uptime: process.uptime(),
            version: process.version,
        };

        const actualUsedMemory = Number.isFinite(mem.active)
            ? mem.active
            : (Number.isFinite(mem.available) ? Math.max(0, mem.total - mem.available) : mem.used);

        return {
            currentLoad: {
                currentLoad: currentLoad.currentLoad,
            },
            mem: {
                total: mem.total,
                used: mem.used,
                actualUsed: actualUsedMemory,
                swaptotal: mem.swaptotal,
                swapused: mem.swapused,
            },
            fsSize: fsSize.map((current) => ({
                mount: current.mount,
                size: current.size,
                used: current.used,
            })),
            networkSummary,
            cpuCurrentSpeed: {
                avg: cpuCurrentSpeed.avg,
            },
            time: {
                uptime: time.uptime,
            },
            nodeProcess,
        };
    } catch (e) {
        logger.error(`[ConfigServer] 获取动态系统信息失败: ${e}`);
        return null;
    }
}

async function getBotInfo() {
    try {
        const onlineAccounts = getBotSummaries();
        const pluginScopedIds = pluginConfigManager.getConfiguredSelfIds('sakura-plugin');
        const configuredAccountIds = accountConfig.listConfiguredSelfIds();
        const configuredSelfIds = [...new Set([...pluginScopedIds, ...configuredAccountIds])];
        const accountMap = new Map();

        for (const account of onlineAccounts) {
            const id = Number(account.self_id);
            if (!id) continue; // 过滤 selfId=0 或无效账号
            accountMap.set(id, {
                ...account,
                status: account.status || 'online',
            });
        }

        for (const selfId of configuredSelfIds) {
            const id = Number(selfId);
            if (!id) continue; // 过滤 selfId=0
            if (!accountMap.has(id)) {
                accountMap.set(id, {
                    self_id: id,
                    uin: id,
                    nickname: `Bot ${id}`,
                    status: 'offline',
                });
            }
        }

        const accounts = Array.from(accountMap.values());
        if (accounts.length === 0) {
            return null;
        }

        // 已有独立配置文件的账号 ID 列表，供前端判断是否需要显示账号标签栏
        return {
            accounts,
            total: accounts.length,
            online: onlineAccounts.length,
            configuredAccountIds,
            configuredScopeIds: configuredSelfIds,
        };
    } catch (e) {
        logger.error(`[ConfigServer] 获取 Bot 信息失败: ${e}`);
        return null;
    }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

const wsClients = new Set();
const authSessions = new Map();
let currentWebPassword = Config.get('web.password') || 'admin';


function cleanupExpiredSessions(now = Date.now()) {
    for (const [token, session] of authSessions.entries()) {
        if ((session?.expiresAt || 0) <= now) {
            authSessions.delete(token);
        }
    }
}

async function getSystemOverview() {
    const [staticInfo, dynamicInfo, botInfo] = await Promise.all([
        getStaticSystemInfo(),
        getDynamicSystemInfo(),
        getBotInfo(),
    ]);

    return {
        static: staticInfo,
        dynamic: dynamicInfo,
        bot: botInfo,
    };
}

async function getSystemRuntime() {
    const [dynamicInfo, botInfo] = await Promise.all([
        getDynamicSystemInfo(),
        getBotInfo(),
    ]);

    return {
        dynamic: dynamicInfo,
        bot: botInfo,
    };
}

function closeAllWsClients(reason = 'Session reset') {
    for (const client of wsClients) {
        try {
            client.close(1008, reason);
        } catch {
        }
    }
    wsClients.clear();
}

function clearAuthSessions(reason = 'Session reset') {
    authSessions.clear();
    closeAllWsClients(reason);
}

function createSessionToken() {
    return `${crypto.randomUUID().replace(/-/g, '')}${crypto.randomBytes(16).toString('hex')}`;
}

function createSession() {
    cleanupExpiredSessions();
    const token = createSessionToken();
    const expiresAt = Date.now() + WEB_SESSION_TTL_MS;
    authSessions.set(token, { expiresAt });
    return { token, expiresAt };
}

function safeCompareText(left, right) {
    const leftBuffer = Buffer.from(String(left ?? ''));
    const rightBuffer = Buffer.from(String(right ?? ''));
    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifySessionToken(token, { touch = false } = {}) {
    if (!token) return null;

    cleanupExpiredSessions();
    const session = authSessions.get(token);
    if (!session) return null;

    if (touch) {
        session.expiresAt = Date.now() + WEB_SESSION_TTL_MS;
    }

    return {
        token,
        expiresAt: session.expiresAt,
    };
}

function getBearerToken(req) {
    const auth = req.headers.authorization;
    if (!auth) return null;
    const match = auth.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
}

function getWsToken(req) {
    try {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        return url.searchParams.get('token');
    } catch {
        return null;
    }
}

function getAllowedOrigin(req) {
    const origin = req?.headers?.origin;
    if (!origin) return null;

    try {
        const originUrl = new URL(origin);
        return originUrl.host === req.headers.host ? origin : null;
    } catch {
        return null;
    }
}

function buildResponseHeaders(req, extraHeaders = {}) {
    const headers = {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...extraHeaders,
    };

    const allowedOrigin = getAllowedOrigin(req);
    if (allowedOrigin) {
        headers['Access-Control-Allow-Origin'] = allowedOrigin;
        headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
        headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
        headers.Vary = 'Origin';
    }

    return headers;
}


function parseBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalSize = 0;
        let settled = false;

        const finishResolve = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        const finishReject = (error) => {
            if (settled) return;
            settled = true;
            reject(error);
        };

        req.on('data', (chunk) => {
            totalSize += chunk.length;
            if (totalSize > MAX_REQUEST_BODY_SIZE) {
                finishReject(new Error('Payload too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                const body = Buffer.concat(chunks).toString('utf8');
                finishResolve(body ? JSON.parse(body) : {});
            } catch {
                finishReject(new Error('Invalid JSON'));
            }
        });
        req.on('error', finishReject);
    });
}

function parseSelfIdParam(url) {
    const raw = url.searchParams.get('selfId');
    if (raw == null || raw === '') return null;
    const selfId = Number(raw);
    return Number.isFinite(selfId) ? selfId : null;
}

function sendJson(res, data, status = 200) {
    res.writeHead(status, buildResponseHeaders(res._sakuraReq, {
        'Content-Type': 'application/json; charset=utf-8',
    }));
    res.end(JSON.stringify(data));
}

function requireAuth(req, res) {
    const token = getBearerToken(req);
    if (!token) {
        sendJson(res, { success: false, error: '未登录' }, 401);
        return false;
    }
    const session = verifySessionToken(token, { touch: true });
    if (!session) {
        sendJson(res, { success: false, error: 'Token 无效' }, 401);
        return false;
    }
    req.authSession = session;
    return true;
}

function parsePluginPath(pathname) {
    const match = pathname.match(/^\/api\/plugins\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
    if (!match) return null;
    const [, pluginName, second, third] = match;

    if (third === 'config') {

        return { pluginName, moduleName: second, action: 'config' };
    }
    if (second === 'schema') {
        return { pluginName, action: 'schema' };
    }
    if (second === 'config') {
        return { pluginName, action: 'allConfig' };
    }

    return { pluginName, action: second || 'info' };
}

async function handleApi(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;


    if (req.method === 'OPTIONS') {
        res.writeHead(204, buildResponseHeaders(req, {
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        }));
        res.end();
        return true;
    }


    if (pathname === '/api/bot/groups' && req.method === 'GET') {
        if (!requireAuth(req, res)) return true;
        try {
            if (!botFacade) {
                sendJson(res, { success: false, error: 'Bot 未连接' });
                return true;
            }
            const selfId = parseSelfIdParam(url);
            const targetBot = selfId != null ? botFacade.getBot?.(selfId) : botFacade;
            if (!targetBot) {
                sendJson(res, { success: false, error: `Account ${selfId} is offline` });
                return true;
            }

            const result = selfId != null
                ? await targetBot.getGroupList()
                : await botFacade.getGroupList();
            const groups = Array.isArray(result) ? result : [];
            const list = groups.map(g => ({
                group_id: g.group_id,
                group_name: g.group_name || String(g.group_id),
                bots: selfId != null
                    ? [{ self_id: selfId, nickname: targetBot.nickname || String(selfId) }]
                    : (g.bots || []),
            }));
            sendJson(res, { success: true, data: list });
        } catch (e) {
            logger.error(`[ConfigServer] 获取群列表失败: ${e}`);
            sendJson(res, { success: false, error: '获取群列表失败' });
        }
        return true;
    }


    if (pathname === '/api/bot/info' && req.method === 'GET') {
        if (!requireAuth(req, res)) return true;
        try {
            const botInfo = await getBotInfo();
            if (!botInfo) {
                sendJson(res, { success: false, error: 'Bot 未连接' });
                return true;
            }
            sendJson(res, { success: true, data: botInfo });
        } catch (e) {
            logger.error(`[ConfigServer] 获取 Bot 信息失败: ${e}`);
            sendJson(res, { success: false, error: '获取 Bot 信息失败' });
        }
        return true;
    }

    // 菜单编辑器 API
    if (pathname === '/api/menu' && req.method === 'GET') {
        if (!requireAuth(req, res)) return true;
        try {
            const yamlPath = path.join(__dirname, '../../plugins/sakura-plugin/resources/menu/menu.yaml');
            if (fs.existsSync(yamlPath)) {
                const fileContent = fs.readFileSync(yamlPath, 'utf8');
                const menuConfig = yaml.load(fileContent) || {};
                sendJson(res, { success: true, data: menuConfig });
            } else {
                sendJson(res, { success: true, data: { menu: [] } });
            }
        } catch (e) {
            logger.error(`[ConfigServer] 获取菜单配置失败: ${e}`);
            sendJson(res, { success: false, error: '获取菜单配置失败' });
        }
        return true;
    }

    if (pathname === '/api/menu' && req.method === 'POST') {
        if (!requireAuth(req, res)) return true;
        try {
            const body = await parseBody(req);
            const yamlPath = path.join(__dirname, '../../plugins/sakura-plugin/resources/menu/menu.yaml');

            // 备份原文件
            if (fs.existsSync(yamlPath)) {
                fs.copyFileSync(yamlPath, yamlPath + '.bak');
            }

            const yamlStr = yaml.dump(body, { lineWidth: -1 });
            fs.writeFileSync(yamlPath, yamlStr, 'utf8');
            sendJson(res, { success: true, message: '菜单保存成功' });
        } catch (e) {
            logger.error(`[ConfigServer] 保存菜单配置失败: ${e}`);
            sendJson(res, { success: false, error: '保存菜单配置失败' });
        }
        return true;
    }

    if (pathname === '/api/system/static' && req.method === 'GET') {
        if (!requireAuth(req, res)) return true;
        try {
            const staticInfo = await getStaticSystemInfo();
            if (!staticInfo) {
                sendJson(res, { success: false, error: '获取系统信息失败' });
                return true;
            }
            sendJson(res, { success: true, data: staticInfo });
        } catch (e) {
            logger.error(`[ConfigServer] 获取静态系统信息失败: ${e}`);
            sendJson(res, { success: false, error: '获取系统信息失败' });
        }
        return true;
    }


    if (pathname === '/api/system/dynamic' && req.method === 'GET') {
        if (!requireAuth(req, res)) return true;
        try {
            const dynamicInfo = await getDynamicSystemInfo();
            if (!dynamicInfo) {
                sendJson(res, { success: false, error: '获取系统信息失败' });
                return true;
            }
            sendJson(res, { success: true, data: dynamicInfo });
        } catch (e) {
            logger.error(`[ConfigServer] 获取动态系统信息失败: ${e}`);
            sendJson(res, { success: false, error: '获取系统信息失败' });
        }
        return true;
    }

    if (pathname === '/api/system/runtime' && req.method === 'GET') {
        if (!requireAuth(req, res)) return true;
        try {
            const runtimeInfo = await getSystemRuntime();
            sendJson(res, {
                success: true,
                data: runtimeInfo,
            });
        } catch (e) {
            logger.error(`[ConfigServer] Failed to get system runtime info: ${e}`);
            sendJson(res, { success: false, error: '获取系统信息失败' });
        }
        return true;
    }


    if (pathname === '/api/system/all' && req.method === 'GET') {
        if (!requireAuth(req, res)) return true;
        try {
            const overview = await getSystemOverview();
            sendJson(res, {
                success: true,
                data: overview,
            });
        } catch (e) {
            logger.error(`[ConfigServer] 获取系统信息失败: ${e}`);
            sendJson(res, { success: false, error: '获取系统信息失败' });
        }
        return true;
    }


    if (pathname === '/api/login' && req.method === 'POST') {
        const body = await parseBody(req);
        const webConfig = Config.get('web') || {};
        const password = webConfig.password || 'admin';

        if (safeCompareText(body.password, password)) {
            const session = createSession();
            sendJson(res, {
                success: true,
                token: session.token,
                expiresAt: session.expiresAt,
                ttlMs: WEB_SESSION_TTL_MS,
            });
        } else {
            sendJson(res, { success: false, error: '密码错误' });
        }
        return true;
    }




    if (pathname === '/api/schema' && req.method === 'GET') {
        if (!requireAuth(req, res)) return true;
        sendJson(res, { success: true, data: Config.getSchema() });
        return true;
    }

    // ===== 分账号基本配置 =====

    if (pathname === '/api/account-schema' && req.method === 'GET') {
        if (!requireAuth(req, res)) return true;
        sendJson(res, { success: true, data: accountConfig.getSchema() });
        return true;
    }

    if (pathname === '/api/account-config' && req.method === 'GET') {
        if (!requireAuth(req, res)) return true;
        const selfId = parseSelfIdParam(url);
        sendJson(res, { success: true, data: accountConfig.getConfig(selfId) });
        return true;
    }

    if (pathname === '/api/account-config' && req.method === 'POST') {
        if (!requireAuth(req, res)) return true;
        const selfId = parseSelfIdParam(url);
        const body = await parseBody(req);
        const result = accountConfig.setConfig(selfId, body.data || body);
        if (result.success) {
            sendJson(res, { success: true, message: '保存成功' });
        } else {
            sendJson(res, { success: false, error: '配置验证失败', errors: result.errors });
        }
        return true;
    }


    if (pathname === '/api/config' && req.method === 'GET') {
        if (!requireAuth(req, res)) return true;
        sendJson(res, {
            success: true,
            data: Config.get(),
            errors: Config.getValidationErrors(),
        });
        return true;
    }


    if (pathname === '/api/config' && req.method === 'POST') {
        if (!requireAuth(req, res)) return true;
        const body = await parseBody(req);
        const result = Config.update(body.data || body);
        if (result.success) {
            sendJson(res, { success: true, message: '保存成功' });
        } else {
            sendJson(res, {
                success: false,
                error: '配置验证失败',
                errors: result.errors,
            });
        }
        return true;
    }





    if (pathname === '/api/dynamic-options' && req.method === 'GET') {
        if (!requireAuth(req, res)) return true;
        try {
            const selfId = parseSelfIdParam(url);
            const dynamicConfig = pluginConfigManager.getDynamicOptionsConfig('sakura-plugin');

            if (!dynamicConfig) {
                sendJson(res, { success: true, data: { config: {}, options: {} } });
                return true;
            }

            const options = {};


            for (const [uiType, config] of Object.entries(dynamicConfig)) {
                const values = [];

                for (const source of config.sources || []) {
                    const moduleConfig = pluginConfigManager.getConfig('sakura-plugin', source.module, { selfId });
                    if (!moduleConfig) continue;

                    const arr = source.path.split('.').reduce((obj, key) => obj?.[key], moduleConfig);
                    if (!Array.isArray(arr)) continue;

                    for (const item of arr) {
                        const value = source.valueKey ? item?.[source.valueKey] : item;
                        if (value && !values.includes(value)) {
                            values.push(value);
                        }
                    }
                }

                options[uiType] = values;
            }

            sendJson(res, {
                success: true,
                data: {
                    config: dynamicConfig,
                    options,
                },
            });
        } catch (e) {
            logger.error(`[ConfigServer] 获取动态选项失败: ${e}`);
            sendJson(res, { success: false, error: '获取动态选项失败' });
        }
        return true;
    }


    if (pathname === '/api/command-names' && req.method === 'GET') {
        if (!requireAuth(req, res)) return true;
        try {
            const schemaPath = path.join(__dirname, '../../plugins/sakura-plugin/configSchema.js');
            const schemaUrl = `file:///${schemaPath.replace(/\\/g, '/')}?t=${Date.now()}`;
            const schemaMod = await import(schemaUrl);
            const autoCommands = Object.values(schemaMod.commandNames || {});
            const manualCommands = schemaMod.manualCommandNames || [];
            const allCommands = [...new Set([...autoCommands, ...manualCommands])];
            sendJson(res, { success: true, data: allCommands });
        } catch (e) {
            logger.error(`[ConfigServer] 获取指令映射失败: ${e}`);
            sendJson(res, { success: false, error: '获取指令映射失败' });
        }
        return true;
    }

    if (pathname === '/api/available-tools' && req.method === 'GET') {
        if (!requireAuth(req, res)) return true;
        try {
            sendJson(res, { success: true, data: AVAILABLE_TOOL_OPTIONS || [] });
        } catch (e) {
            logger.error(`[ConfigServer] 获取可用工具列表失败: ${e}`);
            sendJson(res, { success: false, error: '获取可用工具列表失败' });
        }
        return true;
    }




    if (pathname === '/api/plugins' && req.method === 'GET') {
        if (!requireAuth(req, res)) return true;
        sendJson(res, { success: true, data: pluginConfigManager.getRegisteredPlugins() });
        return true;
    }


    if (pathname.startsWith('/api/plugins/')) {
        if (!requireAuth(req, res)) return true;

        const parsed = parsePluginPath(pathname);
        if (!parsed) {
            sendJson(res, { success: false, error: '无效的路径' }, 400);
            return true;
        }

        const { pluginName, moduleName, action } = parsed;
        const selfId = parseSelfIdParam(url);


        if (action === 'schema' && req.method === 'GET') {
            const metadata = pluginConfigManager.getAllSchemaMetadata(pluginName);
            if (!metadata) {
                sendJson(res, { success: false, error: `插件 ${pluginName} 未注册` }, 404);
            } else {
                sendJson(res, { success: true, data: metadata });
            }
            return true;
        }


        if (action === 'allConfig' && req.method === 'GET') {
            const configs = pluginConfigManager.getAll(pluginName, { selfId });
            if (!configs) {
                sendJson(res, { success: false, error: `插件 ${pluginName} 未注册` }, 404);
            } else {
                sendJson(res, { success: true, data: configs });
            }
            return true;
        }


        if (action === 'config' && moduleName && req.method === 'GET') {
            const config = pluginConfigManager.getConfig(pluginName, moduleName, { selfId });
            if (config === null) {
                sendJson(res, { success: false, error: `模块 ${moduleName} 不存在` }, 404);
            } else {
                sendJson(res, { success: true, data: config });
            }
            return true;
        }


        if (action === 'config' && moduleName && req.method === 'POST') {
            const body = await parseBody(req);
            const result = pluginConfigManager.setConfig(pluginName, moduleName, body.data ?? body, { selfId });
            if (result.success) {

                sendJson(res, { success: true, message: '保存成功' });
            } else {
                sendJson(res, {
                    success: false,
                    error: '配置验证失败',
                    errors: result.errors,
                });
            }
            return true;
        }
    }

    return false;
}



function broadcastPluginConfigChanged(pluginName, moduleName, selfId = null) {
    const config = pluginConfigManager.getConfig(pluginName, moduleName, { selfId });
    broadcastWsMessage({
        type: 'plugin_config_changed',
        pluginName,
        moduleName,
        data: config,
        selfId,
        timestamp: Date.now(),
    });
}

function broadcastWsMessage(payload) {
    const message = typeof payload === 'string' ? payload : JSON.stringify(payload);

    for (const client of wsClients) {
        try {
            if (client.readyState !== 1) {
                continue;
            }
            if (!verifySessionToken(client.sessionToken)) {
                client.close(1008, 'Session expired');
                wsClients.delete(client);
                continue;
            }
            client.send(message);
        } catch {
            wsClients.delete(client);
        }
    }
}


function serveStatic(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = url.pathname;


    let filePath = path.join(PUBLIC_DIR, pathname);

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
    }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
}



export function startConfigServer() {
    const port = Config.get('web.port') || 3457;
    const server = http.createServer(async (req, res) => {
        try {
            res._sakuraReq = req;

            if (req.url.startsWith('/api/')) {
                const handled = await handleApi(req, res);
                if (handled) return;
            }

            // 拦截 /menu，服务独立的菜单编辑器
            const url = new URL(req.url, `http://${req.headers.host}`);
            if (url.pathname === '/menu' || url.pathname === '/menu/') {
                const editorPath = path.join(__dirname, '../../plugins/sakura-plugin/resources/menu/editor.html');
                if (fs.existsSync(editorPath)) {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(fs.readFileSync(editorPath));
                    return;
                }
            }

            serveStatic(req, res);
        } catch (e) {
            logger.error(`[ConfigServer] 请求处理失败: ${e}`);
            sendJson(res, { success: false, error: '服务器内部错误' }, 500);
        }
    });


    const wss = new WebSocketServer({ server });

    wss.on('connection', (ws, req) => {
        const token = getWsToken(req);
        const session = verifySessionToken(token, { touch: true });
        if (!session) {
            ws.close(1008, 'Unauthorized');
            return;
        }

        ws.sessionToken = token;
        ws.authSession = session;
        wsClients.add(ws);
        logger.debug('[ConfigServer] WebSocket 客户端已连接');

        ws.on('close', () => {
            wsClients.delete(ws);
        });

        ws.on('error', (err) => {
            logger.error(`[ConfigServer] WebSocket 错误: ${err}`);
            wsClients.delete(ws);
        });
    });


    Config.onChange((newConfig) => {
        const nextPassword = newConfig?.web?.password || 'admin';
        if (nextPassword !== currentWebPassword) {
            currentWebPassword = nextPassword;
            clearAuthSessions('Password updated');
        }

        broadcastWsMessage({
            type: 'config_changed',
            data: newConfig,
            timestamp: Date.now(),
        });
    });

    const plugins = pluginConfigManager.getRegisteredPlugins();
    for (const pluginName of Object.keys(plugins)) {
        pluginConfigManager.onChange(pluginName, (moduleName, newConfig, meta = {}) => {
            broadcastWsMessage({
                type: 'plugin_config_changed',
                pluginName,
                moduleName,
                data: newConfig,
                selfId: meta.selfId ?? null,
                timestamp: Date.now(),
            });
        });
    }

    server.listen(port, '0.0.0.0', () => {
        logger.info(`[ConfigServer] 配置面板已启动:`);
        logger.info(`  ➜ 本地: http://localhost:${port}`);


        try {
            const nets = os.networkInterfaces();
            for (const name of Object.keys(nets || {})) {
                for (const net of nets[name] || []) {
                    if (net.family === 'IPv4' && !net.internal) {
                        logger.info(`  ➜ 局域网: http://${net.address}:${port}`);
                    }
                }
            }
        } catch (e) {
            logger.warn(`[ConfigServer] 无法获取网卡地址，跳过局域网地址展示: ${e.message || e}`);
        }


        try {
            const req = http.get('http://api.ipify.org', (resp) => {
                let data = '';
                resp.on('data', (chunk) => { data += chunk; });
                resp.on('error', () => {
                    // Ignore public IP probe failures in restricted environments.
                });
                resp.on('end', () => {
                    const ip = data.trim();
                    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
                        logger.info(`  ➜ 公网: http://${ip}:${port}`);
                    }
                });
            });

            req.on('error', () => {
                // Ignore public IP probe failures in restricted environments.
            });


            req.setTimeout(2000, () => {
                req.destroy();
            });
        } catch (e) {
            // Ignore public IP probe failures in restricted environments.
        }
    });

    return server;
}
