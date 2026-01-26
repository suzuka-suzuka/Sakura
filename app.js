import { fork, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import net from 'net';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, 'src/index.js');
const CONFIG_PATH = path.join(__dirname, 'config/config.yaml');

async function checkAndStartRedis() {
    let config;
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const fileContents = fs.readFileSync(CONFIG_PATH, 'utf8');
            config = yaml.load(fileContents);
        }
    } catch (e) {
        console.error('[Launcher] 读取配置文件失败:', e);
    }

    const redisConfig = (config && config.redis) || {};
    const port = redisConfig.port || 6379;
    const host = redisConfig.host || '127.0.0.1';
    const execPath = redisConfig.execPath;

    if (!execPath) {
        return;
    }

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
        const redisProcess = spawn(execPath, [], {
            cwd: path.join(__dirname, 'data'),
            stdio: 'ignore',
            detached: true,
            shell: false
        });
        redisProcess.unref();
        await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (e) {
    }
}

let currentChild = null;
let isShuttingDown = false;
let isRestarting = false;  // 标记是否正在重启

function setupSignalHandlers() {
    const signals = ['SIGINT', 'SIGTERM'];
    signals.forEach(signal => {
        process.on(signal, async () => {
            if (isShuttingDown) {
                return;
            }
            isShuttingDown = true;
            
            console.log(`\n收到 ${signal} 信号，正在关闭...`);
            
            if (currentChild && !currentChild.killed) {
                try {
                    // 发送 shutdown 消息给子进程
                    currentChild.send('shutdown');
                } catch (e) {
                    // 如果发送失败，直接终止子进程
                    console.log('无法发送关闭消息，直接终止子进程');
                    currentChild.kill('SIGTERM');
                    process.exit(0);
                    return;
                }
                
                const exitPromise = new Promise((resolve) => {
                    currentChild.once('exit', resolve);
                });
                
                // 给子进程最多 8 秒的时间来优雅关闭
                const timeout = setTimeout(() => {
                    console.log('关闭超时，强制终止子进程');
                    if (currentChild && !currentChild.killed) {
                        currentChild.kill('SIGKILL');
                    }
                    process.exit(0);
                }, 8000);
                
                await exitPromise;
                clearTimeout(timeout);
                console.log('子进程已正常退出');
            }
            
            process.exit(0);
        });
    });
}

setupSignalHandlers();

async function start() {
    await checkAndStartRedis();

    const child = fork(script, [], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
    currentChild = child;

    child.on('message', async (msg) => {
        if (msg === 'restart') {
            isRestarting = true;  // 标记正在重启
            
            // 先发送 shutdown 消息让子进程优雅关闭
            try {
                child.send('shutdown');
            } catch (e) {
                // 忽略发送失败
            }
            
            // 等待子进程退出或超时
            await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    if (child && !child.killed) {
                        child.kill('SIGKILL');
                    }
                    resolve();
                }, 5000);
                
                child.once('exit', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            });
            
            // 重置状态，让 start() 函数重新启动子进程
            currentChild = null;
            isShuttingDown = false;
            isRestarting = false;
            
            // 直接调用 start() 重新启动，而不是创建新的父进程
            // 这样可以保持与终端的连接
            console.log('正在重启...');
            start();
        } else if (msg === 'shutdown') {
            child.kill();
            process.exit(0);
        }
    });

    child.on('exit', (code) => {
        currentChild = null;
        // 如果是正在重启，不要自动重新启动（由 restart 逻辑处理）
        if (isRestarting) {
            return;
        }
        if (code !== 0 && code !== null) {
            setTimeout(start, 3000);
        }
    });
}

start();
