# Browser Agent Bridge

A cross-browser (Chromium + Firefox 128+) Manifest V3 extension that exposes the browser to an **external AI agent** over a local WebSocket, using **JSON-RPC 2.0**. It gives the agent roughly the same reach a human has via Mozilla DevTools:

- **Pages / DOM** — evaluate JS, query selectors, read/set text & values, click/type/scroll, screenshots, navigation.
- **Network** — full CDP power via `chrome.debugger`: observe requests, read request/response bodies, throttle, block, fulfill (mock), and rewrite headers/body on the fly.
- **Passive network log** — `webRequest` capture that works even without the debugger banner.
- **Storage** — `localStorage` & `sessionStorage` (per origin), `chrome.storage.local`/`session`, cookies.
- **Cache (Cache API)** — list caches, match, put, delete, enumerate entries.
- **IndexedDB** — list databases & stores, get/put/delete keys, enumerate.
- **Tabs** — list, focus, create, close.

The extension **cannot be a server** (MV3 background workers can't listen on ports), so it **connects out** to a WebSocket server that the AI agent runs (default `ws://localhost:9222`). The agent pushes JSON-RPC commands; the extension executes them and returns results.

## Architecture

```
        JSON-RPC over WebSocket
Agent  <---------------------->  background.js (service worker)
                                 ├── lib/ws.js      (reconnecting WS client, heartbeat, queue)
                                 ├── lib/rpc.js     (JSON-RPC 2.0 dispatcher)
                                 ├── lib/tabs.js    (tabs)
                                 ├── lib/page.js    (→ content.js via tabs.sendMessage)
                                 ├── lib/cdp.js     (chrome.debugger wrapper)
                                 ├── lib/net.js     (Network + Fetch domains; webRequest fallback)
                                 └── lib/storage.js (extension storage + cookies)
                                                   │
content.js (per page, all frames) ── DOM/eval/local/session/Cache/IndexedDB
```

## Install

### From source (development)

1. Load the extension:
   - **Chrome / Chromium:** `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick `dist/chrome/`.
   - **Firefox:** `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `dist/firefox/manifest.json`.
2. Click the extension's **Options** page to set the WebSocket URL (default `ws://localhost:9222`) and an optional shared token.
   - **Chrome only:** click **Grant debugger (CDP) permission** for `net.*` features.
3. Run the agent side:

```bash
npm install
npm start                              # interactive REPL server
npm run tools examples/list-tabs.json  # run a toolkit task
```

### From npm (for friends / end users)

```bash
npm install -g browser-agent-tools
browser-agent-tools examples/list-tabs.json
```

Then load the extension from the installed package:

- Chrome: load unpacked from `node_modules/browser-agent-tools/dist/chrome/`
- Firefox: load temporary add-on, pick `node_modules/browser-agent-tools/dist/firefox/manifest.json`

### Build distribution folders

```bash
npm run build   # creates dist/chrome/ and dist/firefox/
```

### Publish to stores (optional)

- **Chrome Web Store:** zip `dist/chrome/` and upload to the Chrome Web Store Developer Dashboard.
- **Firefox Add-ons:** submit `dist/firefox/` as a source zip or packaged extension via [addons.mozilla.org](https://addons.mozilla.org). Stable Firefox requires signed extensions; use Firefox Developer Edition/Nightly for temporary testing.
- **npm:** `npm publish` ships the toolkit and pre-built extension folders.

The extension auto-connects (visible in the agent server's console) and retries with exponential backoff.

## Protocol (JSON-RPC 2.0)

Request ⇄ response:
```json
→ {"jsonrpc":"2.0","id":1,"method":"page.eval","params":{"tabId":12,"code":"document.title"}}
← {"jsonrpc":"2.0","id":1,"result":"Example"}
```

Notifications (server→agent, no `id`): `net.requestWillBeSent`, `net.responseReceived`, `net.loadingFinished`, `net.requestPaused`, `agent.connected`, `agent.disconnected`, `net.requestLogged`.

> **Tab targeting.** Most page/network/storage/cache/indexedDB calls take a `tabId` to act on the page in that tab. Use `tabs.list` / `tabs.active` to discover it. If `tabId` is omitted on page-level calls, the extension uses the currently active tab.

### `page.*`
```
page.eval            {tabId?, frameId?, code}                   → value (must serialize)
page.getOuterHTML    {tabId?, frameId?}
page.getText         {tabId?, frameId?, selector?}               // all text in selector (default body)
page.querySelector   {tabId?, frameId?, selector, attrs?[]}      → {outerHTML, attrs, text, value}
page.querySelectorAll{tabId?, frameId?, selector, attrs?[], limit?}
page.getValue        {tabId?, frameId?, selector}                // input/textarea/select
page.setValue        {tabId?, frameId?, selector, value}
page.click           {tabId?, frameId?, selector}
page.hover           {tabId?, frameId?, selector}
page.focus           {tabId?, frameId?, selector}
page.type            {tabId?, frameId?, selector?, text}
page.scroll          {tabId?, frameId?, selector?, dx, dy}      // selector=scroll that into view then scroll, else page
page.scrollIntoView  {tabId?, frameId?, selector}
page.waitFor         {tabId?, frameId?, selector, timeoutMs?}   // resolves when present
page.screenshot      {tabId?, format?:"png|jpeg", quality?}
page.navigate        {tabId?, url}
page.reload          {tabId?}
page.frames          {tabId?}                                    // → list of {frameId, url}
```

### `tabs.*`
```
tabs.list            → [{id, url, title, active, windowId}]
tabs.active          → tab
tabs.create          {url?, active?}
tabs.close           {tabId}
tabs.activate        {tabId}
```

### `net.*` (CDP; auto-attaches the debugger for that tab)
```
net.enable           {tabId?}                  // start capturing; also enables request steering
net.disable          {tabId?}
net.getLog           {tabId?, filter?}         // ⇒ array of entries
net.getRequest       {tabId, requestId}        // ⇒ entry + bodies
net.clear            {tabId?}
net.throttle         {tabId?, offline, downloadKbps, uploadKbps, latencyMs}  // Network.emulateNetworkConditions
net.setBlocked        {tabId?, patterns: [string]}    // URL substrings to block (Fetch.fulfill empty)
net.addInterceptor   {tabId?, patterns: [{match, headers?, body?, contentType?, status?}]}
net.removeInterceptor {tabId?, id}
```

### `storage.*` (chrome.storage + page storage)
```
storage.local.get / set / remove / clear   keys: array
storage.session.get / set / remove / clear
storage.page.local.get/set/remove/clear/keys   {tabId?, frameId?}   // localStorage
storage.page.session.get/set/remove/clear/keys {tabId?, frameId?}   // sessionStorage
```

### `cookies.*` (chrome.cookies)
```
cookies.getAll       {url?|storeId?|domain?|name?}
cookies.get          {url, name}
cookies.set          {url, name, value, domain?, path?, secure?, httpOnly?, sameSite?, expirationDate?}
cookies.remove       {url, name}
```

### `cache.*` (Cache API; origin derived from the page URL in tabId)
```
cache.keys           {tabId?}                       // list cache names
cache.openList       {tabId, name}                  // entries in a cache ⇒ [{url, method}]
cache.match          {tabId, name, request}
cache.put            {tabId, name, request, response{body, contentType, status, headers}}
cache.delete         {tabId, name, request}
cache.clear          {tabId, name}
```

### `indexedDB.*`
```
indexedDB.databases  {tabId?}
indexedDB.stores     {tabId, name}
indexedDB.get        {tabId, db, store, key}
indexedDB.put        {tabId, db, store, value, key?}
indexedDB.del        {tabId, db, store, key}
indexedDB.count      {tabId, db, store, query?}
indexedDB.keys       {tabId, db, store, query?, limit?}
indexedDB.getAll     {tabId, db, store, query?, limit?}
```

## Permissions, why

| Permission | Reason |
|---|---|
| `debugger` (optional, Chrome/Chromium only) | Full CDP-level network + JS-in-frame. Shows an "is being controlled by automated software" bar — expected. Requested from the options page at runtime because Firefox does not have this permission/API. |
| `tabs`, `activeTab`, `scripting` | Enumerate/tab-focus and inject content side helpers. |
| `webRequest`, `webNavigation` | Passive traffic log + frame enumeration. |
| `storage` | `chrome.storage` commands + extension settings. |
| `cookies` | Cookie APIs. |
| `unlimitedStorage` ` <all_urls>` | Unbounded capture; operate on any site. |

> ⚠️ This extension can run arbitrary JS in, and read/write, any page in the user's browser. Treat the WS endpoint as privileged — bind it to loopback and use the token option. Don't expose it to the network.