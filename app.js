import fs from 'fs';
import net from 'net';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import path from 'path';
import { spawn, fork } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config/config.yaml');
const script = path.join(__dirname, 'src/index.js');

let currentChild = null;
let restartTimer = null;
let isStopping = false;

async function checkAndStartRedis() {
    let config;
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const fileContents = fs.readFileSync(CONFIG_PATH, 'utf8');
            config = yaml.load(fileContents);
        }
    } catch (e) {
        console.warn('读取配置并启动 Redis 失败:', e.message);
    }

    const redisConfig = (config && config.redis) || {};
    const port = redisConfig.port || 6379;
    const host = redisConfig.host || '127.0.0.1';
    const execPath = redisConfig.execPath;
    const redisDataDir = path.join(__dirname, 'data');

    if (!execPath) {
        return;
    }

    fs.mkdirSync(redisDataDir, { recursive: true });

    const isRunning = await new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(500);
        socket.on('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });
        socket.on('error', () => {
            socket.destroy();
            resolve(false);
        });
        socket.connect(port, host);
    });

    if (isRunning) {
        return;
    }

    try {
        console.log(`正在启动 Redis (${execPath})...`);
        const redisProcess = spawn(execPath, [], {
            cwd: redisDataDir,
            stdio: 'ignore',
            detached: true,
            shell: false
        });
        redisProcess.unref();
        await new Promise((resolve) => setTimeout(resolve, 2000));
        console.log('Redis 启动完成');
    } catch (e) {
        console.warn('Redis 启动进程出错:', e.message);
    }
}

async function start() {
    await checkAndStartRedis();
    startBot();
}

function clearRestartTimer() {
    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }
}

function scheduleRestart(delay) {
    clearRestartTimer();
    restartTimer = setTimeout(() => {
        restartTimer = null;
        startBot();
    }, delay);
}

function requestChildShutdown(reason = 'shutdown') {
    const child = currentChild;
    if (!child) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        let settled = false;

        const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
        };

        const forceKillTimer = setTimeout(() => {
            if (!child.killed) {
                child.kill('SIGKILL');
            }
            finish();
        }, 5000);

        child.once('exit', () => {
            clearTimeout(forceKillTimer);
            finish();
        });

        try {
            if (child.connected) {
                child.send('shutdown');
            } else {
                child.kill('SIGTERM');
            }
        } catch {
            try {
                child.kill('SIGTERM');
            } catch {
                clearTimeout(forceKillTimer);
                finish();
            }
        }

        console.log(`收到 ${reason}，正在关闭子进程...`);
    });
}

async function shutdownApp(reason) {
    if (isStopping) {
        return;
    }

    isStopping = true;
    clearRestartTimer();

    try {
        await requestChildShutdown(reason);
    } finally {
        process.exit(0);
    }
}

function startBot() {
    const child = fork(script, [], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
    currentChild = child;

    child.on('message', (msg) => {
        if (msg === 'shutdown') {
            shutdownApp('child shutdown request').catch((err) => {
                console.error('关闭主进程失败:', err);
                process.exit(1);
            });
        }
    });

    child.on('exit', (code) => {
        if (currentChild === child) {
            currentChild = null;
        }

        if (isStopping) {
            return;
        }

        if (code !== 0 && code !== null) {
            console.error('子进程异常退出，3秒后自动重启...');
            scheduleRestart(3000);
        } else {
            console.log('子进程正常退出，2秒后自动重启...');
            scheduleRestart(2000);
        }
    });
}

process.on('SIGINT', () => {
    shutdownApp('SIGINT').catch((err) => {
        console.error('SIGINT 退出失败:', err);
        process.exit(1);
    });
});

process.on('SIGTERM', () => {
    shutdownApp('SIGTERM').catch((err) => {
        console.error('SIGTERM 退出失败:', err);
        process.exit(1);
    });
});

start().catch((err) => {
    console.error('启动失败:', err);
    process.exit(1);
});
