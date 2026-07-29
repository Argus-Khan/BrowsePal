function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

async function getCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function getHostname(url) {
  try { return new URL(url).hostname; } catch (e) { return null; }
}

async function bg(method, params) {
  const res = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ jsonrpc: "2.0", id: Date.now(), method, params }, resolve);
  });
  return (res && res.result) || res || {};
}

async function refresh() {
  try {
    const config = await bg("agent.config.get");
    const disabled = !!config.disabled;
    const excluded = config.excludedUrls || [];

    const pill = document.getElementById("statusPill");
    pill.textContent = disabled ? "disabled" : "enabled";
    pill.className = "pill " + (disabled ? "off" : "on");

    document.getElementById("enabledToggle").checked = !disabled;

    const tab = await getCurrentTab();
    const host = tab ? getHostname(tab.url) : null;
    const isExcluded = host ? excluded.some((p) => host === p || host.endsWith("." + p)) : false;

    document.getElementById("excludeCurrent").style.display = host && !isExcluded ? "" : "none";
    document.getElementById("allowCurrent").style.display = host && isExcluded ? "" : "none";

    const list = document.getElementById("excludedList");
    const empty = document.getElementById("emptyHint");
    list.innerHTML = "";
    if (excluded.length) {
      empty.style.display = "none";
      for (const pattern of excluded) {
        const div = document.createElement("div");
        div.className = "excluded-item";
        div.innerHTML = `<span>${esc(pattern)}</span><span class="remove" data-pattern="${esc(pattern)}">✕</span>`;
        div.querySelector(".remove").addEventListener("click", async (e) => {
          e.stopPropagation();
          const updated = excluded.filter((p) => p !== pattern);
          await chrome.storage.local.set({ excludedUrls: updated });
          chrome.runtime.sendMessage({ jsonrpc: "2.0", method: "agent.config.set", params: { excludedUrls: updated } });
          refresh();
        });
        list.appendChild(div);
      }
    } else {
      empty.style.display = "";
    }
  } catch (e) {
    console.error("popup refresh error:", e);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("enabledToggle").addEventListener("change", async (e) => {
    try {
      const disabled = !e.target.checked;
      await chrome.storage.local.set({ disabled });
      chrome.runtime.sendMessage({ jsonrpc: "2.0", method: "agent.config.set", params: { disabled } });
      refresh();
    } catch (err) { console.error(err); }
  });

  document.getElementById("excludeCurrent").addEventListener("click", async () => {
    try {
      const tab = await getCurrentTab();
      const host = getHostname(tab?.url);
      if (!host) return;
      const config = await bg("agent.config.get");
      const excluded = config.excludedUrls || [];
      if (excluded.includes(host)) return;
      const updated = [...excluded, host];
      await chrome.storage.local.set({ excludedUrls: updated });
      chrome.runtime.sendMessage({ jsonrpc: "2.0", method: "agent.config.set", params: { excludedUrls: updated } });
      refresh();
    } catch (err) { console.error(err); }
  });

  document.getElementById("allowCurrent").addEventListener("click", async () => {
    try {
      const tab = await getCurrentTab();
      const host = getHostname(tab?.url);
      if (!host) return;
      const config = await bg("agent.config.get");
      const excluded = config.excludedUrls || [];
      const updated = excluded.filter((p) => host !== p && !host.endsWith("." + p));
      await chrome.storage.local.set({ excludedUrls: updated });
      chrome.runtime.sendMessage({ jsonrpc: "2.0", method: "agent.config.set", params: { excludedUrls: updated } });
      refresh();
    } catch (err) { console.error(err); }
  });

  document.getElementById("openOptions").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById("openSite").addEventListener("click", async () => {
    const tab = await getCurrentTab();
    if (tab?.url && !tab.url.startsWith("chrome://") && !tab.url.startsWith("about:")) {
      chrome.tabs.create({ url: tab.url });
    }
  });

  refresh();
});
