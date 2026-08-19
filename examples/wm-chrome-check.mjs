import WebSocket from "ws";
import { writeFileSync } from "node:fs";

const ws = new WebSocket("ws://127.0.0.1:9222");
let id = 1;
const pending = new Map();

function rpc(method, params = {}, timeoutMs = 60000) {
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
  console.log("NO_PORTAL_TAB", JSON.stringify(tabs.map((t) => t.url)));
  ws.close();
  process.exit(1);
}
const tabId = tab.id;
await rpc("tabs.activate", { tabId });
console.log("TAB", tab.url);

try { await rpc("net.clear", { tabId }); } catch {}
try { await rpc("net.enable", { tabId }); } catch (e) { console.log("NET_ERR", e.message); }

await rpc("page.reload", { tabId });
await new Promise((r) => setTimeout(r, 9000));

const extra = await rpc("page.querySelectorAll", {
  tabId,
  selector: "script[id*='wm-consult'], script[id*='clinician']",
  limit: 10,
  attrs: ["id", "src"],
});
console.log(
  "SCRIPTS",
  JSON.stringify(
    (extra || []).map((s) => ({
      id: s.id || s.attrs?.id,
      src: s.attrs?.src || "",
      text: String(s.text || "").slice(0, 400),
    })),
    null,
    2
  )
);

const status = await rpc("page.querySelectorAll", {
  tabId,
  selector: ".wm-status, .wm-status-bar, .wm-whoami-name, .wm-portal-title",
  limit: 20,
  attrs: ["class", "id"],
});
console.log("STATUS", JSON.stringify(status, null, 2));

const who = await rpc("page.querySelector", {
  tabId,
  selector: "#wm-consult-portal-user",
  attrs: ["class", "hidden"],
});
console.log("WHO", JSON.stringify(who, null, 2)?.slice(0, 2000));

let log = [];
try {
  log = await rpc("net.getLog", { tabId });
} catch (e) {
  console.log("LOG_ERR", e.message);
}
const slim = (log || [])
  .map((e) => ({
    url: e.url || e.request?.url,
    method: e.method || e.request?.method,
    status: e.status || e.response?.status,
    type: e.type,
    requestId: e.requestId,
  }))
  .filter((e) => /wp-json|session|appointments|clinician\.js|plugin-hub/i.test(String(e.url || "")));
console.log("NET", JSON.stringify(slim, null, 2));

const session = slim.find((e) => /\/session/i.test(String(e.url || "")));
if (session?.requestId) {
  try {
    const detail = await rpc("net.getRequest", { tabId, requestId: session.requestId });
    console.log("SESSION_URL", detail.url);
    console.log("SESSION_STATUS", detail.status);
    console.log("SESSION_BODY", String(detail.body || "").slice(0, 1500));
  } catch (e) {
    console.log("SESSION_DETAIL_ERR", e.message);
  }
}

const appt = slim.find((e) => /\/appointments/i.test(String(e.url || "")));
if (appt?.requestId) {
  try {
    const detail = await rpc("net.getRequest", { tabId, requestId: appt.requestId });
    console.log("APPT_URL", detail.url);
    console.log("APPT_STATUS", detail.status);
    console.log("APPT_BODY", String(detail.body || "").slice(0, 500));
  } catch (e) {
    console.log("APPT_DETAIL_ERR", e.message);
  }
}

try {
  const shot = await rpc("page.screenshot", { tabId, format: "png" });
  const dataUrl = shot?.dataUrl || "";
  const b64 = dataUrl.includes(",") ? dataUrl.split(",").pop() : dataUrl;
  writeFileSync("/tmp/wm-portal-now.png", Buffer.from(b64, "base64"));
  console.log("SHOT_OK");
} catch (e) {
  console.log("SHOT_ERR", e.message);
}

ws.close();
