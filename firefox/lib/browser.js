const api = (typeof chrome !== "undefined") ? chrome : (typeof browser !== "undefined") ? browser : null;

export { api as chrome };

export function cb(fn, ...args) {
  return new Promise((resolve, reject) => {
    try {
      fn(...args, (res) => {
        const e = api.runtime && api.runtime.lastError;
        if (e) reject(new Error(e.message));
        else resolve(res);
      });
    } catch (e) { reject(e); }
  });
}

export function dbgAttach(tabId, version = "1.3") {
  return new Promise((resolve, reject) => {
    try {
      api.debugger.attach({ tabId }, version, () => {
        const e = api.runtime && api.runtime.lastError;
        if (e) reject(new Error(e.message));
        else resolve();
      });
    } catch (e) { reject(e); }
  });
}

export function dbgDetach(tabId) {
  return new Promise((resolve) => {
    try { api.debugger.detach({ tabId }, () => resolve()); }
    catch (e) { resolve(); }
  });
}

export function dbgSend(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    try {
      api.debugger.sendCommand({ tabId }, method, params, (result) => {
        const e = api.runtime && api.runtime.lastError;
        if (e) reject(new Error(e.message));
        else resolve(result);
      });
    } catch (e) { reject(e); }
  });
}

export function activeTabId() {
  return cb(api.tabs.query, { active: true, currentWindow: true }).then((tabs) => {
    if (!tabs || !tabs.length) throw Object.assign(new Error("No active tab"), { code: -32001 });
    return tabs[0].id;
  });
}

export function withTab(tabId) {
  return (tabId === undefined || tabId === null) ? activeTabId() : Promise.resolve(tabId);
}