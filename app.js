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

async function start() {
    await checkAndStartRedis();

    const child = fork(script, [], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });

    child.on('message', (msg) => {
        if (msg === 'restart') {
            child.kill();
            setTimeout(start, 1000);
        } else if (msg === 'shutdown') {
            child.kill();
            process.exit(0);
        }
    });

    child.on('exit', (code) => {
        if (code !== 0 && code !== null) {
            setTimeout(start, 3000);
        }
    });
}

start();
