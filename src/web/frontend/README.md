# Sakura Web

Sakura 的 React + Vite 配置面板。该目录是根 pnpm workspace 的独立包，依赖统一由仓库根目录的 `pnpm-lock.yaml` 管理。

在 Sakura 根目录运行：

```bash
pnpm install
pnpm web:dev
```

代码检查和生产构建：

```bash
pnpm web:lint
pnpm web:build
```

开发服务器会把 `/api` 和 `/ws` 代理到 `http://localhost:3457`。生产构建输出到 `src/web/public`，由 Sakura 后端直接提供。
