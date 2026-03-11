import { exec } from 'child_process';
import process from 'process';

// 获取命令行参数中的命令
const cmd = process.argv.slice(2).join(' ');

if (!cmd) {
    console.error('请提供要执行的命令，例如: node exec_gbk.js "ping google.com"');
    process.exit(1);
}

console.log(`正在执行: ${cmd}`);

// 默认 Windows 使用 gbk，其他系统使用 utf-8
// 注意：如果你的 Windows 终端已经设置了 chcp 65001，这里可能需要改成 utf-8
// 但通常默认 cmd 环境是 gbk
const encoding = process.platform === 'win32' ? 'gbk' : 'utf-8';
const decoder = new TextDecoder(encoding);

const child = exec(cmd, { encoding: 'buffer' });

child.stdout.on('data', (data) => {
    process.stdout.write(decoder.decode(data));
});

child.stderr.on('data', (data) => {
    process.stderr.write(decoder.decode(data));
});

child.on('close', (code) => {
    console.log(`\n命令执行完毕，退出码: ${code}`);
});
