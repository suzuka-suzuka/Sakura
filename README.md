# Sakura Bot

Sakura 是一个基于 Node.js 的 QQ 机器人框架，支持 OneBot 正向/反向 WebSocket、Milky 适配、插件热加载、Redis 状态存储、PM2 守护运行，以及内置 Web 配置面板。

## 主要能力

- 多连接支持：OneBot 正向 WebSocket、反向 WebSocket、Milky HTTP/WebSocket。
- 插件系统：自动加载 `plugins/*/apps` 下的插件类，支持 `Command`、`OnEvent`、`Cron`。
- 配置面板：启动后提供 Web UI，可编辑框架配置、账号配置、插件配置和菜单。
- 经济扣费钩子：插件 handler 可声明扣费配置，由框架统一检查和退款。
- Redis 状态：会话、上下文、定时任务、插件状态等依赖 Redis。
- PM2 运行：提供生产环境启动、停止和日志脚本。

## 环境要求

- Node.js 20 或更高版本，建议使用当前 LTS。
- pnpm 9 或更高版本。
- Redis 6 或更高版本。
- Chrome / Chromium，用于 Puppeteer 截图渲染菜单、画像、卡片等图片。
- 一个兼容 OneBot 或 Milky 的 QQ 客户端，例如 NapCat、Lagrange、其他 OneBot 实现。

Windows 需要确保原生依赖能正常安装。若 `better-sqlite3`、`sharp`、`canvas`、`muhammara` 安装失败，请先安装对应系统编译环境，或使用项目锁定的 pnpm 依赖重新安装。

## 安装

```bash
git clone <your-repo-url> Sakura
cd Sakura
pnpm install
```

本仓库使用 pnpm workspace，`plugins/*` 下的插件依赖会一起安装。

如果没有 pnpm：

```bash
npm install -g pnpm
```

## 基础配置

主配置文件位于：

```text
config/config.yaml
```

常用字段：

```yaml
logLevel: info
blockPrivate: true
ws:
  forward:
    - name: napcat
      enable: true
      url: ws://127.0.0.1:3001
      accessToken: ''
      reconnectDelay: 5000
      heartbeatInterval: 30000
  reverse:
    - name: reverse
      enable: false
      port: 3002
      accessToken: ''
  milky:
    - name: milky
      enable: false
      url: http://127.0.0.1:3000
      accessToken: ''
redis:
  host: 127.0.0.1
  port: 6379
  password: ''
  db: 0
  execPath: ''
web:
  port: 3457
  password: admin
```

说明：

- `ws.forward`：框架主动连接 OneBot 客户端的 WebSocket 地址。
- `ws.reverse`：框架监听端口，等待 OneBot 客户端反向连接。
- `ws.milky`：Milky 适配配置。
- `redis.execPath`：可选。填写 Redis 可执行文件路径后，框架启动时会尝试自动拉起 Redis。
- `web.port` / `web.password`：配置面板端口和登录密码。首次部署后请立刻修改默认密码。

账号级配置位于：

```text
config/account/<self_id>.yaml
```

插件配置位于：

```text
config/<plugin-name>/*.yaml
```

## 启动

开发方式：

```bash
pnpm dev
```

生产方式：

```bash
pnpm start
pnpm log
```

停止：

```bash
pnpm stop
```

启动成功后，访问配置面板：

```text
http://localhost:3457
```

端口以 `config/config.yaml` 中的 `web.port` 为准。

## OneBot 客户端对接

以 NapCat 正向 WebSocket 为例：

1. 在 NapCat 中开启 WebSocket 服务，例如 `ws://127.0.0.1:3001`。
2. 如果设置了 Access Token，保持 NapCat 和 `config/config.yaml` 中一致。
3. 在 Sakura 中启用 `ws.forward` 并填写对应地址。
4. 启动 Sakura，日志中出现 WebSocket 连接成功和 Bot 实例初始化即表示接入成功。

反向 WebSocket 则需要：

1. Sakura 配置 `ws.reverse[].enable: true` 和监听端口。
2. OneBot 客户端配置反向连接到 `ws://<Sakura地址>:<port>`。

## 配置面板

配置面板提供：

- 系统监控。
- 框架配置编辑。
- 账号配置编辑。
- 插件配置编辑。
- 动态选项，例如群号、角色、渠道、工具组。
- 指令扣费配置。
- 菜单查看和菜单配置相关接口。

配置保存后会写入 `config/` 目录，并通过 WebSocket 同步前端状态。

## 插件开发简要说明

插件文件放在：

```text
plugins/<plugin-name>/apps/*.js
```

一个最小插件：

```js
export class HelloPlugin extends plugin {
  constructor() {
    super({
      name: 'Hello',
      event: 'message',
      priority: 50,
    });
  }

  hello = Command(/^#hello$/, async (e) => {
    await e.reply('hello');
    return true;
  });
}
```

常用注册器：

- `Command(reg, handler)`：正则指令。
- `Command(reg, 'master', handler)`：主人权限。
- `Command(reg, 'white', handler)`：白名单权限。
- `OnEvent(eventName, handler)`：事件监听。
- `Cron(cronExpression, handler)`：定时任务。

扣费示例：

```js
handler = Command(/^#demo$/, {
  economy: {
    command: '演示指令',
    refundOnFalse: true,
  },
}, async (e) => {
  return true;
});
```

扣费名称需要出现在插件的 `configSchema.js` 中，并由经济配置里的 `commandCosts` 设置价格。

## 常见问题

### Redis 连接失败

确认 Redis 已启动，或在 `config/config.yaml` 中正确填写 `redis.host`、`redis.port`、`redis.password`。如果想由框架自动启动 Redis，填写 `redis.execPath`。

### Puppeteer 截图失败

确认系统安装了 Chrome 或 Chromium。项目的 `.puppeteerrc.cjs` 会自动查找常见安装路径，也可以通过系统环境保证 Chrome 可用。

### 配置面板打不开

确认机器人进程正常运行，查看 `web.port` 是否被占用。默认地址是 `http://localhost:3457`。

### 插件没有加载

确认插件位于 `plugins/<plugin-name>/apps`，插件文件导出了继承 `plugin` 的 class，并且依赖安装完成。

## 目录结构

```text
Sakura/
  app.js                     # 父进程和 Redis 自动启动入口
  src/                       # 框架核心、WebSocket、插件加载器、配置面板服务
  config/                    # 框架、账号、插件配置
  plugins/                   # 插件目录
  data/                      # Redis 数据、运行数据等
  logs/                      # 运行日志
  temp/                      # 临时文件
```
