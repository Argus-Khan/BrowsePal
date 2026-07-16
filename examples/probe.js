import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ host: "127.0.0.1", port: 9222 }, () => {
  console.log("Agent server listening on ws://127.0.0.1:9222 — waiting for the extension to connect…");
});

let bridge = null;
let nextId = 1;
const pending = new Map();

function rpc(method, params = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("timeout")); }, timeoutMs);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    bridge.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

wss.on("connection", (ws, req) => {
  bridge = ws;
  console.log(`\n🟢 Extension connected from ${req.socket.remoteAddress}`);
  ws.on("message", (data) => {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.method === "ping") { ws.send(JSON.stringify({ jsonrpc: "2.0", method: "pong" })); return; }
    if (m.method === "agent.hello") { console.log("  hello:", JSON.stringify(m.params)); return; }
    if (m.method === "agent.connected") { console.log("  • agent.connected"); return; }
    if (m.method && m.method.startsWith("net.")) { console.log(`  • ${m.method}`, JSON.stringify(m.params).slice(0, 160)); return; }
    if (m.id != null && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    } else if (m.method) {
      console.log("  • notify", m.method, JSON.stringify(m.params || {}).slice(0, 160));
    }
  });
  ws.on("close", () => { console.log("🔴 Extension disconnected"); if (bridge === ws) bridge = null; });
  ws.on("error", () => {});
});

async function probe() {
  // wait up to 100s for the extension to connect
  const start = Date.now();
  let lastBeat = 0;
  while (!bridge && Date.now() - start < 100000) {
    await new Promise((r) => setTimeout(r, 200));
    if (Date.now() - lastBeat > 5000) { lastBeat = Date.now(); console.log(`…waiting for extension (${Math.round((Date.now()-start)/1000)}s)`); }
  }
  if (!bridge) { console.log("\nNo extension connected within 100s. Check: (1) extension loaded? (2) background script errors? open about:debugging → Browser Agent Bridge → Inspect"); wss.close(); process.exit(1); }

  console.log("\n=== probing ===");
  try { console.log("ping →", await rpc("ping")); } catch (e) { console.log("ping ✗", e.message); }
  try {
    const status = await rpc("agent.status");
    console.log("agent.status →", JSON.stringify(status, null, 2));
  } catch (e) { console.log("agent.status ✗", e.message); }
  try {
    const tabs = await rpc("tabs.list");
    console.log(`tabs.list → ${tabs.length} tab(s)`);
    for (const t of tabs.slice(0, 10)) console.log(`   #${t.id}  ${t.active ? "★" : " "} ${t.url}`);
  } catch (e) { console.log("tabs.list ✗", e.message); }
  try {
    const title = await rpc("page.eval", { code: "document.title" });
    console.log("page.eval document.title →", JSON.stringify(title));
  } catch (e) { console.log("page.eval ✗", e.message); }
  try {
    const html = await rpc("page.getOuterHTML");
    console.log("page.getOuterHTML →", typeof html === "string" ? html.slice(0, 200) + "…" : html);
  } catch (e) { console.log("page.getOuterHTML ✗", e.message); }
  try {
    const vals = await rpc("storage.page.local.keys");
    console.log("storage.page.local.keys →", vals);
  } catch (e) { console.log("storage.page.local.keys ✗", e.message); }
  try {
    const dbs = await rpc("indexedDB.databases");
    console.log("indexedDB.databases →", dbs);
  } catch (e) { console.log("indexedDB.databases ✗", e.message); }
  try {
    const passive = await rpc("agent.passiveLog", { limit: 5 });
    console.log(`agent.passiveLog → ${passive.length} recent requests(s)`);
    for (const r of passive) console.log(`   ${r.method} ${r.url.slice(0, 100)}`);
  } catch (e) { console.log("agent.passiveLog ✗", e.message); }

  console.log("\n=== done ===");
  wss.close();
  process.exit(0);
}

probe();