#!/usr/bin/env node
import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const port = (() => {
  const i = args.indexOf("--port"); if (i >= 0) return parseInt(args[i + 1], 10);
  const m = args.find((a) => /^--port=/.test(a)); if (m) return parseInt(m.split("=")[1], 10);
  return 9222;
})();
const host = (() => {
  const i = args.indexOf("--host"); if (i >= 0) return args[i + 1];
  const m = args.find((a) => /^--host=/.test(a)); return m ? m.split("=")[1] : "127.0.0.1";
})();
const token = (() => {
  const i = args.indexOf("--token"); if (i >= 0) return args[i + 1];
  const m = args.find((a) => /^--token=/.test(a)); return m ? m.split("=")[1] : "";
})();

const wss = new WebSocketServer({ host, port }, () => {
  console.log(`Browser Agent Bridge server listening on ws://${host}:${port}` + (token ? " (token required)" : ""));
});

let bridge = null;

function send(obj) { if (bridge && bridge.readyState === 1) bridge.send(JSON.stringify(obj)); }
let nextId = 1;
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const onMsg = (data) => {
      let m; try { m = JSON.parse(data); } catch { return; }
      if (m.id === id) {
        bridge.off("message", onMsg);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      }
    };
    bridge.on("message", onMsg);
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => { bridge.off("message", onMsg); reject(new Error("timeout")); }, 15000);
  });
}

wss.on("connection", (ws, req) => {
  if (token) {
    const proto = req.headers["sec-websocket-protocol"];
    if (proto !== token) {
      console.error("Connection rejected: bad/missing token");
      ws.close(4001, "bad token");
      return;
    }
  }
  bridge = ws;
  console.log("\n🟢 Extension connected from", req.socket.remoteAddress);
  ws.on("message", (data) => {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.method === "ping" || m.method === "pong" || m.method === "agent.hello") {
      if (m.method === "agent.hello") console.log("  hello:", JSON.stringify(m.params));
      return;
    }
    if (m.id === undefined) {
      if (m.method === "agent.connected") console.log("  • agent.connected");
      else if (m.method === "net.requestLogged") console.log(`  • net.requestLogged ${m.params.method} ${m.params.url.slice(0, 80)}`);
      else if (m.method && m.method.startsWith("net.")) console.log(`  • ${m.method}`, JSON.stringify(m.params).slice(0, 200));
      else console.log("  • notify", m.method, JSON.stringify(m.params || {}).slice(0, 200));
    }
  });
  ws.on("close", () => { console.log("🔴 Extension disconnected"); if (bridge === ws) bridge = null; });
  ws.on("error", () => {});
});

function startRepl() {
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  let interactive = process.stdin.isTTY && !args.includes("--quiet");
  if (interactive) {
    console.log("\nType JSON-RPC one-liners to send to the bridge. Examples:");
    console.log('  ping');
    console.log('  tabs.list');
    console.log('  page.eval {"code":"document.title"}');
    console.log('  page.querySelector {"selector":"title"}');
    console.log('  net.enable');
    console.log('  net.getLog {}');
    console.log('  cookies.getAll {"url":"https://example.com"}');
    console.log('  exit\n');
  }
  let buf = "";
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      if (line === "exit" || line === "quit") process.exit(0);
      const sp = line.indexOf(" ");
      let method, params = {};
      if (sp < 0) method = line;
      else { method = line.slice(0, sp); try { params = JSON.parse(line.slice(sp + 1)); } catch (e) { console.log("bad params json:", e.message); continue; } }
      if (!bridge || bridge.readyState !== 1) { console.log("✗ no bridge connected yet"); continue; }
      if (method === "help") { console.log("send <method> [params-json]"); continue; }
      rpc(method, params).then((r) => {
        console.log("←", JSON.stringify(r, null, 2));
      }).catch((e) => console.log("✗", e.message));
    }
  });
}

if (!args.includes("--no-repl")) startRepl();

process.on("SIGINT", () => { console.log("\nshutting down"); wss.close(); process.exit(0); });