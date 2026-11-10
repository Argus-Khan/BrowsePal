import { DEFAULTS } from "./lib/defaults.js";

function getStored() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULTS, (cfg) => {
      if (chrome.runtime.lastError) resolve({ ...DEFAULTS });
      else resolve(cfg);
    });
  });
}

function bg(method, params) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ jsonrpc: "2.0", id: Date.now(), method, params }, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res && res.result !== undefined ? res.result : res);
    });
  });
}

const $ = (id) => document.getElementById(id);

async function init() {
  const cfg = await getStored();
  $("url").value = cfg.url;
  $("token").value = cfg.token || "";
  $("autoReconnect").checked = !!cfg.autoReconnect;
  $("allowRead").checked = cfg.allowRead !== false;
  $("allowInteract").checked = cfg.allowInteract !== false;
  $("excludedUrls").value = (cfg.excludedUrls || []).join("\n");
  initDebuggerUi();
  initLogUi();
}

function initDebuggerUi() {
  // Bracket access — static "chrome.debugger.attach" trips Firefox AMO compat lint.
  const dbg = typeof chrome !== "undefined" ? chrome["debugger"] : null;
  const hasDebuggerApi = !!(dbg && typeof dbg["attach"] === "function");
  if (!hasDebuggerApi) return;
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

function initLogUi() {
  let logTimer;

  function fmt(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString() + "." + String(d.getMilliseconds()).padStart(3, "0");
  }

  function emptyRow(text) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "empty";
    td.textContent = text;
    tr.appendChild(td);
    return tr;
  }

  async function fetchLog() {
    try {
      const entries = await bg("agent.passiveLog", { limit: 100 });
      const filter = ($("logFilter").value || "").toLowerCase();
      const tbody = $("logBody");
      const badge = $("logBadge");
      badge.hidden = false;
      badge.textContent = entries.length;
      tbody.replaceChildren();
      let shown = 0;
      for (const e of entries) {
        if (filter && !e.url.toLowerCase().includes(filter) && !e.method.toLowerCase().includes(filter)) continue;
        if (shown++ >= 50) break;
        const tr = document.createElement("tr");
        const cells = [
          ["nowrap", fmt(e.ts || e.timeStamp)],
          ["", e.method],
          ["", e.type],
          ["url", e.url],
          ["", e.tabId ?? ""],
        ];
        for (const [cls, text] of cells) {
          const td = document.createElement("td");
          if (cls) td.className = cls;
          td.textContent = text == null ? "" : String(text);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      if (!shown) tbody.appendChild(emptyRow("No entries"));
    } catch (e) {
      $("logBody").replaceChildren(emptyRow(e.message || String(e)));
    }
  }

  $("logFilter").addEventListener("input", fetchLog);
  $("logRefresh").addEventListener("click", fetchLog);
  $("logSection").addEventListener("toggle", () => {
    if ($("logSection").open) { fetchLog(); logTimer = setInterval(fetchLog, 3000); }
    else { clearInterval(logTimer); }
  });
}

$("save").addEventListener("click", async () => {
  const rawExcluded = $("excludedUrls").value.trim();
  const patch = {
    url: $("url").value.trim() || DEFAULTS.url,
    token: $("token").value.trim(),
    autoReconnect: $("autoReconnect").checked,
    allowRead: $("allowRead").checked,
    allowInteract: $("allowInteract").checked,
    excludedUrls: rawExcluded ? rawExcluded.split("\n").map((s) => s.trim()).filter(Boolean) : [],
  };
  await new Promise((resolve) => chrome.storage.local.set(patch, resolve));
  chrome.runtime.sendMessage({ jsonrpc: "2.0", method: "agent.config.set", params: patch }, () => {
    showStatus("Saved. Settings applied.");
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
