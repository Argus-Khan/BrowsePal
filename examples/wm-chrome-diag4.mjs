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

const detail = await rpc("net.getRequest", {
  tabId: 1665821994,
  requestId: "3871.14686",
});
console.log(JSON.stringify(detail, null, 2).slice(0, 8000));
ws.close();
