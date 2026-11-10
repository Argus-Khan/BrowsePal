// ─── Diagnostic: Window Dimension Monitor ─────────────────────────────────
// Logs window + document dimensions at every lifecycle point to diagnose
// popup shrink issues (e.g. pop-shell tiling interference).
const TAG = "[popup-diag]";
function dimSnapshot(label) {
  const w = window;
  const d = document;
  const de = d.documentElement;
  console.log(TAG, label, JSON.stringify({
    innerW: w.innerWidth,
    innerH: w.innerHeight,
    outerW: w.outerWidth,
    outerH: w.outerHeight,
    screenX: w.screenX,
    screenY: w.screenY,
    docEl_clientW: de.clientWidth,
    docEl_clientH: de.clientHeight,
    docEl_offsetW: de.offsetWidth,
    docEl_offsetH: de.offsetHeight,
    body_clientW: d.body ? d.body.clientWidth : null,
    body_clientH: d.body ? d.body.clientHeight : null,
    body_offsetW: d.body ? d.body.offsetWidth : null,
    body_offsetH: d.body ? d.body.offsetHeight : null,
    doc_scrollW: d.scrollWidth,
    doc_scrollH: d.scrollHeight,
    devicePixelRatio: w.devicePixelRatio,
  }));
}

// Log immediately (before DOM is ready)
dimSnapshot("script-start");

// Watch for ANY dimension change
const ro = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const t = entry.target;
    const label = t === document.documentElement ? "html" : t === document.body ? "body" : t.tagName;
    console.log(TAG, "resize-observer:" + label, JSON.stringify({
      clientW: entry.contentRect.width,
      clientH: entry.contentRect.height,
      innerW: window.innerWidth,
      outerW: window.outerWidth,
    }));
  }
});
// Will observe once body exists

window.addEventListener("resize", () => {
  dimSnapshot("window-resize-event");
});

// Periodic polling to catch changes that don't fire events
let _pollCount = 0;
const _pollLog = [];
function pollDims() {
  _pollCount++;
  const snap = {
    t: Date.now(),
    innerW: window.innerWidth,
    outerW: window.outerWidth,
    bodyW: document.body ? document.body.offsetWidth : null,
    docW: document.documentElement.offsetWidth,
  };
  _pollLog.push(snap);
  // Log every poll for first 30, then every 10th
  if (_pollCount <= 30 || _pollCount % 10 === 0) {
    console.log(TAG, "poll#" + _pollCount, JSON.stringify(snap));
  }
}
const _pollTimer = setInterval(pollDims, 200);
// Stop polling after 15 seconds
setTimeout(() => { clearInterval(_pollTimer); console.log(TAG, "polling stopped after", _pollCount, "samples"); }, 15000);

// ─── Existing popup logic ──────────────────────────────────────────────────

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
    list.replaceChildren();
    if (excluded.length) {
      empty.style.display = "none";
      for (const pattern of excluded) {
        const div = document.createElement("div");
        div.className = "excluded-item";
        const label = document.createElement("span");
        label.textContent = pattern;
        const remove = document.createElement("span");
        remove.className = "remove";
        remove.textContent = "✕";
        remove.dataset.pattern = pattern;
        remove.addEventListener("click", async (e) => {
          e.stopPropagation();
          const updated = excluded.filter((p) => p !== pattern);
          await chrome.storage.local.set({ excludedUrls: updated });
          chrome.runtime.sendMessage({ jsonrpc: "2.0", method: "agent.config.set", params: { excludedUrls: updated } });
          refresh();
        });
        div.append(label, remove);
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
  dimSnapshot("DOMContentLoaded");

  // Start observing body and html for size changes
  if (document.body) ro.observe(document.body);
  ro.observe(document.documentElement);

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

  refresh().then(() => dimSnapshot("after-refresh"));
});

window.addEventListener("load", () => {
  dimSnapshot("window-load");
  // Log again shortly after load to catch late layout shifts
  setTimeout(() => dimSnapshot("load+500ms"), 500);
  setTimeout(() => dimSnapshot("load+1000ms"), 1000);
  setTimeout(() => dimSnapshot("load+2000ms"), 2000);
});
