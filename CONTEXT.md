# Browser Agent Bridge — Context

A cross-browser MV3 extension that exposes the browser to an **external AI agent** over a local WebSocket, using JSON-RPC 2.0. Gives the agent roughly the same reach as Mozilla DevTools: pages, network, cache, storage.

## Transport
- Extension **connects out** to the agent's WebSocket server (default `ws://localhost:9222`) — MV3 background workers can't be servers.
- JSON-RPC 2.0 over WS. Agent → requests, Extension ← notifications.

## Architecture
```
Agent  ──JSON-RPC over WS──  background.js (service worker / Firefox event page)
                               lib/ws.js      (reconnecting WebSocket client, heartbeat, queue)
                               lib/rpc.js     (JSON-RPC 2.0 dispatcher)
                               lib/tabs.js    (tabs)
                               lib/page.js    (→ content.js via tabs.sendMessage)
                               lib/cdp.js     (chrome.debugger wrapper — Chromium-only)
                               lib/net.js     (Network + Fetch domains; webRequest fallback)
                               lib/storage.js (ext storage + cookies + page storage + cache + idb)
content.js (per page) ── DOM/eval/local/session/Cache/IndexedDB
options.html/css/js ── configure WS url + token + autoReconnect + status probe
examples/agent-server.js ── sample agent-side WS server with REPL + CLI
examples/probe.js ── automated probe (serve, wait for connection, run RPC calls)
```

## Method namespaces (full list in README.md)
`page.*` (eval/DOM/click/type/scroll/screenshot/navigate/frames) · `tabs.*` ·
`net.*` (CDP) · passive `webRequest` log · `storage.local/session` + `storage.page.local/session` ·
`cookies.*` · `cache.*` (Cache API) · `indexedDB.*` · `agent.*` (status/config/ping).

## Cross-browser status

| Capability | Chrome/Chromium | Firefox 128+ |
|---|---|---|
| Load manifest | ✅ `service_worker` | ✅ `scripts` (event page) |
| `page.* / tabs.* / storage.* / cache.* / indexedDB.* / cookies.*` | ✅ | ✅ |
| Passive `webRequest` log + block | ✅ | ✅ |
| `net.*` CDP (bodies, throttle, intercept/mock) | ✅ via `chrome.debugger` | ❌ — Firefox has no `chrome.debugger`. `lib/cdp.js` now guards and returns a clean error (`code: -32010`). |
| `debugger` permission | Required (we have it) | **Not a valid permission** — moved to `optional_permissions` so Firefox stops warning; only requested at runtime on Chromium. |

## Processing state

The addon was working on Chrome MV3. It now **loads cleanly on Firefox** after fixing:
1. `background.service_worker is currently disabled` → added `scripts: ["background.js"]` alongside `service_worker`.
2. Manifest permission error `Value "debugger" must either…` → moved `debugger` to `optional_permissions`.
3. `lib/cdp.js` now exposes `cdp.available = !!chrome.debugger` and `attach()` throws a clear `code: -32010` error when unavailable, so Firefox doesn't throw `TypeError`s trying to use `chrome.debugger` at load.
4. Background + `lib/ws.js` added console logs at each stage of `start()` and `connect()` to help debug connection failures.

## Pending / planned
- **Retry connection on Firefox** in the user's live session — last probe ran to timeout with no incoming WS connection. We added instrumentation logs and are waiting for the user to **Remove → re-Load** the temporary add-on in `about:debugging` so the new manifest + logging take effect. The console in the background page's DevTools (`about:debugging → Browser Agent Bridge → Inspect`) should now print `[bridge]` lines showing exactly where startup halts (if it still does).
- **Firefox net layer (proposed but not yet built):** a `lib/net-firefox.js` using blocking `webRequest` (`onBeforeRequest`, `onHeadersReceived`, `onBeforeSendHeaders`) so `net.setBlocked`, request-side `net.addInterceptor`, and `net.throttle` work on Firefox without CDP. Response body capture stays unavailable on Firefox (no API). The `net.js` dispatcher should route to the Firefox layer when `cdp.available === false`.
- No linter/test harness is configured for this project. The work-in-progress unit/e2e checks under `/tmp/opencode/` (RPC dispatcher + example server round-trip) all pass when run from `/home/argus/Projects/browser-agent`.

## Verify / run
- Chrome: load unpacked at `chrome://extensions`.
- Firefox: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `manifest.json`. Stable Firefox refuses unsigned extensions; use Dev Edition/Nightly/Unbranded ESR or AMO sign.
- Agent side: `npm install` then `node examples/agent-server.js` (REPL: `ping`, `tabs.list`, `page.eval {"code":"document.title"}`). Or `node examples/probe.js` for an automated read of status/tabs/page/storage — exits after 100s if no connection.
- All JS passes `node --check`. Manifest is valid JSON.