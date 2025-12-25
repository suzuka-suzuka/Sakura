import { fork, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import net from 'net';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, 'src/index.js');
const CONFIG_PATH = path.join(__dirname, 'config/config.yaml');

const isHardRestart = process.argv.includes('--hard-restart');
if (isHardRestart) {
    const args = process.argv.slice(2).filter(arg => arg !== '--hard-restart');
    process.argv = [process.argv[0], process.argv[1], ...args];
}

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

function setupSignalHandlers() {
    const signals = ['SIGINT', 'SIGTERM'];
    signals.forEach(signal => {
        process.on(signal, () => {
            if (currentChild) {
                currentChild.send('shutdown');
                setTimeout(() => {
                    if (currentChild && !currentChild.killed) {
                        currentChild.kill('SIGKILL');
                    }
                    process.exit(0);
                }, 3000);
            } else {
                process.exit(0);
            }
        });
    });
}

setupSignalHandlers();

async function start() {
    await checkAndStartRedis();

    const child = fork(script, [], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
    currentChild = child;

    child.on('message', (msg) => {
        if (msg === 'restart') {
            child.kill();
            setTimeout(() => {
                const args = [process.argv[1], '--hard-restart', ...process.argv.slice(2)];
                const newProcess = spawn(process.argv[0], args, {
                    cwd: process.cwd(),
                    stdio: 'inherit',
                    detached: true,
                    shell: false
                });
                newProcess.unref();
                process.exit(0);
            }, 500);
        } else if (msg === 'shutdown') {
            child.kill();
            process.exit(0);
        }
    });

    child.on('exit', (code) => {
        currentChild = null;
        if (code !== 0 && code !== null) {
            setTimeout(start, 3000);
        }
    });
}

start();
