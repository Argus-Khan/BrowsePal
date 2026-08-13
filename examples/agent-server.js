#!/usr/bin/env node
// Interactive agent server for the Browser Agent Bridge extension.
// Listens on a local WebSocket; the extension connects out to it.
// Reads JSON-RPC commands from stdin, forwards to the extension, prints responses.
//
// Usage:
//   node examples/agent-server.js                  # interactive REPL (default port 9222)
//   node examples/agent-server.js --port 9333      # custom port
//   node examples/agent-server.js --token secret   # require shared token
//
// Or programmatically:
//   const { startServer, rpc } = require("./agent-server.js");
//   const { rpc } = await startServer({ port: 9222 });
//   const tabs = await rpc("tabs.list");

import { WebSocketServer } from "ws";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const DEFAULTS = { host: "127.0.0.1", port: 9222, token: "" };

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--port" || argv[i] === "-p") opts.port = parseInt(argv[++i]);
    else if (argv[i] === "--host" || argv[i] === "-h") opts.host = argv[++i];
    else if (argv[i] === "--token" || argv[i] === "-t") opts.token = argv[++i];
    else if (argv[i] === "--help") {
      console.log("Usage: agent-server.js [--port N] [--host H] [--token T]");
      process.exit(0);
    }
  }
  return opts;
}

function createServer(opts) {
  const wss = new WebSocketServer({ host: opts.host, port: opts.port });
  let bridge = null;
  const agents = new Set();
  let nextId = 1;
  const pending = new Map();
  const notificationHandlers = new Map();

  wss.on("connection", (ws) => {
    // Validate token if configured
    if (opts.token) {
      const protocol = ws.protocol;
      if (protocol !== opts.token) {
        console.log("[server] rejected connection: bad token");
        ws.close();
        return;
      }
    }
    
    // First connection is the bridge (extension), rest are agents
    if (!bridge) {
      bridge = ws;
      console.log("[server] extension connected");
      
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          // Response to a pending request
          if (msg.id != null && pending.has(msg.id)) {
            const { resolve, reject, timer } = pending.get(msg.id);
            clearTimeout(timer);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else resolve(msg.result);
            return;
          }
          // Notification from extension
          if (msg.method) {
            const handler = notificationHandlers.get(msg.method);
            if (handler) {
              try { handler(msg.params); } catch (e) { console.error("[server] notification handler error:", e.message); }
            }
            // Forward notifications to all agent clients
            for (const agent of agents) {
              if (agent.readyState === 1) {
                try { agent.send(data.toString()); } catch (e) {}
              }
            }
          }
        } catch (e) {
          // Ignore parse errors
        }
      });

      ws.on("close", () => {
        console.log("[server] extension disconnected");
        if (bridge === ws) bridge = null;
        // Reject all pending
        for (const [, { reject, timer }] of pending) {
          clearTimeout(timer);
          reject(new Error("extension disconnected"));
        }
        pending.clear();
      });
    } else {
      // This is an agent client
      agents.add(ws);
      console.log("[server] agent client connected");
      
      ws.on("message", async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.method && msg.id != null) {
            // Forward to bridge
            if (bridge && bridge.readyState === 1) {
              bridge.send(data.toString());
              // Wait for response
              const timer = setTimeout(() => {
                pending.delete(msg.id);
                if (ws.readyState === 1) {
                  try { ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "timeout" } })); } catch (e) {}
                }
              }, 30000);
              pending.set(msg.id, {
                resolve: (result) => {
                  clearTimeout(timer);
                  if (ws.readyState === 1) {
                    try { ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })); } catch (e) {}
                  }
                },
                reject: (err) => {
                  clearTimeout(timer);
                  if (ws.readyState === 1) {
                    try { ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: err.message } })); } catch (e) {}
                  }
                },
                timer
              });
            } else {
              if (ws.readyState === 1) {
                try { ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "extension not connected" } })); } catch (e) {}
              }
            }
          }
        } catch (e) {}
      });

      ws.on("close", () => {
        console.log("[server] agent client disconnected");
        agents.delete(ws);
      });
    }
  });

  wss.on("error", (err) => {
    console.error("[server] WebSocket server error:", err.message);
  });

  function rpc(method, params = {}, timeoutMs = 30000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms for ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      if (!bridge || bridge.readyState !== 1) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error("extension not connected"));
        return;
      }
      bridge.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  function onNotification(method, handler) {
    notificationHandlers.set(method, handler);
    return () => notificationHandlers.delete(method);
  }

  return { wss, rpc, onNotification, get connected() { return !!bridge && bridge.readyState === 1; } };
}

async function main() {
  const opts = parseArgs(process.argv);
  console.log(`[server] listening on ws://${opts.host}:${opts.port}${opts.token ? " (token required)" : ""}`);
  console.log(`[server] waiting for extension…`);

  const server = createServer(opts);
  const { rpc, onNotification, wss } = server;

  // Print notifications
  onNotification("agent.connected", (p) => {
    console.log(`[server] agent.connected — ${p?.userAgent || ""}`);
  });
  onNotification("net.requestLogged", (p) => {
    console.log(`[server] net.requestLogged: ${p?.method || ""} ${p?.url || ""}`);
  });

  // Wait for extension to connect
  while (!rpc("ping", {}, 5000).catch(() => null)) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  try {
    const pong = await rpc("ping", {}, 5000);
    console.log(`[server] extension ready — ${JSON.stringify(pong)}`);
  } catch (e) {
    // Extension may not support ping; that's fine
  }

  console.log(`\n[server] Interactive REPL — type JSON-RPC commands or use shortcuts:`);
  console.log(`  tabs                          list all tabs`);
  console.log(`  active                        get active tab`);
  console.log(`  read [selector]               read text from page`);
  console.log(`  eval <code>                   evaluate JS in page`);
  console.log(`  goto <url>                    navigate to URL`);
  console.log(`  click <selector>              click element`);
  console.log(`  type <selector> <text>        set element value`);
  console.log(`  screenshot                    take screenshot`);
  console.log(`  {json}                        raw JSON-RPC request`);
  console.log(`  exit / quit                   stop server\n`);

  const rl = readline.createInterface({ input, output });

  while (true) {
    let line;
    try {
      line = await rl.question("> ");
    } catch (e) {
      break;
    }
    line = line.trim();
    if (!line) continue;
    if (line === "exit" || line === "quit") {
      console.log("[server] shutting down");
      break;
    }

    // Try to parse as raw JSON first
    let method, params;
    try {
      const obj = JSON.parse(line);
      if (obj.method) {
        method = obj.method;
        params = obj.params || {};
      }
    } catch (e) { /* not JSON, try shortcuts */ }

    if (!method) {
      // Parse shortcuts
      const parts = line.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      switch (cmd) {
        case "tabs":
          method = "tabs.list"; params = {}; break;
        case "active":
          method = "tabs.active"; params = {}; break;
        case "read":
          method = "page.getText"; params = { selector: parts[1] }; break;
        case "eval":
          method = "page.eval"; params = { code: parts.slice(1).join(" ") }; break;
        case "goto":
          method = "page.navigate"; params = { url: parts[1] }; break;
        case "click":
          method = "page.click"; params = { selector: parts[1] }; break;
        case "type":
          method = "page.setValue"; params = { selector: parts[1], value: parts.slice(2).join(" ") }; break;
        case "screenshot":
          method = "page.screenshot"; params = {}; break;
        case "status":
          method = "agent.status"; params = {}; break;
        case "config":
          method = "agent.config.get"; params = {}; break;
        case "help":
          console.log("Commands: tabs, active, read, eval, goto, click, type, screenshot, status, config, exit");
          continue;
        default:
          console.log(`[server] unknown command: ${cmd}. Type "help" for list.`);
          continue;
      }
    }

    try {
      const result = await rpc(method, params);
      if (typeof result === "object") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result);
      }
    } catch (e) {
      console.error(`[server] error: ${e.message}`);
    }
  }

  rl.close();
  // Close the WebSocket server
  wss.close();
  console.log("[server] done");
}

main().catch((e) => { console.error("[server] fatal:", e.message); process.exit(1); });

export { createServer, DEFAULTS };
