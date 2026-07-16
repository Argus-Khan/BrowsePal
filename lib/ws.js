const DEFAULTS = {
  url: "ws://localhost:9222",
  token: "",
  autoReconnect: true,
};

export function loadConfig() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(DEFAULTS, (cfg) => {
        if (chrome.runtime.lastError) resolve({ ...DEFAULTS });
        else resolve(cfg);
      });
    } catch (e) { resolve({ ...DEFAULTS }); }
  });
}

export function saveConfig(patch) {
  return new Promise((resolve) => {
    chrome.storage.local.set(patch, () => resolve());
  });
}

export function createTransport(cfg, onMessage, onState) {
  let ws = null;
  let closedByUser = false;
  let attempts = 0;
  let pingTimer = null;
  let pongTimer = null;
  const queue = [];

  function flush() {
    while (ws && ws.readyState === 1 && queue.length) {
      try { ws.send(queue.shift()); } catch (e) {}
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify({ jsonrpc: "2.0", method: "ping" })); } catch (e) {}
      }
    }, 25000);
    pongTimer = setInterval(() => {
      if (ws && ws.readyState !== 1) ws.close();
    }, 60000);
  }
  function stopHeartbeat() {
    if (pingTimer) clearInterval(pingTimer); pingTimer = null;
    if (pongTimer) clearInterval(pongTimer); pongTimer = null;
  }

  function scheduleReconnect() {
    if (!cfg.autoReconnect || closedByUser) return;
    const delay = Math.min(30000, 500 * Math.pow(2, Math.min(attempts++, 8)));
    setTimeout(() => { if (!closedByUser) connect(); }, delay);
  }

  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    const protocols = cfg.token ? [cfg.token] : [];
    console.log("[bridge] connecting WebSocket to", cfg.url, protocols.length ? "with token" : "no token");
    try {
      ws = new WebSocket(cfg.url, protocols.length ? protocols : undefined);
    } catch (e) {
      console.error("[bridge] WebSocket constructor threw:", e);
      onState && onState({ connected: false, error: e.message });
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      attempts = 0;
      flush();
      startHeartbeat();
      onState && onState({ connected: true });
      try { ws.send(JSON.stringify({ jsonrpc: "2.0", method: "agent.hello", params: { ua: navigator.userAgent, version: chrome.runtime.getManifest().version } })); } catch (e) {}
    };
    ws.onmessage = (ev) => {
      try { const m = JSON.parse(ev.data); if (m && m.method === "pong") return; onMessage && onMessage(m); }
      catch (e) {}
    };
    ws.onclose = () => {
      stopHeartbeat();
      onState && onState({ connected: false });
      scheduleReconnect();
    };
    ws.onerror = () => { try { ws && ws.close(); } catch (e) {} };
  }

  function sendObj(obj) {
    const data = JSON.stringify(obj);
    if (ws && ws.readyState === 1) {
      try { ws.send(data); return true; } catch (e) { queue.push(data); return false; }
    }
    queue.push(data);
    return false;
  }

  function close() {
    closedByUser = true;
    stopHeartbeat();
    if (ws) { try { ws.close(); } catch (e) {} }
  }

  function reopen(newCfg) {
    cfg = { ...cfg, ...newCfg };
    closedByUser = false;
    if (ws) { try { ws.close(); } catch (e) {} }
  }

  return { connect, sendObj, close, reopen, get ready() { return ws && ws.readyState === 1; } };
}