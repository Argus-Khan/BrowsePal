import WebSocket from "ws";
import { writeFileSync } from "node:fs";

const ws = new WebSocket("ws://127.0.0.1:9222");
let id = 1;
const pending = new Map();

function rpc(method, params = {}, timeoutMs = 45000) {
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
const tab = tabs.find((t) => /wellnessmetric\.net\/portal/i.test(t.url || ""));
if (!tab) {
  console.log("NO_PORTAL_TAB");
  ws.close();
  process.exit(1);
}
const tabId = tab.id;
await rpc("tabs.activate", { tabId });
console.log("TAB", tab.url, tab.title);

try {
  const shot = await rpc("page.screenshot", { tabId, format: "png" });
  const dataUrl = shot?.dataUrl || shot?.data || (typeof shot === "string" ? shot : "");
  const b64 = String(dataUrl).includes(",") ? String(dataUrl).split(",").pop() : String(dataUrl);
  writeFileSync("/tmp/wm-portal.png", Buffer.from(b64, "base64"));
  console.log("SCREENSHOT_OK", Buffer.from(b64, "base64").length);
} catch (e) {
  console.log("SCREENSHOT_ERR", e.message);
}

const selectors = [
  ".wm-status",
  ".wm-status.is-error",
  "#wm-consult-clinician-root",
  "#wm-consult-booking-root",
  ".wm-portal-title",
  ".wm-portal-header",
  "#wm-consult-portal-user",
  ".wm-who",
  "script[src*='clinician']",
  "script[src*='booking']",
  "#wm-consult-clinician-js-extra",
  "#wm-consult-booking-js-extra",
];
for (const selector of selectors) {
  try {
    const el = await rpc("page.querySelector", {
      tabId,
      selector,
      attrs: ["id", "class", "src", "hidden"],
    });
    console.log("EL", selector, JSON.stringify(el, null, 2)?.slice(0, 2000));
  } catch (e) {
    console.log("EL_ERR", selector, e.message);
  }
}

try {
  const extras = await rpc("page.querySelectorAll", {
    tabId,
    selector: "script#wm-consult-clinician-js-extra, script#wm-consult-booking-js-extra, script[id*='wm-consult']",
    limit: 10,
    attrs: ["id"],
  });
  console.log("LOCALIZE_SCRIPTS", JSON.stringify(extras, null, 2)?.slice(0, 8000));
} catch (e) {
  console.log("LOCALIZE_ERR", e.message);
}

try {
  const scripts = await rpc("page.querySelectorAll", {
    tabId,
    selector: "script[src*='consult'], script[src*='clinician'], script[src*='booking']",
    limit: 20,
    attrs: ["src", "id"],
  });
  console.log("SCRIPTS", JSON.stringify(scripts, null, 2));
} catch (e) {
  console.log("SCRIPTS_ERR", e.message);
}

try {
  const statusEls = await rpc("page.querySelectorAll", {
    tabId,
    selector: ".wm-status, .wm-banner, .notice, [class*='error'], .wm-callout",
    limit: 20,
    attrs: ["class", "id"],
  });
  console.log("STATUS_ELS", JSON.stringify(statusEls, null, 2)?.slice(0, 6000));
} catch (e) {
  console.log("STATUS_ERR", e.message);
}

try {
  const html = await rpc("page.getOuterHTML", { tabId });
  const s = String(html || "");
  writeFileSync("/tmp/wm-portal.html", s);
  console.log("HTML_LEN", s.length);
  const hits = [];
  for (const needle of [
    "Could not load",
    "Video consultation is not",
    "wpRestNonce",
    "videoReady",
    "janusUrl",
    "0.2.16",
    "0.2.15",
    "clinician.js",
    "rest_cookie",
    "WM_CONSULT",
    "Please sign in",
    "reCAPTCHA",
  ]) {
    const i = s.indexOf(needle);
    hits.push({ needle, index: i, snippet: i >= 0 ? s.slice(Math.max(0, i - 80), i + 160) : "" });
  }
  console.log("HITS", JSON.stringify(hits, null, 2));
} catch (e) {
  console.log("HTML_ERR", e.message);
}

try {
  await rpc("net.enable", { tabId });
  console.log("NET_ENABLED");
} catch (e) {
  console.log("NET_ENABLE_ERR", e.message);
}

ws.close();
