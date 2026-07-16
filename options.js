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