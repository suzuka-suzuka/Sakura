# 多个号：一号一实例

一个 Sakura 进程只服务一个 QQ 号。要跑多个号，就开多个实例：共用同一份代码，每个实例有自己的目录（`SAKURA_HOME`），里面放这个号的配置、数据和日志。

以前是一个进程连多个号，靠"当前事件是哪个号"在配置、定时任务、存储、发消息每一层分别区分。这样做的问题：

- 配置读哪份要看当前在线几个号，有号掉线时会悄悄换成另一份；
- 两个号在同一个群时，一条指令会被处理两次；
- 全局维护的定时任务会按在线号数重复跑；
- 各插件自己决定状态带不带账号，规则不统一。

拆成独立实例后，这些都不存在了：`bot` 就是这个实例的号，配置只有一份，每个定时任务只跑一次。

## 实例目录

```
<home>/config/                配置（config.yaml、插件配置）
<home>/data/                  框架运行数据（软关机状态、面板会话、自动启动的 Redis 工作目录）
<home>/logs/                  日志
<home>/temp/                  临时文件
<home>/plugins/<插件>/data/   插件数据（SQLite、图片、缓存……）
```

不设 `SAKURA_HOME` 时，home 就是项目根目录，目录结构和以前完全一样。已有的部署不用改动就能继续跑。

## 实例列表：instances.json

项目根目录下的 `instances.json`（已 gitignore）列出所有实例，`ecosystem.config.cjs` 据此生成 PM2 进程：

```json
[
  { "name": "sakura-bot" },
  { "name": "sakura-2", "home": "instances/sakura-2" }
]
```

- `name` 是 PM2 进程名，也是 `SAKURA_INSTANCE` 环境变量的值；
- `home` 是实例目录，相对路径按项目根目录算；不写就是项目根目录，最多一个实例这样写；
- 没有这个文件时只有一个实例 `sakura-bot`，和以前一样。

常用命令：

```bash
pm2 start ecosystem.config.cjs                  # 启动全部实例（pnpm start）
pm2 start ecosystem.config.cjs --only sakura-2  # 只启动一个
pm2 stop ecosystem.config.cjs                   # 停止全部（pnpm stop）
pm2 logs sakura-2                               # 看某个实例的日志
```

`#更新` 拉的是共用的代码，所以更新后会把其余正在运行的实例一起重启；手动停掉的实例不会被拉起来。

## 每个实例必须分开的设置

| 设置 | 为什么 |
|---|---|
| `ws` 连接 | 每个实例只连自己那个号。别的号连上来时，它的事件会被忽略，日志里会报错提示 |
| `web.port` | 配置面板端口 |
| `redis.db` | Redis 里的冷却、锁、会话不带实例前缀，共用一个 Redis 时必须用不同的 db |
| 反向连接端口 `ws.reverse[].port` | 端口不能重复 |
| `PrivateChat.webPort` / `publicUrl` | 私聊 AI 设置页面的端口和对外地址 |

## 从旧的多号部署迁移

旧版留下的分账号配置：

- `config/account/<QQ>.yaml`、`config/account/default.yaml`：主人和黑白名单
- `config/<插件>/_accounts/<QQ>/`：插件配置

新代码启动时，如果 `config.yaml` 里还没有主人和黑白名单，会先从 `config/account/default.yaml` 搬过来，所以只有一个号时什么都不用做。某个号自己的那份（`<QQ>.yaml` 和 `_accounts/<QQ>/`）不会自动采用，号上线时日志会提醒，用 `scripts/split-instance.mjs` 处理。

假设原来一个进程跑 A、B 两个号，拆完后 A 留在原来的目录，B 单独开一个实例：

```bash
# 0. 看看哪些号留着旧配置（服务器上跑过的版本已经把配置格式迁移好了，直接拆即可）
node scripts/split-instance.mjs list

# 1. 给 B 建实例：复制当前配置、套上 B 自己的那份、复制数据、登记到 instances.json
#    --dry-run 先预演；复制数据时建议先停掉 bot
node scripts/split-instance.mjs create --self <B的QQ> --name sakura-2 --copy-data --dry-run
node scripts/split-instance.mjs create --self <B的QQ> --name sakura-2 --copy-data

# 2. 原目录只服务 A：把 A 自己的那份旧配置并进来
node scripts/split-instance.mjs merge --self <A的QQ> --reset-cleanup-accounts

# 3. 按 create 打印的清单改连接和端口，然后启动
pm2 start ecosystem.config.cjs
```

说明：

- `create` 会自动给新实例换一个没用过的面板端口和 Redis db，其余要改的设置会在最后列出来。
- `--copy-data` 会把插件数据整份复制到新实例。SQLite 用在线备份复制；复制出的库里，数据清理只认新号，所以新号不在的群会在下一轮核对时从这份副本里清掉，原实例的库不受影响。
- `merge --reset-cleanup-accounts` 让原实例的数据清理不再等已经搬走的号。不加这个参数时，原实例只清理离群成员，整群清理会一直跳过，每天在日志里提示一次。**只有确认 B 的数据已经复制到新实例后才加这个参数**，否则原实例会删掉只有 B 在的群的数据。
- 覆盖或移走的文件都备份在 `<home>/data/split-backup-<时间>/`。

拆开之后，掉线通知只能走掉线的号自己发送；以前一个号掉线时可以借另一个在线的号通知主人，现在不行了。
