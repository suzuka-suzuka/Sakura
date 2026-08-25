# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

Sakura is a QQ bot framework on Node.js (ESM). It connects to a QQ client over OneBot v11 (forward or reverse WebSocket) or Milky, loads plugins dynamically, and stores state in Redis. A web config panel ships with it.

Node 20+, pnpm 9+, Redis 6+, and a Chrome/Chromium for Puppeteer are all required — image rendering (menus, cards, game boards) is used pervasively, not optionally.

## Commands

```bash
node app.js                 # dev run (parent process; auto-restarts the child on crash)
pnpm dev                    # same thing
pnpm start                  # production via PM2
pnpm stop / pnpm log        # PM2 stop / tail logs

pnpm install                # workspace install: root + plugins/* + web frontend

node --test                 # whole test suite
node --test test/foo.test.js   # one file
node test/foo.test.js        # one file, raw output (easier to read failures)

pnpm web:dev / web:build / web:lint   # config panel frontend (src/web/frontend)
```

There is no linter for backend code and no build step for the bot. Only the frontend has a Vite build and ESLint.

**`test/` and `AGENTS.md` are gitignored on purpose** (`# Local-only tests`). A fresh clone has no test suite — don't conclude the project is untested, and don't expect test edits to reach the remote. Tests that must survive a clone belong in a plugin's own `scripts/` (which is tracked), with a thin `test/*.test.mjs` shelling out to them.

**Tests need Redis running.** Without it a large block of tests (monopoly session store and friends) fails on connection refused — check `redis-cli ping` before assuming you broke something.

**Puppeteer uses the system Chrome**, not a bundled download: `.puppeteerrc.cjs` probes the usual install paths and sets `executablePath`. If rendering fails on a new machine, install Chrome/Chromium rather than re-running the Puppeteer download.

## Architecture

### Process model

`app.js` (parent) → `fork()` → `src/index.js` (child worker). The parent starts Redis and restarts the child on crash; the child runs all bot logic. `"shutdown"` IPC coordinates graceful exit.

### Core (`src/`)

- **`core/loader.js`** — discovers plugins, instantiates them, registers handlers (regex commands, event listeners, cron jobs), dispatches events by priority. Hot-reloads via chokidar.
- **`core/plugin.js`** — base `plugin` class and the `Command` / `OnEvent` / `Cron` decorators. Multi-step conversations use `setContext`/`finish`/`getContext` over `AsyncLocalStorage`.
- **`core/event.js`** — wraps raw OneBot events; proxies unknown property access to the bot API. Convenience methods (`reply`, `recall`, `sendForwardMsg`…) and computed props (`msg`, `at`, `isMaster`).
- **`api/client.js`** — `OneBotApi` maps camelCase methods to snake_case OneBot calls via Proxy. Also `Segment`, `Group`, `Friend`.
- **`adapters/milkyClient.js`** — OneBot v11 → Milky API name mapping, for Milky-based clients.
- **`core/config.js` / `configSchema.js`** — singleton framework config from `config/config.yaml`, Zod-validated, missing fields auto-synced, hot-reloaded.
- **`core/pluginConfig.js`** — per-plugin config. A plugin ships a `configSchema.js`; YAML under `config/<plugin>/` is generated, validated and hot-reloaded from it.
- **`core/economyHook.js`** — handlers can declare a charge; the framework checks balance and refunds on failure, so plugins don't each reimplement it.
- **`core/pluginScope.js`** — scope keys (per group / per account) that plugins use to key their state.

### Plugin system

Plugins live in `plugins/`. A plugin dir may have `index.js` (can be empty — its presence triggers directory loading), `apps/*.js` (feature modules exporting classes extending `plugin`), `configSchema.js`, and `lib/`.

```js
export class MyPlugin extends plugin {
  constructor() { super({ name: "my-plugin", priority: 1000 }) }
  myCmd = Command(/^#hello$/, async (e) => { ... })
  onJoin = OnEvent("notice.group_increase", async (e) => { ... })
  daily = Cron("0 8 * * *", async () => { ... })
}
```

Handlers run in priority order (lower = earlier). **Returning `false` passes through to the next handler; any other return stops the chain.** Permission levels: `"master"`, `"white"`.

Globals injected onto `global`: `logger`, `Command`, `OnEvent`, `Cron`, `plugin`, `Event`, `segment`, `bot`, `redis`. Plugin code uses these without importing.

### Repo layout note

`plugins/sakura-plugin` is **part of this repository**, not a separate clone. `.gitignore` ignores `plugins/*` but explicitly re-includes `plugins/system/` and `plugins/sakura-plugin/**`. Ignore rules for plugin files therefore belong in the root `.gitignore` and do take effect.

### sakura-plugin subsystems

The main plugin is large; each subsystem in `lib/` is self-contained with its command layer in `apps/`:

| `lib/` | What it is |
|---|---|
| `AIUtils/` | AI chat with tool-calling; tools in `AIUtils/tools/` (search, image gen, memory, music, shell…) |
| `monopoly/` | Full board game — engine, map validator, renderers, session store |
| `economy/`, `fishing/` | Currency, shop, fishing game |
| `ba/` | Blue Archive 4v4 turn-based PvP (see below) |
| `flychess/`, `favorability/`, `sign/`, `sleep/` | Smaller game/social systems |
| `pixiv/`, `imageSearch/`, `nai/` | Pixiv, reverse image search (SauceNAO / ascii2d / Google Lens), NovelAI |

### Image rendering

Two approaches coexist. Newer code renders **HTML in a persistent headless Chromium** and screenshots an element (see `lib/ba/browser.js` for the singleton pattern); older code draws with `@napi-rs/canvas`. Prefer HTML for anything new — layout in CSS beats hand-computed coordinates. Note `page.setContent`'s base URL is `about:blank`, so images and fonts must be inlined as base64 data URIs.

### Blue Archive battle (`lib/ba/`)

Stats, skills and combat formulas are **copied from the original game**, generated from SchaleDB data — never hand-tuned. `roster.js` is a generated artifact; edit `scripts/emit-roster.mjs` and regenerate. A dedicated skill at `.Codex/skills/ba-battle/SKILL.md` documents the conversion rules, official formulas, targeting rules and rendering conventions — **read it before touching this subsystem**.

```bash
cd plugins/sakura-plugin
node scripts/emit-roster.mjs    # regenerate roster.js after editing the IDS array
node scripts/fetch-art.mjs      # download official art (gitignored, must be fetched per-machine)
node scripts/stress-test.mjs    # invariant fuzz over random battles
node scripts/target-test.mjs    # targeting-rule regression
```

Official art under `resources/ba/characters/*/` is gitignored on purpose; a fresh checkout renders placeholder shapes until `fetch-art.mjs` runs.

## Conventions

- ESM everywhere (`"type": "module"`). `import`/`export`, not `require`.
- Chinese for log messages, comments and user-facing text.
- Zod v4 for config schemas; descriptions follow a `label|#uiType|help` convention consumed by the web panel.
- YAML config via `js-yaml`.
- pnpm workspace — one `pnpm-lock.yaml` at the root covers root, plugins and frontend.
- `plugins/system/` holds built-in framework plugins (admin commands, permission management).
