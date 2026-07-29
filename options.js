const DEFAULTS = { url: "ws://localhost:9222", token: "", autoReconnect: true };

function getStored() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULTS, (cfg) => {
      if (chrome.runtime.lastError) resolve({ ...DEFAULTS });
      else resolve(cfg);
    });
  });
}

const $ = (id) => document.getElementById(id);

async function init() {
  const cfg = await getStored();
  $("url").value = cfg.url;
  $("token").value = cfg.token || "";
  $("autoReconnect").checked = !!cfg.autoReconnect;
  initDebuggerUi();
}

function initDebuggerUi() {
  const hasDebuggerApi = !!(typeof chrome !== "undefined" && chrome.debugger && typeof chrome.debugger.attach === "function");
  if (!hasDebuggerApi) return; // Firefox / Safari — hide the section entirely.
  const section = $("debuggerSection");
  const status = $("debuggerStatus");
  section.hidden = false;

  function refresh() {
    if (!chrome.permissions) { status.textContent = "granted"; return; }
    chrome.permissions.contains({ permissions: ["debugger"] }, (ok) => {
      status.textContent = ok ? "granted" : "not granted";
    });
  }
  refresh();

  $("grantDebugger").addEventListener("click", () => {
    if (!chrome.permissions) { showStatus("debugger permission cannot be requested on this browser."); return; }
    chrome.permissions.request({ permissions: ["debugger"] }, (granted) => {
      refresh();
      showStatus(granted ? "debugger permission granted." : "debugger permission was denied.");
    });
  });
}

$("save").addEventListener("click", async () => {
  const patch = {
    url: $("url").value.trim() || DEFAULTS.url,
    token: $("token").value.trim(),
    autoReconnect: $("autoReconnect").checked,
  };
  await new Promise((resolve) => chrome.storage.local.set(patch, resolve));
  chrome.runtime.sendMessage({ jsonrpc: "2.0", method: "agent.config.set", params: patch }, () => {
    showStatus("Saved. The background will reconnect with the new settings.");
  });
});

$("reconnect").addEventListener("click", async () => {
  showStatus("reconnecting…");
  chrome.runtime.sendMessage({ jsonrpc: "2.0", id: Date.now(), method: "agent.reconnect" }, (res) => {
    if (chrome.runtime.lastError || !res) {
      showStatus("Could not reach background: " + (chrome.runtime.lastError?.message || "no response"));
      return;
    }
    showStatus(JSON.stringify(res.result || res, null, 2));
  });
});

$("status").addEventListener("click", async () => {
  showStatus("querying…");
  chrome.runtime.sendMessage({ jsonrpc: "2.0", id: Date.now(), method: "agent.status" }, (res) => {
    if (chrome.runtime.lastError || !res) {
      showStatus("Could not reach background: " + (chrome.runtime.lastError?.message || "no response"));
      return;
    }
    showStatus(JSON.stringify(res.result || res, null, 2));
  });
});

function showStatus(text) {
  const el = $("out");
  el.hidden = false;
  el.textContent = text;
}

init();