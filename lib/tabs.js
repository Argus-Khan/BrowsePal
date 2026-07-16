import { chrome, cb } from "./browser.js";

export function createTabsApi() {
  async function list() {
    const tabs = await cb(chrome.tabs.query, {});
    return tabs.map((t) => ({
      id: t.id, url: t.url, title: t.title,
      active: t.active, windowId: t.windowId, incognito: t.incognito,
    }));
  }
  async function active() {
    const tabs = await cb(chrome.tabs.query, { active: true, currentWindow: true });
    if (!tabs.length) return null;
    const t = tabs[0];
    return { id: t.id, url: t.url, title: t.title, active: true, windowId: t.windowId };
  }
  async function create(params = {}) {
    return cb(chrome.tabs.create, { url: params.url || "about:blank", active: params.active !== false });
  }
  async function close(params) {
    await cb(chrome.tabs.remove, params.tabId);
    return { closed: true };
  }
  async function activate(params) {
    await cb(chrome.tabs.update, params.tabId, { active: true });
    await cb(chrome.windows.update, (await cb(chrome.tabs.get, params.tabId)).windowId, { focused: true }).catch(() => {});
    return { activated: true };
  }
  return { list, active, create, close, activate };
}