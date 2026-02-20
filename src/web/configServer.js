import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import si from 'systeminformation';
import Config from '../core/config.js';
import pluginConfigManager from '../core/pluginConfig.js';
import { logger } from '../utils/logger.js';

let cachedStaticInfo = null;
let staticInfoTime = 0;
const STATIC_INFO_CACHE_TIME = 60000;

async function getStaticSystemInfo() {
    const now = Date.now();
    if (cachedStaticInfo && (now - staticInfoTime) < STATIC_INFO_CACHE_TIME) {
        return cachedStaticInfo;
    }

    try {
        const [
            system,
            bios,
            baseboard,
            chassis,
            osInfo,
            cpu,
            graphics,
            memLayout,
            diskLayout,
            networkInterfaces,
            uuid,
        ] = await Promise.all([
            si.system(),
            si.bios(),
            si.baseboard(),
            si.chassis(),
            si.osInfo(),
            si.cpu(),
            si.graphics(),
            si.memLayout(),
            si.diskLayout(),
            si.networkInterfaces(),
            si.uuid(),
        ]);

        cachedStaticInfo = {
            system,
            bios,
            baseboard,
            chassis,
            os: osInfo,
            cpu,
            graphics,
            memLayout,
            diskLayout,
            networkInterfaces,
            uuid,
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
        const [
            currentLoad,
            mem,
            fsSize,
            networkStats,
            processes,
            battery,
            cpuTemperature,
            cpuCurrentSpeed,
            time,
        ] = await Promise.all([
            si.currentLoad(),
            si.mem(),
            si.fsSize(),
            si.networkStats('*'),
            si.processes(),
            si.battery(),
            si.cpuTemperature(),
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

        const nodeProcess = {
            pid: process.pid,
            memoryUsage: process.memoryUsage(),
            cpuUsage: process.cpuUsage(),
            uptime: process.uptime(),
            version: process.version,
            platform: process.platform,
            arch: process.arch,
        };

        return {
            currentLoad,
            mem,
            fsSize,
            networkStats: networkStatsWithSpeed,
            processes,
            battery,
            cpuTemperature,
            cpuCurrentSpeed,
            time,
            nodeProcess,
        };
    } catch (e) {
        logger.error(`[ConfigServer] 获取动态系统信息失败: ${e}`);
        return null;
    }
}

async function getBotInfo() {
    try {
        const bot = global.bot;
        if (!bot) {
            return null;
        }

        const loginInfo = await bot.getLoginInfo?.() || {};

        return {
            uin: loginInfo.user_id || bot.uin || null,
            nickname: loginInfo.nickname || bot.nickname || null,
            status: bot.status || 'online',
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


function generateToken(password) {
    return Buffer.from(`${password}:sakura_session`).toString('base64');
}

function verifyToken(token) {
    if (!token) return false;
    const webConfig = Config.get('web') || {};
    const expectedPassword = webConfig.password || 'admin';
    return token === generateToken(expectedPassword);
}


function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, data, status = 200) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end(JSON.stringify(data));
}

function requireAuth(req, res) {
    const auth = req.headers.authorization;
    if (!auth) {
        sendJson(res, { success: false, error: '未登录' }, 401);
        return false;
    }
    const token = auth.replace('Bearer ', '');
    if (!verifyToken(token)) {
        sendJson(res, { success: false, error: 'Token 无效' }, 401);
        return false;
    }
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
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        res.end();
        return true;
    }


    if (pathname === '/api/bot/groups' && req.method === 'GET') {
        if (!requireAuth(req, res)) return true;
        try {
            const bot = global.bot;
            if (!bot) {
                sendJson(res, { success: false, error: 'Bot 未连接' });
                return true;
            }
            const result = await bot.getGroupList();
            const groups = Array.isArray(result) ? result : (result?.data || []);
            const list = groups.map(g => ({
                group_id: g.group_id,
                group_name: g.group_name || String(g.group_id),
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


    if (pathname === '/api/system/all' && req.method === 'GET') {
        if (!requireAuth(req, res)) return true;
        try {
            const [staticInfo, dynamicInfo, botInfo] = await Promise.all([
                getStaticSystemInfo(),
                getDynamicSystemInfo(),
                getBotInfo(),
            ]);
            sendJson(res, {
                success: true,
                data: {
                    static: staticInfo,
                    dynamic: dynamicInfo,
                    bot: botInfo,
                },
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

        if (body.password === password) {
            const token = generateToken(password);
            sendJson(res, { success: true, token: token });
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
            const dynamicConfig = pluginConfigManager.getDynamicOptionsConfig('sakura-plugin');

            if (!dynamicConfig) {
                sendJson(res, { success: true, data: { config: {}, options: {} } });
                return true;
            }

            const options = {};


            for (const [uiType, config] of Object.entries(dynamicConfig)) {
                const values = [];

                for (const source of config.sources || []) {
                    const moduleConfig = pluginConfigManager.getConfig('sakura-plugin', source.module);
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
            const configs = pluginConfigManager.getAll(pluginName);
            if (!configs) {
                sendJson(res, { success: false, error: `插件 ${pluginName} 未注册` }, 404);
            } else {
                sendJson(res, { success: true, data: configs });
            }
            return true;
        }


        if (action === 'config' && moduleName && req.method === 'GET') {
            const config = pluginConfigManager.getConfig(pluginName, moduleName);
            if (config === null) {
                sendJson(res, { success: false, error: `模块 ${moduleName} 不存在` }, 404);
            } else {
                sendJson(res, { success: true, data: config });
            }
            return true;
        }


        if (action === 'config' && moduleName && req.method === 'POST') {
            const body = await parseBody(req);
            const result = pluginConfigManager.setConfig(pluginName, moduleName, body.data ?? body);
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



function broadcastPluginConfigChanged(pluginName, moduleName) {
    const config = pluginConfigManager.getConfig(pluginName, moduleName);
    const message = JSON.stringify({
        type: 'plugin_config_changed',
        pluginName,
        moduleName,
        data: config,
        timestamp: Date.now(),
    });

    for (const client of wsClients) {
        try {
            if (client.readyState === 1) {
                client.send(message);
            }
        } catch (e) {

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

            if (req.url.startsWith('/api/')) {
                const handled = await handleApi(req, res);
                if (handled) return;
            }


            serveStatic(req, res);
        } catch (e) {
            logger.error(`[ConfigServer] 请求处理失败: ${e}`);
            sendJson(res, { success: false, error: '服务器内部错误' }, 500);
        }
    });


    const wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
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
        const message = JSON.stringify({
            type: 'config_changed',
            data: newConfig,
            timestamp: Date.now(),
        });

        for (const client of wsClients) {
            try {
                if (client.readyState === 1) {
                    client.send(message);
                }
            } catch (e) {

            }
        }
    });

    const plugins = pluginConfigManager.getRegisteredPlugins();
    for (const pluginName of Object.keys(plugins)) {
        pluginConfigManager.onChange(pluginName, (moduleName, newConfig) => {
            const message = JSON.stringify({
                type: 'plugin_config_changed',
                pluginName,
                moduleName,
                data: newConfig,
                timestamp: Date.now(),
            });
            for (const client of wsClients) {
                try {
                    if (client.readyState === 1) {
                        client.send(message);
                    }
                } catch (e) {

                }
            }
        });
    }

    server.listen(port, '0.0.0.0', () => {
        logger.info(`[ConfigServer] 配置面板已启动:`);
        logger.info(`  ➜ 本地: http://localhost:${port}`);


        const nets = os.networkInterfaces();
        for (const name of Object.keys(nets)) {
            for (const net of nets[name]) {
                if (net.family === 'IPv4' && !net.internal) {
                    logger.info(`  ➜ 局域网: http://${net.address}:${port}`);
                }
            }
        }


        const req = http.get('http://api.ipify.org', (resp) => {
            let data = '';
            resp.on('data', (chunk) => { data += chunk; });
            resp.on('end', () => {
                const ip = data.trim();
                if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
                    logger.info(`  ➜ 公网: http://${ip}:${port}`);
                }
            });
        });

        req.on('error', () => {

        });


        req.setTimeout(2000, () => {
            req.destroy();
        });
    });

    return server;
}
