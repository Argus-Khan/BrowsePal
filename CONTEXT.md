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
                               lib/defaults.js (shared config defaults)
                               lib/esc.js      (shared HTML escape utility)
                               lib/tabs.js    (tabs)
                               lib/page.js    (→ content.js via tabs.sendMessage)
                               lib/cdp.js     (chrome.debugger wrapper — Chromium-only)
                               lib/net.js     (Network + Fetch domains; webRequest fallback)
                               lib/storage.js (ext storage + cookies + page storage + cache + idb)
                               lib/client.mjs (shared WebSocket RPC client for examples)
content.js (per page) ── DOM/eval/local/session/Cache/IndexedDB
options.html/css/js ── configure WS url + token + autoReconnect + status probe
popup.html/js ── quick toggle + blocked sites list
examples/agent-server.js ── sample agent-side WS server with REPL + CLI
examples/agent-tools.mjs ── JSON task runner (CLI toolkit)
examples/*.json ── example task files
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
| `net.*` CDP (bodies, throttle, intercept/mock) | ✅ via `chrome.debugger` | ❌ — Firefox has no `chrome.debugger`. `lib/cdp.js` guards and returns a clean error (`code: -32010`). |
| `debugger` permission | Optional; requested at runtime via the options page. Declared in `optional_permissions` in `manifest.json`. | **Not a valid permission** — `manifest-firefox.json` omits it entirely. |

## Verify / run
- **Chrome:** load unpacked at `chrome://extensions` (uses root `manifest.json`).
- **Firefox:** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → pick `manifest-firefox.json`.
- **Agent side:** `npm install` then `node examples/agent-server.js` (REPL: `ping`, `tabs.list`, `page.eval {"code":"document.title"}`).
- **Build for distribution:** `npm run build` → `dist/chrome/` and `dist/firefox/`.
- All JS passes `node --check`. Manifests are valid JSON.
