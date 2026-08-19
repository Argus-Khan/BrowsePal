#!/usr/bin/env node
import WebSocket from "ws";

const PORTS = (process.env.BRIDGE_PORT || "9333,9222").split(",").map((p) => Number(p.trim()));
const password = "BridgeTest1234!";
const stamp = Date.now();

const users = [
  { firstName: "Sarah", lastName: "Chen", email: `sarah.chen.${stamp}@example.com`, phone: "+15555550101", role: "doctor" },
  { firstName: "James", lastName: "Miller", email: `james.miller.${stamp}@example.com`, phone: "+15555550102", role: "nurse" },
  { firstName: "Maria", lastName: "Lopez", email: `maria.lopez.${stamp}@example.com`, phone: "+15555550103", role: "caretaker" },
  { firstName: "Alex", lastName: "Rivera", email: `alex.rivera.${stamp}@example.com`, phone: "+15555550104", role: "assistant" },
  { firstName: "Emma", lastName: "Wilson", email: `emma.wilson.${stamp}@example.com`, phone: "+15555550201", role: "patient" },
  { firstName: "Noah", lastName: "Patel", email: `noah.patel.${stamp}@example.com`, phone: "+15555550202", role: "patient" },
  { firstName: "Sofia", lastName: "Nguyen", email: `sofia.nguyen.${stamp}@example.com`, phone: "+15555550203", role: "patient" },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
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

  return { ws, rpc, port };
}

async function waitForBridge(port, maxMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const conn = await connect(port);
      try {
        const cfg = await conn.rpc("agent.config.get", {}, 3000);
        if (cfg?.disabled) {
          console.log(`Port ${port}: bridge disabled — enable it in the extension popup, retrying…`);
          conn.ws.close();
          await sleep(2000);
          continue;
        }
        await conn.rpc("tabs.list", {}, 5000);
        console.log(`Connected on port ${port}`);
        return conn;
      } catch (e) {
        conn.ws.close();
        if (Date.now() - start > maxMs - 3000) throw e;
        await sleep(2000);
      }
    } catch {
      await sleep(2000);
    }
  }
  throw new Error(`No bridge on port ${port} after ${maxMs}ms`);
}

async function createOne(rpc, tabId, user) {
  await rpc("page.waitFor", { tabId, selector: "a.wm-create-open", timeoutMs: 15000 });
  await rpc("page.scrollIntoView", { tabId, selector: "a.wm-create-open" });
  await rpc("page.click", { tabId, selector: "a.wm-create-open" });
  await sleep(1200);
  await rpc("page.waitFor", { tabId, selector: "#TB_window #wm_boot_first", timeoutMs: 10000 });

  await rpc("page.setValue", { tabId, selector: "#wm_boot_first", value: user.firstName });
  await rpc("page.setValue", { tabId, selector: "#wm_boot_last", value: user.lastName });
  await rpc("page.setValue", { tabId, selector: "#wm_boot_email", value: user.email });
  await rpc("page.setValue", { tabId, selector: "#wm_boot_phone", value: user.phone });
  await rpc("page.setValue", { tabId, selector: "#wm_boot_pass", value: password });
  await rpc("page.setValue", { tabId, selector: "#wm_boot_role", value: user.role });

  await sleep(200);
  await rpc("page.click", { tabId, selector: "#TB_window .wm-create-form input[type='submit']" });
  await sleep(3500);

  tabId = (await rpc("tabs.active")).id;
  const text = await rpc("page.getText", { tabId });
  const ok =
    String(text).includes("User created") ||
    String(text).includes(user.email) ||
    String(text).includes(`${user.firstName} ${user.lastName}`);
  console.log(ok ? "OK" : "FAIL", user.role.padEnd(10), user.email);
  return ok;
}

let conn = null;
for (const port of PORTS) {
  try {
    conn = await waitForBridge(port, 60000);
    break;
  } catch (e) {
    console.log(String(e.message));
  }
}
if (!conn) {
  console.error("\nBrowser bridge not available. In Firefox/Chrome, open the Browser Agent Bridge extension and ensure it is enabled and connected (ws://127.0.0.1:9333 or :9222).");
  process.exit(1);
}

const { ws, rpc } = conn;
const tabs = await rpc("tabs.list");
let tab = (tabs || []).find((t) => /page=wm-consult-people/i.test(t.url || ""));
if (!tab) {
  tab = await rpc("tabs.create", {
    url: "https://www.wellnessmetric.net/wp-admin/admin.php?page=wm-consult-people",
    active: true,
  });
  await sleep(4000);
}
await rpc("tabs.activate", { tabId: tab.id });
console.log("Using tab", tab.id, tab.url);

const results = [];
for (const user of users) {
  results.push({ user, ok: await createOne(rpc, tab.id, user) });
}

console.log("\n--- Summary ---");
console.log("Password for all:", password);
for (const { user, ok } of results) {
  console.log(`${ok ? "✓" : "✗"} ${user.role.padEnd(10)} ${user.firstName} ${user.lastName} <${user.email}>`);
}

ws.close();
process.exit(results.every((r) => r.ok) ? 0 : 2);
