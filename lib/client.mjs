/**
 * Shared WebSocket RPC client for example scripts.
 * Eliminates the ~30 lines of boilerplate duplicated across every example.
 *
 * Usage:
 *   import { connect } from "../lib/client.mjs";
 *   const { rpc, ws, close } = await connect(9222);
 *   const tabs = await rpc("tabs.list");
 *   close();
 */
import WebSocket from "ws";

/**
 * Connect to a WebSocket RPC server (the agent-server.js).
 * @param {number} [port=9222] - Port to connect to
 * @param {object} [opts] - Options
 * @param {string} [opts.host="127.0.0.1"] - Host to connect to
 * @param {number} [opts.timeoutMs=30000] - Default RPC timeout
 * @param {Function} [opts.onNotification] - Notification handler (method, params) => void
 * @returns {Promise<{rpc: Function, ws: WebSocket, close: Function}>}
 */
export async function connect(port = 9222, opts = {}) {
  const { host = "127.0.0.1", timeoutMs = 30000, onNotification } = opts;
  const ws = new WebSocket(`ws://${host}:${port}`);
  let id = 1;
  const pending = new Map();

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // Handle notifications
      if (msg.method && msg.id == null) {
        if (onNotification) onNotification(msg.method, msg.params);
        return;
      }
      // Handle responses
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

  function rpc(method, params = {}, rpcTimeoutMs = timeoutMs) {
    const reqId = id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error(`timeout: ${method}`));
      }, rpcTimeoutMs);
      pending.set(reqId, { resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params }));
    });
  }

  function close() {
    ws.close();
  }

  return { rpc, ws, close };
}

/**
 * Sleep helper.
 */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
