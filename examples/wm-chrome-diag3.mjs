import { connect, sleep } from "../lib/client.mjs";
import { writeFileSync } from "node:fs";

const { rpc, close } = await connect(9222);

const tabs = await rpc("tabs.list");
const tab = tabs.find((t) => /wellnessmetric\.net\/portal/i.test(t.url || ""));
const tabId = tab.id;
await rpc("tabs.activate", { tabId });

const frames = await rpc("page.frames", { tabId });
console.log("FRAMES", JSON.stringify(frames, null, 2));

const cookies = await rpc("cookies.getAll", { domain: "wellnessmetric.net" });
const interesting = (cookies || []).map((c) => ({
  name: c.name,
  domain: c.domain,
  path: c.path,
  secure: c.secure,
  httpOnly: c.httpOnly,
  sameSite: c.sameSite,
  valueLen: String(c.value || "").length,
}));
console.log("COOKIES", JSON.stringify(interesting, null, 2));

const allScripts = await rpc("page.querySelectorAll", {
  tabId,
  selector: "script",
  limit: 80,
  attrs: ["id", "src", "type"],
});
console.log(
  "ALL_SCRIPTS",
  JSON.stringify(
    (allScripts || []).map((s) => ({
      id: s.id || s.attrs?.id,
      src: s.attrs?.src || "",
      type: s.attrs?.type || "",
      textStart: String(s.text || "").slice(0, 200),
      textLen: String(s.text || "").length,
    })),
    null,
    2
  )
);

const root = await rpc("page.querySelector", {
  tabId,
  selector: "#wm-consult-clinician-root, .wm-consult-app, .wm-portal-clinician",
  attrs: ["id", "class"],
});
console.log("ROOT", JSON.stringify(root, null, 2)?.slice(0, 3000));

try {
  await rpc("net.clear", { tabId });
} catch (e) {
  console.log("NET_CLEAR_ERR", e.message);
}
try {
  await rpc("net.enable", { tabId });
  console.log("NET_ON");
} catch (e) {
  console.log("NET_ERR", e.message);
}

await rpc("page.reload", { tabId });
await sleep(8000);

let log = [];
try {
  log = await rpc("net.getLog", { tabId, filter: "session" });
  console.log("LOG_SESSION_FILTER", JSON.stringify(log, null, 2)?.slice(0, 12000));
} catch (e) {
  console.log("LOG_FILTER_ERR", e.message);
}
try {
  const all = await rpc("net.getLog", { tabId });
  const slim = (all || [])
    .map((e) => ({
      url: e.url || e.request?.url || e.requestUrl,
      method: e.method || e.request?.method,
      status: e.status || e.response?.status,
      type: e.type || e.resourceType,
      mime: e.mimeType || e.response?.mimeType,
      requestId: e.requestId,
    }))
    .filter((e) => /wp-json|session|wm-consult|plugin-hub|clinician\.js/i.test(String(e.url || "")));
  console.log("LOG_SLIM", JSON.stringify(slim, null, 2));
  writeFileSync("/tmp/wm-net-log.json", JSON.stringify(all, null, 2).slice(0, 200000));
  console.log("LOG_COUNT", (all || []).length);
} catch (e) {
  console.log("LOG_ALL_ERR", e.message);
}

const status = await rpc("page.querySelector", {
  tabId,
  selector: ".wm-status, .wm-status-bar",
  attrs: ["class"],
});
console.log("STATUS_AFTER_RELOAD", JSON.stringify(status, null, 2));

const extra = await rpc("page.querySelectorAll", {
  tabId,
  selector: "script[id*='wm-consult'], script[id*='clinician']",
  limit: 20,
  attrs: ["id", "src"],
});
console.log(
  "WM_SCRIPTS_AFTER",
  JSON.stringify(
    (extra || []).map((s) => ({
      id: s.id || s.attrs?.id,
      src: s.attrs?.src,
      text: String(s.text || "").slice(0, 1500),
    })),
    null,
    2
  )
);

try {
  const shot = await rpc("page.screenshot", { tabId, format: "png" });
  const dataUrl = shot?.dataUrl || "";
  const b64 = dataUrl.includes(",") ? dataUrl.split(",").pop() : dataUrl;
  writeFileSync("/tmp/wm-portal-reload.png", Buffer.from(b64, "base64"));
  console.log("RELOAD_SHOT_OK");
} catch (e) {
  console.log("SHOT_ERR", e.message);
}

close();
