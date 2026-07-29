import { cb, withTab, chrome } from "./browser.js";

function send(meta, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(meta.tabId, msg, meta.opts ?? undefined, (res) => {
      try {
        const e = chrome.runtime.lastError;
        if (e) return reject(Object.assign(new Error(e.message), { code: -32003 }));
        if (res && res.err) return reject(Object.assign(new Error(res.err), { code: -32004 }));
        resolve(res ? res.ok : null);
      } catch (err) { reject(err); }
    });
  });
}

async function meta(params) {
  return { tabId: await withTab(params.tabId), opts: params.frameId != null ? { frameId: params.frameId } : undefined, frameId: params.frameId };
}

export function createIdbApi() {
  async function call(params, op) {
    const m = await meta(params);
    return send(m, { type: "indexedDB", op, db: params.db, store: params.store, value: params.value, key: params.key, query: params.query, limit: params.limit });
  }
  return {
    "indexedDB.databases": (p) => call(p, "databases"),
    "indexedDB.stores": (p) => call(p, "stores"),
    "indexedDB.get": (p) => call(p, "get"),
    "indexedDB.put": (p) => call(p, "put"),
    "indexedDB.del": (p) => call(p, "del"),
    "indexedDB.count": (p) => call(p, "count"),
    "indexedDB.keys": (p) => call(p, "keys"),
    "indexedDB.getAll": (p) => call(p, "getAll"),
  };
}

export function createCacheApi() {
  async function call(params, op) {
    const m = await meta(params);
    return send(m, { type: "cache", op, name: params.name, request: params.request, response: params.response });
  }
  return {
    "cache.keys": (p) => call(p, "keys"),
    "cache.openList": (p) => call(p, "list"),
    "cache.match": (p) => call(p, "match"),
    "cache.put": (p) => call(p, "put"),
    "cache.delete": (p) => call(p, "delete"),
    "cache.clear": (p) => call(p, "clear"),
  };
}

export function createPageStorageApi() {
  async function call(params, op, area) {
    const m = await meta(params);
    return send(m, { type: "storage", op, area, key: params.key, value: params.value });
  }
  return {
    "storage.page.local.keys": (p) => call(p, "keys", "local"),
    "storage.page.local.get": (p) => call(p, "get", "local"),
    "storage.page.local.set": (p) => call(p, "set", "local"),
    "storage.page.local.remove": (p) => call(p, "remove", "local"),
    "storage.page.local.clear": (p) => call(p, "clear", "local"),
    "storage.page.session.keys": (p) => call(p, "keys", "session"),
    "storage.page.session.get": (p) => call(p, "get", "session"),
    "storage.page.session.set": (p) => call(p, "set", "session"),
    "storage.page.session.remove": (p) => call(p, "remove", "session"),
    "storage.page.session.clear": (p) => call(p, "clear", "session"),
  };
}

export function createCookiesApi() {
  async function getAll(params) {
    const details = {};
    if (params.url) details.url = params.url;
    if (params.storeId) details.storeId = params.storeId;
    if (params.domain) details.domain = params.domain;
    if (params.name) details.name = params.name;
    return cb(chrome.cookies.getAll, details).catch(() => []);
  }
  async function get(params) { return cb(chrome.cookies.get, { url: params.url, name: params.name }); }
  async function set(params) {
    return cb(chrome.cookies.set, {
      url: params.url, name: params.name, value: String(params.value),
      domain: params.domain, path: params.path || "/",
      secure: !!params.secure, httpOnly: !!params.httpOnly,
      sameSite: params.sameSite || "no_restriction", expirationDate: params.expirationDate,
    });
  }
  async function remove(params) {
    return cb(chrome.cookies.remove, { url: params.url, name: params.name, storeId: params.storeId });
  }
  return {
    "cookies.getAll": getAll,
    "cookies.get": get,
    "cookies.set": set,
    "cookies.remove": remove,
  };
}

export function createExtStorageApi() {
  function jget(area, params) {
    return new Promise((resolve) => {
      chrome.storage[area].get(params.keys || null, (res) => { resolve(chrome.runtime.lastError ? {} : res); });
    });
  }
  function jset(area, params) {
    return new Promise((resolve, reject) => {
      chrome.storage[area].set(params.items || {}, () => {
        const e = chrome.runtime.lastError;
        if (e) reject(new Error(e.message)); else resolve({ ok: true });
      });
    });
  }
  function jremove(area, params) {
    return new Promise((resolve, reject) => {
      chrome.storage[area].remove(params.keys || [], () => {
        const e = chrome.runtime.lastError;
        if (e) reject(new Error(e.message)); else resolve({ ok: true });
      });
    });
  }
  function jclear(area) {
    return new Promise((resolve, reject) => {
      chrome.storage[area].clear(() => {
        const e = chrome.runtime.lastError;
        if (e) reject(new Error(e.message)); else resolve({ ok: true });
      });
    });
  }
  return {
    "storage.local.get": (p) => jget("local", p),
    "storage.local.set": (p) => jset("local", p),
    "storage.local.remove": (p) => jremove("local", p),
    "storage.local.clear": () => jclear("local"),
    "storage.session.get": (p) => jget("session", p),
    "storage.session.set": (p) => jset("session", p),
    "storage.session.remove": (p) => jremove("session", p),
    "storage.session.clear": () => jclear("session"),
  };
}