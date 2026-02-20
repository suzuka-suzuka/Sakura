import fs from 'fs';
import net from 'net';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import path from 'path';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config/config.yaml');

async function checkAndStartRedis() {
    let config;
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const fileContents = fs.readFileSync(CONFIG_PATH, 'utf8');
            config = yaml.load(fileContents);
        }
    } catch (e) {
        console.warn('读取配置并启动Redis失败:', e.message);
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
        console.log(`正在启动 Redis (${execPath})...`);
        const redisProcess = spawn(execPath, [], {
            cwd: path.join(__dirname, 'data'),
            stdio: 'ignore',
            detached: true,
            shell: false
        });
        redisProcess.unref();
        await new Promise(resolve => setTimeout(resolve, 2000));
        console.log(`Redis 启动完成`);
    } catch (e) {
        console.warn(`Redis 启动进程出错:`, e.message);
    }
}

const script = path.join(__dirname, 'src/index.js');

async function start() {
    // 启动必需的前置服务
    await checkAndStartRedis();

    startBot();
}

function startBot() {
    // 使用 fork 单独启动业务文件，以便捕获其崩溃或重启命令
    // fork 已经在头部导入了，直接使用 child_process.fork
    import('child_process').then(({ fork }) => {
        const child = fork(script, [], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });

        child.on('message', (msg) => {
            if (msg === 'shutdown') {
                console.log('收到关机指令，主进程即将退出。');
                child.kill();
                process.exit(0);
            }
        });

        child.on('exit', (code) => {
            if (code !== 0 && code !== null) {
                console.error(`子进程异常退出，3秒后自动重启...`);
                setTimeout(startBot, 3000);
            } else {
                console.log(`子进程正常退出，执行完全重启操作...`);
                setTimeout(startBot, 2000);
            }
        });
    });
}

start().catch(err => {
    console.error('启动失败:', err);
    process.exit(1);
});
