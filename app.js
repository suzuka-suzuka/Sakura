import { fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, 'src/index.js');

function start() {
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
