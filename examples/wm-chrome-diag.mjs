import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:9222");
let id = 1;
const pending = new Map();

function rpc(method, params = {}, timeoutMs = 30000) {
  const reqId = id++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error(`timeout: ${method}`));
    }, timeoutMs);
    pending.set(reqId, { resolve, reject, timer });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params }));
  });
}

ws.on("message", (data) => {
  try {
    const msg = JSON.parse(data.toString());
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  } catch {}
});

await new Promise((resolve, reject) => {
  ws.on("open", resolve);
  ws.on("error", reject);
});

const tabs = await rpc("tabs.list");
console.log("TABS", JSON.stringify(tabs, null, 2));

const portal = (tabs || []).find((t) => /wellnessmetric\.net\/portal/i.test(t.url || ""));
const live = (tabs || []).find((t) => /wellnessmetric\.net/i.test(t.url || ""));
console.log("PORTAL_TAB", portal || live || null);

const tabId = (portal || live)?.id;
if (!tabId) {
  console.log("NO_LIVE_TAB");
  ws.close();
  process.exit(0);
}

await rpc("tabs.activate", { tabId });

const text = await rpc("page.getText", { tabId });
console.log("\nPAGE_TEXT_START\n", String(text || "").slice(0, 4000), "\nPAGE_TEXT_END\n");

try {
  const shot = await rpc("page.screenshot", { tabId, format: "png" });
  if (shot && typeof shot === "string") {
    const { writeFileSync } = await import("node:fs");
    const b64 = shot.includes(",") ? shot.split(",").pop() : shot;
    writeFileSync("/tmp/wm-portal.png", Buffer.from(b64, "base64"));
    console.log("SCREENSHOT /tmp/wm-portal.png", Buffer.from(b64, "base64").length);
  } else if (shot && shot.data) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync("/tmp/wm-portal.png", Buffer.from(shot.data, "base64"));
    console.log("SCREENSHOT /tmp/wm-portal.png bytes", Buffer.from(shot.data, "base64").length);
  } else {
    console.log("SCREENSHOT_SHAPE", typeof shot, Object.keys(shot || {}));
  }
} catch (e) {
  console.log("SCREENSHOT_ERR", e.message);
}

const probe = await rpc("page.eval", {
  tabId,
  code: `(() => {
    const cfg = window.WM_CONSULT || window.WM_CONSULT_BOOKING || null;
    const scripts = [...document.querySelectorAll('script[src*="clinician"],script[src*="booking"]')].map(s => s.src);
    const status = document.querySelector('.wm-status')?.textContent || '';
    const who = document.querySelector('#wm-consult-portal-user, .wm-portal-header')?.innerText || '';
    return {
      href: location.href,
      title: document.title,
      cfg,
      scripts,
      status,
      who,
      bodyClass: document.body.className,
      hasRoot: !!document.querySelector('#wm-consult-clinician-root, #wm-consult-booking-root'),
    };
  })()`,
});
console.log("\nPROBE", JSON.stringify(probe, null, 2));

ws.close();
