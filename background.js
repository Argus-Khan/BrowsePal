import { Rpc } from "./lib/rpc.js";
import { createTransport, loadConfig, saveConfig } from "./lib/ws.js";
import { CDP } from "./lib/cdp.js";
import { createNetApi } from "./lib/net.js";
import { createTabsApi } from "./lib/tabs.js";
import { createPageApi } from "./lib/page.js";
import {
  createIdbApi, createCacheApi, createPageStorageApi,
  createCookiesApi, createExtStorageApi,
} from "./lib/storage.js";
import { chrome } from "./lib/browser.js";

console.log("[bridge] background module loading…");

const rpc = new Rpc();
const cdp = new CDP();
const net = createNetApi(cdp);
const tabs = createTabsApi();
const page = createPageApi();
const passiveLog = [];

function bindByDot(obj, names, splitIdx = 1) {
  return Object.fromEntries(names.map((m) => [m, (p) => {
    const key = m.split(".").slice(splitIdx).join(".") || m.split(".")[splitIdx];
    return obj[key](p);
  }]));
}

const PAGE_METHODS = ["page.eval","page.getOuterHTML","page.getText","page.querySelector","page.querySelectorAll","page.getValue","page.setValue","page.click","page.clickByText","page.hover","page.focus","page.type","page.pressKey","page.scroll","page.scrollIntoView","page.waitFor","page.screenshot","page.navigate","page.reload","page.frames"];
const TABS_METHODS = ["tabs.list","tabs.active","tabs.create","tabs.close","tabs.activate"];
const NET_METHODS  = ["net.enable","net.disable","net.getLog","net.getRequest","net.clear","net.throttle","net.setBlocked","net.addInterceptor","net.removeInterceptor"];

const READ_METHODS = new Set(["page.getText","page.getOuterHTML","page.querySelector","page.querySelectorAll","page.getValue","page.screenshot","page.frames","page.eval"]);
const INTERACT_METHODS = new Set(["page.click","page.clickByText","page.setValue","page.type","page.pressKey","page.scroll","page.scrollIntoView","page.waitFor","page.navigate","page.reload","page.hover","page.focus","page.eval"]);

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

function name2key(m) { return m.split(".")[1]; }
const pageNs = Object.fromEntries(PAGE_METHODS.map((m) => [m, withAccessCheck(m, (p) => page[name2key(m)](p))]));
const tabsNs = Object.fromEntries(TABS_METHODS.map((m) => [m, (p) => tabs[name2key(m)](p)]));
const netNs  = Object.fromEntries(NET_METHODS.map((m) => [m, (p) => net[name2key(m)](p)]));

const idbNs        = createIdbApi();
const cacheNs     = createCacheApi();
const pageStorageNs = createPageStorageApi();
const cookiesNs   = createCookiesApi();
const extStorageNs = createExtStorageApi();

rpc.registerAll({
  ...pageNs,
  ...tabsNs,
  ...netNs,
  ...idbNs,
  ...cacheNs,
  ...pageStorageNs,
  ...cookiesNs,
  ...extStorageNs,
  "ping": () => ({ pong: Date.now(), connected: !!transport.ready }),
  "agent.config.get": () => ({
    url: cfg.url, hasToken: !!cfg.token, autoReconnect: cfg.autoReconnect,
    allowRead: cfg.allowRead, allowInteract: cfg.allowInteract, excludedUrls: cfg.excludedUrls,
    disabled: !!cfg.disabled,
  }),
  "agent.config.set": async (p) => {
    const allowed = ["url","token","autoReconnect","allowRead","allowInteract","excludedUrls","disabled"];
    const patch = {};
    for (const key of allowed) {
      if (p[key] !== undefined) patch[key] = p[key];
    }
    if (patch.excludedUrls && !Array.isArray(patch.excludedUrls)) delete patch.excludedUrls;
    await saveConfig(patch);
    transport.reopen(patch);
    cfg = await loadConfig();
    return { ok: true, ...cfg };
  },
  "agent.status": () => ({
    connected: !!transport.ready,
    url: cfg.url,
    attachedTabs: [...cdp.attached],
    passiveLogSize: passiveLog.length,
    allowRead: cfg.allowRead, allowInteract: cfg.allowInteract,
    excludedUrlsCount: (cfg.excludedUrls || []).length,
  }),
  "agent.reconnect": () => {
    if (transport) transport.connect();
    return { connected: !!transport.ready, url: cfg.url };
  },
  "agent.detachAll": async () => { await cdp.detachAll(); return { ok: true }; },
  "agent.passiveLog": (p) => {
    const limit = (p && p.limit) || 200;
    let list = passiveLog;
    if (p && p.tabId != null) list = passiveLog.filter((x) => x.tabId === p.tabId);
    return list.slice(-limit);
  },
  "agent.passiveLog.clear": () => { passiveLog.length = 0; return { ok: true }; },
});

const notifyCtx = () => ({
  notify: (m, p) => { if (transport && transport.ready) transport.sendObj({ jsonrpc: "2.0", method: m, params: p }); },
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    passiveLog.push({
      ts: details.timeStamp, id: details.requestId, tabId: details.tabId,
      url: details.url, method: details.method, type: details.type,
      frameId: details.frameId, parentFrameId: details.parentFrameId,
      initiator: details.initiator,
    });
    if (passiveLog.length > 2000) passiveLog.splice(0, passiveLog.length - 2000);
    if (transport && transport.ready) {
      transport.sendObj({ jsonrpc: "2.0", method: "net.requestLogged", params: {
        tabId: details.tabId, requestId: details.requestId, url: details.url, method: details.method, type: details.type,
      } });
    }
  },
  { urls: ["<all_urls>"] },
);

let transport;
let cfg = { url: "ws://127.0.0.1:9222", token: "", autoReconnect: true, allowRead: true, allowInteract: true, excludedUrls: [], disabled: false };

const _rpcHandle = rpc.handle.bind(rpc);
rpc.handle = (msg, transport) => {
  if (cfg && cfg.disabled && msg && msg.method && !msg.method.startsWith("agent.") && msg.method !== "ping") {
    if (msg.id != null) {
      transport.sendObj({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "bridge disabled" } });
    }
    return;
  }
  return _rpcHandle(msg, transport);
};

async function start() {
  console.log("[bridge] start() running");
  cfg = await loadConfig();
  console.log("[bridge] config loaded:", JSON.stringify(cfg));
  transport = createTransport(cfg, (msg) => {
    if (!msg) return;
    if (msg.method === "pong" || msg.method === "ping") return;
    rpc.handle(msg, transport);
  }, (state) => {
    console.log("[bridge] transport state:", JSON.stringify(state));
    if (state.connected) {
      transport.sendObj({ jsonrpc: "2.0", method: "agent.connected", params: { userAgent: navigator.userAgent, version: chrome.runtime.getManifest().version } });
    }
  });

  cdp.on((ev) => net._onCDPEvent(ev, notifyCtx()));

  transport.connect();
  console.log("[bridge] transport.connect() returned. ws url:", cfg.url);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (msg.jsonrpc !== "2.0" && typeof msg.method !== "string")) return false;
  const shim = { sendObj: (o) => { try { sendResponse(o); } catch (e) {} }, ready: true };
  rpc.handle(msg, shim);
  return true;
});

// chrome.runtime.onInstalled intentionally omitted — the popup is the entry point.

start().catch((e) => console.error("[bridge] start() FAILED:", e && e.stack || e));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ws-reconnect" && transport) {
    console.log("[bridge] alarm fired, reconnecting");
    transport.connect();
  }
});
