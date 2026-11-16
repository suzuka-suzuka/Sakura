# AGENTS.md

This file provides guidance to Codex when working with code in this repository.

## Project Overview

Sakura is a QQ bot framework on Node.js (ESM). It connects to one or more QQ clients over OneBot v11 (forward or reverse WebSocket) or Milky, loads plugins dynamically, and ships a React web config panel. Persistent state lives in SQLite; Redis is the TTL/cache layer.

Node 20+, pnpm 9+, Redis 6+, and a Chrome/Chromium for Puppeteer are all required — image rendering (menus, cards, game boards) is used pervasively, not optionally.

The live bot runs on a remote server, not this machine. Local edits don't touch the running instance, so there's no need to remind anyone to restart after a change.

## Commands

```bash
node app.js                 # dev run (parent process + child worker)
pnpm dev                    # same thing
pnpm start                  # production via PM2 (ecosystem.config.cjs)
pnpm stop / pnpm log        # PM2 stop / tail logs

pnpm install                # workspace install: root + plugins/* + web frontend

node --test                 # whole test suite
node --test test/foo.test.js   # one file
node test/foo.test.js        # one file, raw output (easier to read failures)

pnpm web:dev / web:build / web:lint   # config panel frontend (src/web/frontend, React 19 + Vite)
node scripts/panel-preview.mjs <pwd>  # panel backend only — no QQ connection, no plugin logic
```

`.claude/launch.json` (Claude Code preview config) defines `panel-backend` (port 3457) and `panel-frontend` (Vite, 5173) for previewing the panel.

There is no linter for backend code and no build step for the bot. Only the frontend has a Vite build and ESLint.

### Testing caveats

- **The test suite is deliberately small.** Only tests guarding costly invariants are kept: fishing encounter generation (`plugins/sakura-plugin/scripts/test-fishing-encounters.mjs`), group data cleanup (`test-group-data-cleanup.mjs`, it deletes player data), and fishing balance (`test/fishing-balance.test.js`). Don't add a test for every small fix; verify one-off changes directly instead.
- **`test/` is gitignored on purpose** (so is `CLAUDE.md`). Tests that must survive a clone belong in `plugins/sakura-plugin/scripts/` (tracked).
- **Puppeteer uses the system Chrome**, not a bundled download: `.puppeteerrc.cjs` probes the usual install paths and sets `executablePath`. If rendering fails on a new machine, install Chrome/Chromium rather than re-running the Puppeteer download.

## Architecture

### Process model

`app.js` (parent) → `fork()` → `src/index.js` (child worker); the child runs all bot logic.

- The parent starts Redis only if `redis.execPath` is set in `config/config.yaml` and nothing is listening yet.
- Restart policy: an unexpected crash is restarted **once**; a second crash exits the parent. Exit code 0 does not restart. The child sends `"restart"` over IPC to request a deliberate restart, `"shutdown"` to stop everything.
- Under PM2 (`SAKURA_MANAGED_BY_PM2=1`) the parent doesn't restart the child itself — it exits and lets PM2 relaunch.

### Core (`src/`)

- **`core/loader.js`** — discovers plugins, instantiates them, registers handlers (regex commands, event listeners, cron jobs), dispatches events by priority, applies `master`/`whiteGroups`/`whiteUsers` checks. Hot-reloads via chokidar. Event matching is `startsWith`, so `OnEvent("request.group")` receives both `add` and `invite`.
- **`core/plugin.js`** — base `plugin` class and the `Command` / `OnEvent` / `Cron` decorators. Multi-step conversations use `setContext`/`finish`/`getContext` over `AsyncLocalStorage`.
- **`core/event.js`** — wraps raw OneBot events; proxies unknown property access to the bot API. Convenience methods (`reply`, `recall`, `sendForwardMsg`…) and computed props (`msg`, `at`, `isMaster`). `e.msg` is built from the text segments of `message`, not from `raw_message`.
- **`core/wsClient.js`** — OneBot v11 WebSocket client (forward and reverse); one reverse server can carry several bot accounts.
- **`adapters/milkyClient.js`** — OneBot v11 → Milky API name mapping, for Milky-based clients.
- **`api/client.js`** — `OneBotApi` maps camelCase methods to snake_case OneBot calls via Proxy. Also `Segment`, `Group`, `Friend`, and the **multi-bot registry**: the global `bot` is a facade that routes to the current event's account via `AsyncLocalStorage` (falls back to a default bot outside an event).
- **`core/botLifecycle.js`** — binds self_id → connection, detects bot-offline events, cleans up routes on disconnect.
- **`core/config.js` / `configSchema.js`** — singleton framework config from `config/config.yaml`, Zod-validated, missing fields auto-synced, hot-reloaded.
- **`core/accountConfig.js`** — per-account overrides in `config/account/<selfId>.yaml` (`default.yaml` as fallback).
- **`core/pluginConfig.js`** — per-plugin config. A plugin ships a `configSchema.js`; YAML under `config/<plugin>/` is generated, validated, migrated and hot-reloaded from it.
- **`core/economyHook.js`** — handlers can declare a charge; the framework checks balance and refunds on failure, so plugins don't each reimplement it.
- **`core/pluginScope.js`** — scope keys (per group / per account) that plugins use to key their state.
- **`web/configServer.js`** — HTTP server for the config panel (plus `serverFiles.js` / `serverDirectories.js` for the file browser); frontend in `web/frontend/`.

### Plugin system

Plugins live in `plugins/`. A plugin dir may have `index.js` (can be empty — its presence triggers directory loading), `apps/*.js` (feature modules exporting classes extending `plugin`), `configSchema.js`, and `lib/`. `plugins/system/` holds built-in framework plugins (admin, permission, offline notice, update).

```js
export class MyPlugin extends plugin {
  constructor() { super({ name: "my-plugin", priority: 1000 }) }
  myCmd = Command(/^#hello$/, async (e) => { ... })
  onJoin = OnEvent("notice.group_increase", async (e) => { ... })
  daily = Cron("0 8 * * *", async () => { ... })
}
```

Handlers run in priority order (lower = earlier). **Returning `false` passes through to the next handler; any other return stops the chain.** Permission levels: `"master"`, `"white"`.

"Got it" reactions are automatic: the loader (`scheduleAck`) reacts 124 to a group `Command` that is still running after 400ms without having replied (`e.reply` / `sendForwardMsg` / `e.react` on the trigger message mark it responded — counted per handler run via `ackScope` in `event.js`, so a reply from an earlier pass-through handler such as the random sticker does not suppress a later command's ack). Don't hand-write `e.react(124)` in commands. Opt out with `ack: false` on the Command options or the plugin constructor; a number swaps the emoji. `OnEvent` handlers are not covered.

Globals injected onto `global`: `logger`, `Command`, `OnEvent`, `Cron`, `plugin`, `Event`, `segment`, `bot`, `redis`. Plugin code uses these without importing.

### Repo layout note

`plugins/sakura-plugin` is **part of this repository**, not a separate clone. `.gitignore` ignores `plugins/*` but explicitly re-includes `plugins/system/` and `plugins/sakura-plugin/**`. Ignore rules for plugin files therefore belong in the root `.gitignore` and do take effect.

Design notes and balance write-ups live in `docs/` (fishing balance, a system map).

### State storage

- **SQLite** (`plugins/sakura-plugin/lib/Database.js`, `better-sqlite3`, WAL, file under the plugin data dir) is the persistent layer: economy, inventory, fishing stats, favorability, etc. New columns go through `migrate()` (`PRAGMA table_info` + `ALTER TABLE ADD COLUMN`).
- **Redis** is only for keys with a TTL — cooldowns, locks, timed buffs, session caches. **Never write a Redis key without an expiry**; state that doesn't expire belongs in SQLite. When moving data off Redis, write to SQLite first, then delete the key.
- Atomic consume/claim: `UPDATE … WHERE … AND <condition>` and check `result.changes > 0`; read-then-clear uses `db.transaction(...).immediate()` (SQLite `RETURNING` gives post-update values).

### sakura-plugin subsystems

The main plugin is large; each subsystem in `lib/` is self-contained with its command layer in `apps/`:

| `lib/` | What it is |
|---|---|
| `AIUtils/` | AI chat with tool-calling, provider routing, memory (vector store), group context. Tools in `AIUtils/tools/`; AI skills (see below) |
| `economy/`, `fishing/` | Currency, shop, inventory, red packets, fishing game (managers in `economy/`, settlement/encounters in `fishing/`) |
| `flychess/`, `favorability/`, `sign/`, `sleep/` | Smaller game/social systems |
| `pixiv/`, `imageSearch/`, `nai/` | Pixiv, reverse image search (SauceNAO / ascii2d / Google Lens), NovelAI |
| `douyin/`, `voice/`, `ImageUtils/` | Douyin parsing + comment rendering, VoxCPM TTS, shared image helpers |

**AI skills**: `SKILL.md`-based instruction packs loaded by `AIUtils/skills/registry.js`. Built-ins in `lib/AIUtils/skills/builtin/`; user-created ones in `plugins/sakura-plugin/skills/` (gitignored, per-deployment). Frontmatter must set `masterOnly` (boolean); `requiredTools` is optional.

### Message IDs across protocol backends

Backends disagree on IDs. SnowLuma: `message_id` is a hash (may be negative), `message_seq` is the real QQ seq, and `get_msg` / history anchors accept **only** `message_id`. NapCat: `message_seq == message_id`. Milky adapter: `message_id = String(message_seq)`.

Convention (don't revert): any ID shown to the AI or passed back to `get_msg` / recall / essence / react / history paging is **`message_id` first** (`getMessageIdentifier(message_id, message_seq, seq)`). Only time-ordering tiebreaks prefer `message_seq`. AI tools fetch messages via `AIUtils/messageLookup.js` → `fetchMessageByIdentifier(e, id)` (get_msg, then scan recent history as fallback).

Notice/request semantics also differ: decide "left voluntarily" from `sub_type === "leave"`, not `operator_id`; SnowLuma reports member invites as `request.group` + `sub_type=invite` (NapCat: `add`), and `set_group_add_request` must pass the matching `sub_type`.

### Image rendering

Two approaches coexist. Newer code renders **HTML in a persistent headless Chromium** and screenshots an element (shared singleton in `lib/ImageUtils/browser.js`); older code draws with `@napi-rs/canvas`. Prefer HTML for anything new — layout in CSS beats hand-computed coordinates. Note `page.setContent`'s base URL is `about:blank`, so images and fonts must be inlined as base64 data URIs.

## Debugging

- `logLevel: debug` in `config/config.yaml` logs every raw event as JSON.
- **Messages sent to private chats are not logged** — only `发送 -> 群聊` is. A missing log line doesn't prove a private-chat handler didn't run; log explicitly.
- `logEvent` prints `raw_message`, while command regexes match `e.msg`; they come from different fields.
- In debug probes use `typeof`, not `JSON.stringify`, to test whether a property exists (functions stringify to `undefined`).

## Conventions

- ESM everywhere (`"type": "module"`). `import`/`export`, not `require`.
- Chinese for log messages, comments and user-facing text.
- Zod v4 for config schemas. `.describe()` strings follow `label|#directive|help` (directives optional, e.g. `#groupSelect`, `#roleSelect`, `#modelList:<kind>`), consumed by the web panel.
- YAML config via `js-yaml`.
- pnpm workspace — one `pnpm-lock.yaml` at the root covers root, plugins and frontend. Native deps (`better-sqlite3`, `sharp`, `puppeteer`…) are listed in `onlyBuiltDependencies`.
