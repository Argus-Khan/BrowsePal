#!/usr/bin/env node
import WebSocket from "ws";
import { writeFileSync } from "node:fs";

const PORT = Number(process.env.BRIDGE_PORT || 9333);
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

await new Promise((resolve, reject) => {
  ws.on("open", resolve);
  ws.on("error", reject);
});

const tabs = await rpc("tabs.list");
const tab = (tabs || []).find((t) => /page=wm-consult-people/i.test(t.url || ""));
if (!tab) throw new Error("Users page tab not found");
const tabId = tab.id;
await rpc("tabs.activate", { tabId });
console.log("Using tab", tabId, tab.url);

const stamp = Date.now();
const user = {
  firstName: "Bridge",
  lastName: "TestUser",
  email: `bridge.test.${stamp}@example.com`,
  phone: "+15555550100",
  password: "BridgeTest1234!",
  role: "patient",
};

console.log("Creating user", user.email);

await rpc("page.scrollIntoView", { tabId, selector: "a.wm-create-open" });
await rpc("page.click", { tabId, selector: "a.wm-create-open" });
await sleep(1500);

await rpc("page.waitFor", { tabId, selector: "#TB_window #wm_boot_first", timeoutMs: 10000 });

await rpc("page.setValue", { tabId, selector: "#wm_boot_first", value: user.firstName });
await rpc("page.setValue", { tabId, selector: "#wm_boot_last", value: user.lastName });
await rpc("page.setValue", { tabId, selector: "#wm_boot_email", value: user.email });
await rpc("page.setValue", { tabId, selector: "#wm_boot_phone", value: user.phone });
await rpc("page.setValue", { tabId, selector: "#wm_boot_pass", value: user.password });
await rpc("page.setValue", { tabId, selector: "#wm_boot_role", value: user.role });

await sleep(300);
await rpc("page.click", { tabId, selector: "#TB_window .wm-create-form input[type='submit']" });

await sleep(4000);

const active = await rpc("tabs.active");
const text = await rpc("page.getText", { tabId: active.id });
const snippet = String(text || "").slice(0, 4000);
console.log("\nPAGE AFTER SUBMIT\n", snippet);

const row = await rpc("page.querySelectorAll", {
  tabId: active.id,
  selector: "table.wm-users-table tbody tr",
  limit: 5,
  attrs: ["innerText"],
});
console.log("\nTOP TABLE ROWS\n", JSON.stringify(row, null, 2));

try {
  const shot = await rpc("page.screenshot", { tabId: active.id, format: "png" });
  const b64 = typeof shot === "string" ? (shot.includes(",") ? shot.split(",").pop() : shot) : shot?.data;
  if (b64) {
    writeFileSync("/tmp/wm-create-user-result.png", Buffer.from(b64, "base64"));
    console.log("Screenshot /tmp/wm-create-user-result.png");
  }
} catch (e) {
  console.log("Screenshot failed", e.message);
}

const created = snippet.includes(user.email) || JSON.stringify(row).includes(user.email);
console.log("\nRESULT", created ? "SUCCESS" : "UNCLEAR", user.email);

ws.close();
process.exit(created ? 0 : 2);
