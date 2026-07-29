import { dbgAttach, dbgDetach, dbgSend } from "./browser.js";

export class CDP {
  constructor() {
    this.attached = new Set();
    this.listeners = new Set();
    this._wire = false;
    this.available = !!(chrome && chrome.debugger && typeof chrome.debugger.attach === "function");
  }

  async hasPermission() {
    if (!this.available) return false;
    if (!chrome.permissions) return true;
    return new Promise((resolve) => {
      chrome.permissions.contains({ permissions: ["debugger"] }, (ok) => resolve(!!ok));
    });
  }

  async requestPermission() {
    if (!this.available) return { granted: false, reason: "chrome.debugger is not available on this browser" };
    if (!chrome.permissions) return { granted: true };
    return new Promise((resolve) => {
      chrome.permissions.request({ permissions: ["debugger"] }, (granted) => {
        resolve({ granted: !!granted });
      });
    });
  }

  _ensureHandlers() {
    if (this._wire) return;
    this._wire = true;
    if (!this.available) return;
    chrome.debugger.onEvent.addListener((src, method, params) => {
      if (!src || src.tabId == null) return;
      for (const fn of this.listeners) {
        try { fn({ tabId: src.tabId, method, params }); } catch (e) {}
      }
    });
    chrome.debugger.onDetach.addListener((src) => {
      if (src && src.tabId != null) this.attached.delete(src.tabId);
      this.listeners.forEach((fn) => { try { fn({ tabId: src.tabId, method: "Debugger.detached", params: {} }); } catch (e) {} });
    });
  }

  async attach(tabId) {
    if (this.attached.has(tabId)) return;
    if (!this.available) {
      throw Object.assign(
        new Error("chrome.debugger is not available on this browser (Firefox/Safari). net.* CDP commands require Chromium. Use webRequest-based commands instead."),
        { code: -32010 }
      );
    }
    if (chrome.permissions && !(await this.hasPermission())) {
      throw Object.assign(
        new Error("debugger permission not granted. Open the extension options and click 'Grant debugger (CDP) permission', or enable it on the extension details page."),
        { code: -32011 }
      );
    }
    this._ensureHandlers();
    await dbgAttach(tabId);
    this.attached.add(tabId);
  }

  async detach(tabId) {
    if (!this.attached.has(tabId)) return;
    await dbgDetach(tabId);
    this.attached.delete(tabId);
  }

  async detachAll() {
    const all = [...this.attached];
    await Promise.all(all.map((t) => this.detach(t).catch(() => {})));
  }

  async send(tabId, method, params = {}) {
    return dbgSend(tabId, method, params);
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}