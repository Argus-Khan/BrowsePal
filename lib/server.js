#!/usr/bin/env node
/**
 * Browser Agent Bridge — Relay Server
 *
 * Lightweight WebSocket relay that sits between the extension and AI agents.
 * The extension connects to this server; agents also connect to it.
 * Messages are forwarded bidirectionally.
 *
 * Multiple browsers: the extension dials with ?bridge=1. If that port's
 * extension slot is already taken, the relay opens the next free port
 * (base+1, base+2, …) and sends the newcomer a bridge.redirect. Each port is
 * its own room — one extension plus its agents — so agents on port N only
 * ever talk to browser N. The relay log identifies each browser per port.
 *
 * Usage:
 *   node lib/server.js                      # default port 9222
 *   node lib/server.js --port 9333          # custom port (slots: 9333, 9334, …)
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
const MAX_PORTS = 8; // base .. base+MAX_PORTS slots

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

function main() {
  const opts = parseArgs(process.argv);
  const rooms = new Map(); // port -> { wss, bridge, agents, ua }

  const log = (...a) => console.log(new Date().toISOString(), "[server]", ...a);

  async function ensureRoom(port) {
    if (rooms.has(port)) return rooms.get(port);
    const wss = new WebSocketServer({ host: opts.host, port });
    const listening = await new Promise((resolve) => {
      wss.once("listening", () => resolve(true));
      wss.once("error", () => resolve(false)); // port taken by something else
    });
    if (!listening) {
      try { wss.close(); } catch {}
      log("port", port, "unavailable, trying next");
      return null;
    }
    const room = { wss, bridge: null, agents: new Set(), ua: "" };
    wss.on("connection", (ws, req) => handleConnection(room, ws, req, port));
    wss.on("error", (err) => console.error("[server] WebSocket error:", err.message));
    rooms.set(port, room);
    if (port !== opts.port) log("opened extra slot on port", port);
    return room;
  }

  async function findFreeRoom() {
    for (let i = 0; i <= MAX_PORTS; i++) {
      const room = await ensureRoom(opts.port + i);
      if (room && !room.bridge) return { room, port: opts.port + i };
    }
    return null;
  }

  function handleConnection(room, ws, req, port) {
    log("accepted on port", port, "url:", req.url, "peer:", req.socket.remotePort);
    ws.on("close", (code, reason) =>
      log("socket closed on port", port, "code:", code, "reason:", reason ? reason.toString() : "-",
          "role:", room.bridge === ws ? "bridge" : room.agents.has(ws) ? "agent" : "unknown"));

    // Validate token if configured
    if (opts.token && ws.protocol !== opts.token) {
      log("rejected connection: bad token");
      ws.close();
      return;
    }

    const wantsBridge = /(^|[?&])bridge=1(&|$)/.test(req.url || "");

    // Slot free: claim it. Plain connections also claim (legacy behavior —
    // pre-bridge=1 extensions, and agents that connect before any extension).
    if (!room.bridge) {
      room.bridge = ws;
      room.ua = "";
      log("extension connected from", req.socket.remoteAddress, "on port", port);

      ws.on("message", (data) => {
        const str = data.toString();
        if (!room.ua) {
          try {
            const m = JSON.parse(str);
            if (m && m.method === "agent.hello" && m.params && m.params.ua) {
              const ua = String(m.params.ua);
              room.ua = /Firefox\//.test(ua) ? "Firefox"
                : /Edg\//.test(ua) ? "Edge"
                : /Chrome\//.test(ua) ? "Chrome"
                : ua.split(/[ /]/)[0];
              log("extension identified:", room.ua, "on port", port);
            }
          } catch {}
        }
        // Forward EVERYTHING from the extension to this room's agents —
        // notifications (msg.method, no id) AND rpc responses (msg.id, no
        // method). Filtering by shape used to eat responses.
        for (const agent of room.agents) {
          if (agent.readyState === 1) {
            try { agent.send(str); } catch {}
          }
        }
      });

      ws.on("close", () => {
        if (room.bridge === ws) {
          room.bridge = null;
          room.ua = "";
          log("extension disconnected from port", port);
        }
      });
      return;
    }

    // Extension announced itself but the slot is taken → send it to a free port.
    if (wantsBridge && room.bridge) {
      findFreeRoom().then((free) => {
        if (free && free.port !== port) {
          const url = "ws://" + opts.host + ":" + free.port;
          log("extension displaced on port", port, "→ redirecting to", url);
          try {
            ws.send(JSON.stringify({ jsonrpc: "2.0", method: "bridge.redirect", params: { url } }));
          } catch {}
          setTimeout(() => { try { ws.close(); } catch {} }, 100);
        } else {
          log("no free port slot for an extra extension, dropping it");
          try { ws.close(1012, "no free port"); } catch {}
        }
      });
      return;
    }

    // Agent: joins this port's room, sees only this port's extension.
    room.agents.add(ws);
    log("agent connected (total:", room.agents.size + ")", "on port", port);

    ws.on("message", (data) => {
      if (room.bridge && room.bridge.readyState === 1) {
        try { room.bridge.send(data.toString()); } catch {}
      }
    });

    ws.on("close", () => {
      room.agents.delete(ws);
      log("agent disconnected (total:", room.agents.size + ")", "on port", port);
    });
  }

  ensureRoom(opts.port).then((room) => {
    if (!room) {
      console.error("[server] cannot bind", opts.host + ":" + opts.port);
      process.exit(1);
    }
    log("listening on ws://" + opts.host + ":" + opts.port + (opts.token ? " (token required)" : ""));
    log("waiting for extension…");
  });
}

main();
