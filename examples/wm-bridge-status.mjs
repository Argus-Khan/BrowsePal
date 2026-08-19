import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:9222");
let id = 1;
const pending = new Map();

function rpc(method, params = {}, timeoutMs = 30000) {
  const reqId = id++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(reqId); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
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

await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });

const status = await rpc("agent.status");
console.log("AGENT_STATUS", JSON.stringify(status, null, 2));

const tabs = await rpc("tabs.list");
console.log("TABS", JSON.stringify(tabs, null, 2));

ws.close();
