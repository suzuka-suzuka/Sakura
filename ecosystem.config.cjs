// PM2 配置。一个进程只服务一个 QQ 号，多个号就开多个实例，共用这份代码。
//
// 没有 instances.json 时只有一个实例 sakura-bot，home 是项目根目录（和以前一样）。
// 要多开就在项目根目录放 instances.json（已 gitignore），每项一个实例：
//   [
//     { "name": "sakura-bot" },
//     { "name": "sakura-2", "home": "instances/sakura-2" }
//   ]
// home 是这个实例的配置/数据/日志目录（SAKURA_HOME），相对路径按项目根目录算；
// 不写 home 就用项目根目录，最多只能有一个实例这样。
// 新实例的目录用 node scripts/split-instance.mjs 生成，见 docs/multi-instance.md。

const fs = require('fs');
const path = require('path');

const INSTANCES_FILE = path.join(__dirname, 'instances.json');

function readInstances() {
    if (!fs.existsSync(INSTANCES_FILE)) {
        return [{ name: 'sakura-bot', home: __dirname }];
    }

    const list = JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf8'));
    if (!Array.isArray(list) || list.length === 0) {
        throw new Error('instances.json 必须是非空数组');
    }

    const names = new Set();
    const homes = new Set();
    return list.map((item, index) => {
        const name = String(item?.name || '').trim();
        if (!name) throw new Error(`instances.json 第 ${index + 1} 项缺少 name`);
        if (names.has(name)) throw new Error(`instances.json 里实例名重复: ${name}`);
        names.add(name);

        const home = path.resolve(__dirname, String(item.home || '').trim() || '.');
        if (homes.has(home)) throw new Error(`instances.json 里有两个实例共用目录: ${home}`);
        homes.add(home);

        return { name, home };
    });
}

const instances = readInstances();

module.exports = {
    apps: instances.map(({ name, home }) => ({
        name,
        script: './app.js',
        cwd: __dirname,
        watch: false,
        autorestart: true,
        restart_delay: 3000,
        min_uptime: '10s',
        max_restarts: 1,
        max_memory_restart: '1G',
        env: {
            NODE_ENV: 'production',
            SAKURA_MANAGED_BY_PM2: '1',
            SAKURA_INSTANCE: name,
            SAKURA_HOME: home,
        },
    })),
};
