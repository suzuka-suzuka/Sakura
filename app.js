import fs from 'fs';
import net from 'net';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import path from 'path';
import { spawn, fork } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config/config.yaml');
const script = path.join(__dirname, 'src/index.js');
const IS_PM2_MANAGED = process.env.SAKURA_MANAGED_BY_PM2 === '1';
const MAX_UNEXPECTED_RESTARTS = 1;

let currentChild = null;
let restartTimer = null;
let isStopping = false;
let restartRequested = false;
let unexpectedRestartCount = 0;

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

function exitParentWithChildStatus(code, signal = null) {
    const exitCode = Number.isInteger(code) ? code : 1;
    const signalText = signal ? ` [signal: ${signal}]` : '';
    console.error(`子进程已退出，父进程同步退出${signalText} [code: ${exitCode}]`);
    process.exit(exitCode);
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
            return;
        }

        if (msg === 'restart') {
            restartRequested = true;
        }
    });

    child.on('exit', (code, signal) => {
        if (currentChild === child) {
            currentChild = null;
        }

        if (isStopping) {
            return;
        }

        if (restartRequested) {
            restartRequested = false;
            unexpectedRestartCount = 0;

            if (IS_PM2_MANAGED) {
                console.log('收到重启请求，交给 PM2 拉起主进程...');
                process.exit(0);
            }

            console.log('收到重启请求，2秒后拉起子进程...');
            scheduleRestart(2000);
            return;
        }

        if (IS_PM2_MANAGED) {
            exitParentWithChildStatus(code, signal);
            return;
        }

        if (code === 0) {
            console.log('子进程正常退出，父进程不再自动重启。');
            process.exit(0);
        }

        if (unexpectedRestartCount < MAX_UNEXPECTED_RESTARTS) {
            unexpectedRestartCount += 1;
            console.error(`子进程异常退出，准备进行第 ${unexpectedRestartCount} 次也是最后一次自动重启...`);
            scheduleRestart(3000);
            return;
        }

        console.error('子进程再次异常退出，已达到最大自动重启次数，停止拉起。');
        exitParentWithChildStatus(code, signal);
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
