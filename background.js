// background.js — service worker (ES modules)
// Browser Agent Bridge: WebSocket client that connects to a relay server,
// routes JSON-RPC commands to content scripts and Chrome APIs.

import { Rpc } from "./lib/rpc.js";
import { createTransport, loadConfig, saveConfig } from "./lib/ws.js";
import { CDP } from "./lib/cdp.js";
import { createNetApi } from "./lib/net.js";
import { createTabsApi } from "./lib/tabs.js";
import {
  createIdbApi, createCacheApi, createPageStorageApi,
  createCookiesApi, createExtStorageApi,
} from "./lib/storage.js";
import { MSG, DEFAULTS, CONFIG_KEYS } from "./lib/protocol.js";
import { chrome, cb, withTab } from "./lib/browser.js";

console.log("[bridge] background module loading…");

// ─── Core instances ───────────────────────────────────────────────────────────

const rpc = new Rpc();
const cdp = new CDP();
const net = createNetApi(cdp);
const tabs = createTabsApi();
const passiveLog = [];
// requestId -> the passiveLog entry it belongs to, so webRequest listeners can
// enrich it in place. Pruned alongside passiveLog.
const passiveById = new Map();

let transport;
let cfg = { ...DEFAULTS };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isUrlExcluded(url, patterns) {
  if (!patterns || !patterns.length || !url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname;
    for (const p of patterns) {
      if (!p) continue;
      if (p.includes("/")) {
        if (url.includes(p)) return true;
      } else {
        if (host === p || host.endsWith("." + p)) return true;
      }
    }
  } catch (e) {}
  return false;
}

function name2key(m) {
  return m.split(".")[1];
}

/**
 * Build a ws.js-compatible config by merging current app config with a patch.
 * If a full URL is provided (or already stored), use it directly.
 * Otherwise construct from host/port for backward compatibility.
 */
function wsCfg(patch = {}) {
  const merged = { ...cfg, ...patch };
  // Prefer the full URL if set, otherwise build from host/port
  const url = merged.url || `ws://${merged.host || "127.0.0.1"}:${merged.port || 9222}`;
  return { ...merged, url };
}

// ─── Content script communication ─────────────────────────────────────────────
//
// Commands are forwarded to the content script as flat messages:
//   { type: "<MSG constant>", ...params }
// The content script responds with { ok: value } or { err: "message" }.

function sendToContent(tabId, frameId, message) {
  const opts = frameId != null ? { frameId } : undefined;
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, opts, (result) => {
      const e = chrome.runtime.lastError;
      resolve(e ? { __error: e.message } : result);
    });
  });
}

async function forwardToContent(tabId, frameId, type, data = {}) {
  tabId = await withTab(tabId);
  const res = await sendToContent(tabId, frameId, { type, ...data });
  if (!res) {
    throw Object.assign(
      new Error(`No content script in tab ${tabId} (try reloading the page)`),
      { code: -32002 },
    );
  }
  if (res.__error) {
    throw Object.assign(new Error(res.__error), { code: -32003 });
  }
  if (res.err) {
    throw Object.assign(new Error(res.err), { code: -32004 });
  }
  return res.ok;
}

// ─── Access control ───────────────────────────────────────────────────────────

const READ_METHODS = new Set([
  // Low-level page reads
  "page.getText", "page.getOuterHTML", "page.querySelector", "page.querySelectorAll",
  "page.getValue", "page.screenshot", "page.frames", "page.eval",
  // High-level page reads
  "page.snapshot", "page.subscribe", "page.unsubscribe",
  // Console + performance (observation only — console.clear is not gated)
  "console.getLog", "perf.metrics", "perf.resources",
]);

const INTERACT_METHODS = new Set([
  // Low-level page interactions
  "page.click", "page.clickByText", "page.setValue", "page.type", "page.pressKey",
  "page.scroll", "page.scrollIntoView", "page.waitFor",
  "page.navigate", "page.reload", "page.hover", "page.focus", "page.eval",
  // High-level page interactions
  "page.act",
]);

async function checkPageAccess(method, params) {
  if (READ_METHODS.has(method) && cfg.allowRead === false) {
    throw new Error("access denied: reading page content is disabled");
  }
  if (INTERACT_METHODS.has(method) && cfg.allowInteract === false) {
    throw new Error("access denied: interacting with pages is disabled");
  }
  if (params.tabId != null && cfg.excludedUrls && cfg.excludedUrls.length) {
    const tab = await chrome.tabs.get(params.tabId);
    if (tab && isUrlExcluded(tab.url, cfg.excludedUrls)) {
      throw new Error(`access denied: ${tab.url} is excluded`);
    }
  }
  if (method === "page.navigate" && params.url && cfg.excludedUrls && cfg.excludedUrls.length) {
    if (isUrlExcluded(params.url, cfg.excludedUrls)) {
      throw new Error(`access denied: ${params.url} is excluded`);
    }
  }
}

function withAccessCheck(method, handler) {
  return async (params) => {
    await checkPageAccess(method, params);
    return handler(params);
  };
}

// ─── Method lists ─────────────────────────────────────────────────────────────

const PAGE_METHODS = [
  // High-level (new protocol)
  "page.snapshot", "page.act", "page.subscribe", "page.unsubscribe",
  // Low-level DOM (forwarded to content script)
  "page.eval", "page.getOuterHTML", "page.getText",
  "page.querySelector", "page.querySelectorAll",
  "page.getValue", "page.setValue",
  "page.click", "page.clickByText",
  "page.hover", "page.focus",
  "page.type", "page.pressKey",
  "page.scroll", "page.scrollIntoView", "page.waitFor",
  // Special (handled in background — Chrome APIs, not content script)
  "page.screenshot", "page.navigate", "page.reload", "page.frames",
];

const TABS_METHODS = [
  "tabs.list", "tabs.active", "tabs.create", "tabs.close", "tabs.activate",
];

const NET_METHODS = [
  "net.enable", "net.disable", "net.getLog", "net.getRequest", "net.clear",
  "net.throttle", "net.setBlocked", "net.addInterceptor", "net.removeInterceptor",
];

// Console + performance run in the content script, like the page.* family.
// frameId defaults to 0 (top frame): omitting it broadcasts to every frame in
// the tab and the first responder wins, which would hand back an iframe's
// console buffer. Pass frameId explicitly to reach a specific frame.
const CONSOLE_METHODS = ["console.getLog", "console.clear"];
const PERF_METHODS = ["perf.metrics", "perf.resources"];

// ─── Message type mappings (background → content script) ──────────────────────
//
// High-level methods use MSG constants from protocol.js.
// Low-level methods also use MSG constants — the content script will be
// updated to handle these in a separate change.

const HIGH_LEVEL_MSG = {
  "page.snapshot":    MSG.SNAPSHOT,
  "page.act":         MSG.ACT,
  "page.subscribe":   MSG.SUBSCRIBE,
  "page.unsubscribe": MSG.UNSUBSCRIBE,
};

const LOW_LEVEL_MSG = {
  "page.eval":            MSG.EVAL,
  "page.getOuterHTML":    MSG.GET_OUTER_HTML,
  "page.getText":         MSG.GET_TEXT,
  "page.querySelector":   MSG.QUERY_SELECTOR,
  "page.querySelectorAll": MSG.QUERY_ALL,
  "page.getValue":        MSG.GET_VALUE,
  "page.setValue":        MSG.SET_VALUE,
  "page.click":           MSG.CLICK,
  "page.clickByText":     MSG.CLICK_BY_TEXT,
  "page.hover":           MSG.HOVER,
  "page.focus":           MSG.FOCUS,
  "page.type":            MSG.TYPE,
  "page.pressKey":        MSG.PRESS_KEY,
  "page.scroll":          MSG.SCROLL,
  "page.scrollIntoView":  MSG.SCROLL_INTO,
  "page.waitFor":         MSG.WAIT_FOR,
};

const HIGH_LEVEL = new Set(Object.keys(HIGH_LEVEL_MSG));

// Special methods that run entirely in the background (Chrome APIs).
const BG_ONLY = new Set(["page.screenshot", "page.navigate", "page.reload", "page.frames"]);

// ─── Build page namespace ─────────────────────────────────────────────────────

function buildPageHandlers() {
  const ns = {};

  for (const method of PAGE_METHODS) {
    if (BG_ONLY.has(method)) continue; // handled separately below

    if (HIGH_LEVEL.has(method)) {
      // High-level: forward to content script using MSG constant.
      ns[method] = withAccessCheck(method, (params) => {
        return forwardToContent(params.tabId, params.frameId, HIGH_LEVEL_MSG[method], params);
      });
    } else if (LOW_LEVEL_MSG[method]) {
      // Low-level DOM: forward to content script using MSG constant.
      ns[method] = withAccessCheck(method, (params) => {
        // eval has special forwarding — only pass { code } to the content script.
        if (method === "page.eval") {
          return forwardToContent(params.tabId, params.frameId, MSG.EVAL, { code: params.code });
        }
        return forwardToContent(params.tabId, params.frameId, LOW_LEVEL_MSG[method], params);
      });
    }
  }

  // ── Special: background-only page methods ────────────────────────────────

  ns["page.screenshot"] = withAccessCheck("page.screenshot", async (params) => {
    const tabId = await withTab(params.tabId);
    const format = params.format === "jpeg" ? "jpeg" : "png";
    const quality = typeof params.quality === "number" ? params.quality : 90;
    const dataUrl = await cb(chrome.tabs.captureVisibleTab, undefined, { format, quality });
    return { format, dataUrl };
  });

  ns["page.navigate"] = withAccessCheck("page.navigate", async (params) => {
    const tabId = await withTab(params.tabId);
    await cb(chrome.tabs.update, tabId, { url: params.url });
    return { navigated: true, tabId, url: params.url };
  });

  ns["page.reload"] = withAccessCheck("page.reload", async (params) => {
    const tabId = await withTab(params.tabId);
    await cb(chrome.tabs.reload, tabId, { bypassCache: !!params.bypassCache });
    return { reloaded: true, tabId };
  });

  ns["page.frames"] = withAccessCheck("page.frames", async (params) => {
    const tabId = await withTab(params.tabId);
    const all = await cb(chrome.webNavigation.getAllFrames, { tabId });
    return (all || []).map((f) => ({
      frameId: f.frameId,
      parentFrameId: f.parentFrameId,
      url: f.url,
    }));
  });

  return ns;
}

const pageNs = buildPageHandlers();

// ─── Build other namespaces ───────────────────────────────────────────────────

const tabsNs = Object.fromEntries(
  TABS_METHODS.map((m) => [m, (params) => tabs[name2key(m)](params)]),
);

const netNs = Object.fromEntries(
  NET_METHODS.map((m) => [m, (params) => net[name2key(m)](params)]),
);

const idbNs         = createIdbApi();
const cacheNs       = createCacheApi();
const pageStorageNs = createPageStorageApi();
const cookiesNs     = createCookiesApi();
const extStorageNs  = createExtStorageApi();

const consoleNs = Object.fromEntries(
  CONSOLE_METHODS.map((m) => [m, withAccessCheck(m, (params) => {
    const frameId = params.frameId != null ? params.frameId : 0;
    return forwardToContent(params.tabId, frameId, MSG.CONSOLE, { ...params, op: name2key(m) });
  })]),
);

const perfNs = Object.fromEntries(
  PERF_METHODS.map((m) => [m, withAccessCheck(m, (params) => {
    const frameId = params.frameId != null ? params.frameId : 0;
    return forwardToContent(params.tabId, frameId, MSG.PERF, { ...params, op: name2key(m) });
  })]),
);

// ─── Register all RPC methods ─────────────────────────────────────────────────

rpc.registerAll({
  // Page — high-level + low-level + special
  ...pageNs,

  // Tabs
  ...tabsNs,

  // Network (CDP)
  ...netNs,

  // Console + performance (works on Chrome and Firefox — no CDP)
  ...consoleNs,
  ...perfNs,

  // Storage
  ...idbNs,
  ...cacheNs,
  ...pageStorageNs,
  ...cookiesNs,
  ...extStorageNs,

  // ── Agent management ─────────────────────────────────────────────────────

  "ping": () => ({
    pong: Date.now(),
    connected: !!transport.ready,
  }),

  "agent.status": () => ({
    connected: !!transport.ready,
    url: cfg.url || `ws://${cfg.host || "127.0.0.1"}:${cfg.port || 9222}`,
    attachedTabs: [...cdp.attached],
    passiveLogSize: passiveLog.length,
    allowRead: cfg.allowRead,
    allowInteract: cfg.allowInteract,
    excludedUrlsCount: (cfg.excludedUrls || []).length,
  }),

  "agent.config.get": () => ({
    url: cfg.url || `ws://${cfg.host || "127.0.0.1"}:${cfg.port || 9222}`,
    hasToken: !!cfg.token,
    autoReconnect: cfg.autoReconnect,
    allowRead: cfg.allowRead,
    allowInteract: cfg.allowInteract,
    excludedUrls: cfg.excludedUrls,
    disabled: !!cfg.disabled,
  }),

  "agent.config.set": async (params) => {
    const patch = {};
    for (const key of CONFIG_KEYS) {
      if (params[key] !== undefined) patch[key] = params[key];
    }
    if (patch.excludedUrls && !Array.isArray(patch.excludedUrls)) {
      delete patch.excludedUrls;
    }
    await saveConfig(patch);
    transport.reopen(wsCfg(patch));
    cfg = await loadConfig();
    if (cfg.autoReconnect === undefined) cfg.autoReconnect = true;
    return { ok: true, ...cfg };
  },

  "agent.reconnect": () => {
    if (transport) transport.connect();
    return { connected: !!transport.ready, url: cfg.url || `ws://${cfg.host || "127.0.0.1"}:${cfg.port || 9222}` };
  },

  "agent.detachAll": async () => {
    await cdp.detachAll();
    return { ok: true };
  },

  "agent.passiveLog": (params) => {
    const limit = (params && params.limit) || 200;
    let list = passiveLog;
    if (params && params.tabId != null) {
      list = passiveLog.filter((entry) => entry.tabId === params.tabId);
    }
    return list.slice(-limit);
  },

  "agent.passiveLog.clear": () => {
    passiveLog.length = 0;
    // Without this the Map keeps up to 2000 orphaned entries per clear.
    passiveById.clear();
    return { ok: true };
  },
});

// ─── Content script event forwarding ──────────────────────────────────────────
//
// Content scripts push events (e.g. dom.mutation, navigation) by sending
// { type: MSG.EVENT, ... } via chrome.runtime.sendMessage.  We detect those
// here and forward them to the WebSocket transport so the agent receives them
// as JSON-RPC notifications.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Forward ba:event messages from content scripts → WebSocket
  if (msg && msg.type === MSG.EVENT) {
    if (transport && transport.ready) {
      const params = { tabId: sender.tab ? sender.tab.id : undefined };
      // Merge any extra properties the content script included.
      if (msg.params && typeof msg.params === "object") {
        Object.assign(params, msg.params);
      }
      transport.sendObj({ jsonrpc: "2.0", method: "ba.event", params });
    }
    return false; // no response needed for fire-and-forget events
  }

  // JSON-RPC messages from popup / options page
  if (!msg || (msg.jsonrpc !== "2.0" && typeof msg.method !== "string")) {
    return false;
  }
  const shim = {
    sendObj: (o) => { try { sendResponse(o); } catch (e) {} },
    ready: true,
  };
  rpc.handle(msg, shim);
  return true; // keep sendResponse channel open for async RPC
});

// ─── Disabled-mode wrapper ────────────────────────────────────────────────────
//
// When the bridge is disabled via the popup, all non-agent methods are rejected.

const _rpcHandle = rpc.handle.bind(rpc);
rpc.handle = (msg, transportRef) => {
  if (
    cfg && cfg.disabled && msg && msg.method &&
    !msg.method.startsWith("agent.") && msg.method !== "ping"
  ) {
    if (msg.id != null) {
      transportRef.sendObj({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: "bridge disabled" },
      });
    }
    return;
  }
  return _rpcHandle(msg, transportRef);
};

// ─── Passive network log (webRequest) ────────────────────────────────────────
//
// Records every request so `agent.passiveLog` can return it, and pushes a
// lightweight notification to the WebSocket for real-time tracking.

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const entry = {
      ts: details.timeStamp,
      id: details.requestId,
      tabId: details.tabId,
      url: details.url,
      method: details.method,
      type: details.type,
      frameId: details.frameId,
      parentFrameId: details.parentFrameId,
      initiator: details.initiator,
    };
    passiveLog.push(entry);
    passiveById.set(details.requestId, entry);
    if (passiveLog.length > 2000) {
      const dropped = passiveLog.splice(0, passiveLog.length - 2000);
      for (const d of dropped) passiveById.delete(d.id);
    }
    if (transport && transport.ready) {
      transport.sendObj({
        jsonrpc: "2.0",
        method: "net.requestLogged",
        params: {
          tabId: details.tabId,
          requestId: details.requestId,
          url: details.url,
          method: details.method,
          type: details.type,
        },
      });
    }
  },
  { urls: ["<all_urls>"] },
);

// ─── Passive log enrichment (status, timing) ──────────────────────────────────
//
// webRequest is the only network source Firefox has — net.* needs the Chrome
// debugger permission — so these listeners are what turn the bare request list
// into a usable Network log there. They also run on Chrome, where they coexist
// with net.* (they only annotate entries, never intercept).

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const e = passiveById.get(details.requestId);
    if (!e) return;
    e.status = details.statusCode;
    const headers = details.responseHeaders || [];
    for (const h of headers) {
      if (h.name.toLowerCase() === "content-type") { e.mimeType = h.value; break; }
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const e = passiveById.get(details.requestId);
    if (!e) return;
    if (e.status == null) e.status = details.statusCode;
    e.duration = Math.round((details.timeStamp - e.ts) * 10) / 10;
    e.ok = details.statusCode < 400;
  },
  { urls: ["<all_urls>"] },
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    const e = passiveById.get(details.requestId);
    if (!e) return;
    e.error = details.error;
    e.failed = true;
    e.duration = Math.round((details.timeStamp - e.ts) * 10) / 10;
  },
  { urls: ["<all_urls>"] },
);

// ─── CDP event notification context ───────────────────────────────────────────
//
// Passed to `net._onCDPEvent` so it can push CDP-derived notifications (e.g.
// net.requestPaused, net.responseReceived) to the WebSocket transport.

const notifyCtx = () => ({
  notify: (method, params) => {
    if (transport && transport.ready) {
      transport.sendObj({ jsonrpc: "2.0", method, params });
    }
  },
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function start() {
  console.log("[bridge] start() running");
  cfg = await loadConfig();
  // Ensure autoReconnect has a default — needed by ws.js but absent from
  // protocol.js DEFAULTS (which only has host/port/token/flags).
  if (cfg.autoReconnect === undefined) cfg.autoReconnect = true;
  console.log("[bridge] config loaded:", JSON.stringify(cfg));

  transport = createTransport(
    wsCfg(),
    (msg) => {
      if (!msg) return;
      if (msg.method === "pong" || msg.method === "ping") return;
      rpc.handle(msg, transport);
    },
    (state) => {
      console.log("[bridge] transport state:", JSON.stringify(state));
      if (state.connected) {
        transport.sendObj({
          jsonrpc: "2.0",
          method: "agent.connected",
          params: {
            userAgent: navigator.userAgent,
            version: chrome.runtime.getManifest().version,
          },
        });
      }
    },
  );

  // Wire CDP events into the net API so interceptors and log work.
  cdp.on((ev) => net._onCDPEvent(ev, notifyCtx()));

  transport.connect();
  console.log("[bridge] transport.connect() returned. ws url:", cfg.url || `ws://${cfg.host || "127.0.0.1"}:${cfg.port || 9222}`);
}

// ─── Alarm-based reconnection ─────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ws-reconnect" && transport) {
    console.log("[bridge] alarm fired, reconnecting");
    transport.connect();
  }
});

// ─── Diagnostic: Popup Window Monitor ────────────────────────────────────────
// Tracks all window creation/resizing to diagnose popup shrink issues
// (e.g. pop-shell tiling manager interfering with extension popups).

if (chrome.windows) {
  const diagTag = "[win-diag]";

  // Log all windows on startup
  chrome.windows.getAll({ populate: false }, (windows) => {
    for (const w of windows) {
      console.log(diagTag, "initial-window", JSON.stringify({
        id: w.id, type: w.type, state: w.state,
        width: w.width, height: w.height,
        left: w.left, top: w.top,
        focused: w.focused,
      }));
    }
  });

  // Track window creation
  chrome.windows.onCreated.addListener((window) => {
    console.log(diagTag, "created", JSON.stringify({
      id: window.id, type: window.type, state: window.state,
      width: window.width, height: window.height,
      left: window.left, top: window.top,
    }));
  });

  // Track window resize/move — this fires when pop-shell or anything else changes window bounds
  // ?. — onBoundsChanged is Chrome-only (Firefox: no support); an unguarded
  // call here throws at module load and aborts start() entirely.
  chrome.windows.onBoundsChanged?.addListener((window) => {
    console.log(diagTag, "bounds-changed", JSON.stringify({
      id: window.id, type: window.type, state: window.state,
      width: window.width, height: window.height,
      left: window.left, top: window.top,
    }));
  });

  // Track window focus changes (pop-shell may resize on focus)
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    chrome.windows.get(windowId, (w) => {
      if (chrome.runtime.lastError) return;
      console.log(diagTag, "focus-changed", JSON.stringify({
        id: w.id, type: w.type, state: w.state,
        width: w.width, height: w.height,
      }));
    });
  });

  // Track window removal
  chrome.windows.onRemoved.addListener((windowId) => {
    console.log(diagTag, "removed", JSON.stringify({ id: windowId }));
  });

  console.log("[bridge] popup window diagnostic monitor registered");
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

start().catch((e) => console.error("[bridge] start() FAILED:", e && e.stack || e));
