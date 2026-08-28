/**
 * Browser Agent Client SDK
 * 
 * High-level API for AI agents to interact with the browser via the
 * Browser Agent Bridge extension.
 * 
 * Usage:
 *   import { BrowserAgent } from "./lib/client.mjs";
 *   const agent = await BrowserAgent.connect();
 *   const page = await agent.page();
 *   const snap = await page.snapshot();
 *   await page.click(snap.find("Submit button").ref);
 *   await page.close();
 */

import WebSocket from "ws";

// ─── Low-level RPC client ───────────────────────────────────────────────────

class RpcClient {
  constructor(ws) {
    this._ws = ws;
    this._id = 1;
    this._pending = new Map();
    this._handlers = new Map();

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Notification (no id)
        if (msg.method && msg.id == null) {
          const h = this._handlers.get(msg.method);
          if (h) h(msg.params);
          // Wildcard handler
          const wild = this._handlers.get("*");
          if (wild) wild(msg.method, msg.params);
          return;
        }
        // Response
        if (msg.id != null && this._pending.has(msg.id)) {
          const { resolve, reject, timer } = this._pending.get(msg.id);
          clearTimeout(timer);
          this._pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch {}
    });
  }

  rpc(method, params = {}, timeoutMs = 30000) {
    const id = this._id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  on(method, handler) {
    this._handlers.set(method, handler);
    return () => this._handlers.delete(method);
  }
}

// ─── Snapshot helper ────────────────────────────────────────────────────────

class Snapshot {
  constructor(data) {
    this._data = data;
    this._refs = new Map();
    this._indexRefs(data.snapshot);
  }

  _indexRefs(node) {
    if (!node) return;
    if (node.ref) this._refs.set(node.ref, node);
    if (node.children) {
      for (const child of node.children) this._indexRefs(child);
    }
  }

  /** Find a ref by accessible name (case-insensitive substring match) */
  find(name) {
    const lower = name.toLowerCase();
    // Exact match first
    for (const [, node] of this._refs) {
      if (node.name && node.name.toLowerCase() === lower) return node;
    }
    // Substring match
    for (const [, node] of this._refs) {
      if (node.name && node.name.toLowerCase().includes(lower)) return node;
    }
    return null;
  }

  /** Find all refs matching a role */
  findAll(role) {
    const results = [];
    for (const [, node] of this._refs) {
      if (node.role === role) results.push(node);
    }
    return results;
  }

  /** Get a ref by ID */
  ref(id) {
    return this._refs.get(id) || null;
  }

  /** List all refs */
  refs() {
    return [...this._refs.values()];
  }

  /** Get the raw snapshot tree */
  get tree() {
    return this._data.snapshot;
  }

  /** Get page URL and title */
  get url() { return this._data.url; }
  get title() { return this._data.title; }
}

// ─── Page handle ────────────────────────────────────────────────────────────

class Page {
  constructor(rpc, tabId) {
    this._rpc = rpc;
    this._tabId = tabId;
    this._snapshot = null;
  }

  /** Get the active tab ID */
  async _resolveTab() {
    if (this._tabId != null) return this._tabId;
    const tab = await this._rpc.rpc("tabs.active");
    return tab ? tab.id : null;
  }

  /** Take a snapshot of the page */
  async snapshot(opts = {}) {
    const tabId = await this._resolveTab();
    const result = await this._rpc.rpc("page.snapshot", { tabId, ...opts });
    this._snapshot = new Snapshot(result);
    return this._snapshot;
  }

  /** Execute an action plan (one round trip) */
  async act(plan) {
    const tabId = await this._resolveTab();
    return this._rpc.rpc("page.act", { tabId, plan });
  }

  /** Click an element by ref or selector */
  async click(refOrSelector) {
    const params = { tabId: await this._resolveTab() };
    if (typeof refOrSelector === "string" && refOrSelector.startsWith("e")) {
      params.ref = refOrSelector;
    } else {
      params.selector = refOrSelector;
    }
    return this._rpc.rpc("page.click", params);
  }

  /** Fill an input by ref or selector */
  async fill(refOrSelector, value) {
    const params = { tabId: await this._resolveTab(), value };
    if (typeof refOrSelector === "string" && refOrSelector.startsWith("e")) {
      params.ref = refOrSelector;
    } else {
      params.selector = refOrSelector;
    }
    return this._rpc.rpc("page.fill", params);
  }

  /** Type text character by character */
  async type(text, selector) {
    const params = { tabId: await this._resolveTab(), text };
    if (selector) params.selector = selector;
    return this._rpc.rpc("page.type", params);
  }

  /** Press a key */
  async press(key, refOrSelector) {
    const params = { tabId: await this._resolveTab(), key };
    if (refOrSelector) {
      if (typeof refOrSelector === "string" && refOrSelector.startsWith("e")) {
        params.ref = refOrSelector;
      } else {
        params.selector = refOrSelector;
      }
    }
    return this._rpc.rpc("page.pressKey", params);
  }

  /** Hover over an element */
  async hover(refOrSelector) {
    const params = { tabId: await this._resolveTab() };
    if (typeof refOrSelector === "string" && refOrSelector.startsWith("e")) {
      params.ref = refOrSelector;
    } else {
      params.selector = refOrSelector;
    }
    return this._rpc.rpc("page.hover", params);
  }

  /** Scroll the page or an element */
  async scroll(dx = 0, dy = 0, refOrSelector) {
    const params = { tabId: await this._resolveTab(), dx, dy };
    if (refOrSelector) params.selector = refOrSelector;
    return this._rpc.rpc("page.scroll", params);
  }

  /** Wait for an element or condition */
  async waitFor(refOrSelector, opts = {}) {
    const params = { tabId: await this._resolveTab(), ...opts };
    if (typeof refOrSelector === "string" && refOrSelector.startsWith("e")) {
      params.ref = refOrSelector;
    } else if (refOrSelector) {
      params.selector = refOrSelector;
    }
    return this._rpc.rpc("page.waitFor", params);
  }

  /** Read text content of an element or the page */
  async read(refOrSelector) {
    const params = { tabId: await this._resolveTab() };
    if (refOrSelector) {
      if (typeof refOrSelector === "string" && refOrSelector.startsWith("e")) {
        params.ref = refOrSelector;
      } else {
        params.selector = refOrSelector;
      }
    }
    return this._rpc.rpc("page.getText", params);
  }

  /** Navigate to a URL */
  async goto(url) {
    return this._rpc.rpc("page.navigate", { tabId: await this._resolveTab(), url });
  }

  /** Reload the page */
  async reload(opts = {}) {
    return this._rpc.rpc("page.reload", { tabId: await this._resolveTab(), ...opts });
  }

  /** Take a screenshot */
  async screenshot(opts = {}) {
    return this._rpc.rpc("page.screenshot", { tabId: await this._resolveTab(), ...opts });
  }

  /** Evaluate JavaScript in the page */
  async evaluate(code) {
    return this._rpc.rpc("page.eval", { tabId: await this._resolveTab(), code });
  }

  /** Subscribe to events */
  async subscribe(events) {
    return this._rpc.rpc("page.subscribe", { tabId: await this._resolveTab(), events });
  }

  /** Unsubscribe from events */
  async unsubscribe(subscriptionId) {
    return this._rpc.rpc("page.unsubscribe", { tabId: await this._resolveTab(), subscriptionId });
  }

  /** Get the underlying tab info */
  async info() {
    const tabs = await this._rpc.rpc("tabs.list");
    return tabs.find((t) => t.id === this._tabId) || null;
  }
}

// ─── BrowserAgent (main entry point) ────────────────────────────────────────

class BrowserAgent {
  constructor(ws, rpc) {
    this._ws = ws;
    this._rpc = rpc;
    this._pages = new Map();
  }

  /**
   * Connect to the Browser Agent Bridge extension.
   * @param {string|number} [hostOrPort="127.0.0.1:9222] - host:port or just port
   * @param {object} [opts]
   * @param {string} [opts.token] - shared auth token
   * @param {number} [opts.timeoutMs=30000] - default RPC timeout
   * @param {Function} [opts.onNotification] - notification handler
   * @returns {Promise<BrowserAgent>}
   */
  static async connect(hostOrPort = "127.0.0.1:9222", opts = {}) {
    let url;
    if (typeof hostOrPort === "number") {
      url = `ws://127.0.0.1:${hostOrPort}`;
    } else if (typeof hostOrPort === "string" && !hostOrPort.includes(":")) {
      url = `ws://127.0.0.1:${hostOrPort}`;
    } else {
      url = `ws://${hostOrPort}`;
    }

    const { token, timeoutMs = 30000, onNotification } = opts;

    const protocols = token ? [token] : [];
    const ws = new WebSocket(url, protocols.length ? protocols : undefined);

    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });

    const rpc = new RpcClient(ws);
    const agent = new BrowserAgent(ws, rpc);

    // Set up notification forwarding
    if (onNotification) {
      rpc.on("*", onNotification);
    }

    // Verify connection
    try {
      await rpc.rpc("ping", {}, 5000);
    } catch {
      // Extension may not support ping yet
    }

    return agent;
  }

  /** Get or create a Page handle for a tab */
  async page(tabId) {
    if (tabId != null && this._pages.has(tabId)) {
      return this._pages.get(tabId);
    }

    if (tabId == null) {
      const active = await this._rpc.rpc("tabs.active");
      tabId = active ? active.id : null;
      if (tabId == null) throw new Error("No active tab");
    }

    const page = new Page(this._rpc, tabId);
    this._pages.set(tabId, page);
    return page;
  }

  /** List all tabs */
  async tabs() {
    return this._rpc.rpc("tabs.list");
  }

  /** Get the active tab */
  async activeTab() {
    return this._rpc.rpc("tabs.active");
  }

  /** Create a new tab */
  async newTab(url) {
    return this._rpc.rpc("tabs.create", { url });
  }

  /** Close a tab */
  async closeTab(tabId) {
    this._pages.delete(tabId);
    return this._rpc.rpc("tabs.close", { tabId });
  }

  /** Activate/focus a tab */
  async activateTab(tabId) {
    return this._rpc.rpc("tabs.activate", { tabId });
  }

  /** Get extension status */
  async status() {
    return this._rpc.rpc("agent.status");
  }

  /** Get/set config */
  async config(patch) {
    if (patch) return this._rpc.rpc("agent.config.set", patch);
    return this._rpc.rpc("agent.config.get");
  }

  /** Network: enable CDP capture */
  async netEnable(tabId) {
    return this._rpc.rpc("net.enable", { tabId });
  }

  /** Network: get request log */
  async netLog(opts = {}) {
    return this._rpc.rpc("net.getLog", opts);
  }

  /** Cookies */
  async cookies(opts = {}) {
    return this._rpc.rpc("cookies.getAll", opts);
  }

  /** Low-level RPC access for advanced usage */
  get rpc() {
    return (method, params) => this._rpc.rpc(method, params);
  }

  /** Close the connection */
  close() {
    for (const page of this._pages.values()) {
      // nothing to clean up per-page
    }
    this._pages.clear();
    this._ws.close();
  }
}

export { BrowserAgent, Page, Snapshot, RpcClient };
export default BrowserAgent;
