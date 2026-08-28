#!/usr/bin/env node
/**
 * Browser Agent Bridge — Relay Server
 * 
 * Lightweight WebSocket relay that sits between the extension and AI agents.
 * The extension connects to this server; agents also connect to it.
 * Messages are forwarded bidirectionally.
 * 
 * Usage:
 *   node lib/server.js                      # default port 9222
 *   node lib/server.js --port 9333          # custom port
 *   node lib/server.js --token secret       # require shared token
 * 
 * Agent SDK usage:
 *   import { BrowserAgent } from "./lib/client.mjs";
 *   const agent = await BrowserAgent.connect("127.0.0.1:9222");
 *   const page = await agent.page();
 *   const snap = await page.snapshot();
 *   console.log(snap.find("search box"));
 */

import { WebSocketServer } from "ws";

const DEFAULTS = { host: "127.0.0.1", port: 9222, token: "" };

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--port" || argv[i] === "-p") opts.port = parseInt(argv[++i], 10);
    else if (argv[i] === "--host" || argv[i] === "-h") opts.host = argv[++i];
    else if (argv[i] === "--token" || argv[i] === "-t") opts.token = argv[++i];
    else if (argv[i] === "--help") {
      console.log("Usage: server.js [--port N] [--host H] [--token T]");
      process.exit(0);
    }
  }
  return opts;
}

function createServer(opts) {
  const wss = new WebSocketServer({ host: opts.host, port: opts.port });
  let bridge = null;
  const agents = new Set();

  wss.on("connection", (ws, req) => {
    // Validate token if configured
    if (opts.token) {
      const protocol = ws.protocol;
      if (protocol !== opts.token) {
        console.log("[server] rejected connection: bad token");
        ws.close();
        return;
      }
    }

    const isBridge = !bridge;
    const label = isBridge ? "extension" : "agent";

    if (isBridge) {
      bridge = ws;
      console.log("[server] extension connected from", req.socket.remoteAddress);

      ws.on("message", (data) => {
        const str = data.toString();
        try {
          const msg = JSON.parse(str);
          // Notifications from extension → forward to all agents
          if (msg.method && msg.id == null) {
            for (const agent of agents) {
              if (agent.readyState === 1) {
                try { agent.send(str); } catch {}
              }
            }
          }
        } catch {
          // Not JSON, forward raw
          for (const agent of agents) {
            if (agent.readyState === 1) {
              try { agent.send(str); } catch {}
            }
          }
        }
      });

      ws.on("close", () => {
        console.log("[server] extension disconnected");
        if (bridge === ws) bridge = null;
      });
    } else {
      agents.add(ws);
      console.log("[server] agent connected (total:", agents.size + ")");

      ws.on("message", (data) => {
        // Forward agent messages to extension
        if (bridge && bridge.readyState === 1) {
          try { bridge.send(data.toString()); } catch {}
        }
      });

      ws.on("close", () => {
        agents.delete(ws);
        console.log("[server] agent disconnected (total:", agents.size + ")");
      });
    }
  });

  wss.on("error", (err) => {
    console.error("[server] WebSocket error:", err.message);
  });

  return { wss, get connected() { return !!bridge && bridge.readyState === 1; } };
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv);
  console.log("[server] listening on ws://" + opts.host + ":" + opts.port + (opts.token ? " (token required)" : ""));
  console.log("[server] waiting for extension…");

  createServer(opts);
}

main();
