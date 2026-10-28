#!/usr/bin/env node
import { WebSocketServer } from "ws";
import { readFileSync, writeFileSync } from "node:fs";

// Generic Browser Agent Toolkit
// Reads a JSON task file and executes standard cross-site actions.
// Usage: node examples/agent-tools.mjs task.json [flags]
//          --port N   listen port (default 9222). Change it when something else
//                     owns 9222 — e.g. Chrome's --remote-debugging-port.
//          --watch    re-run when the task file changes
//          --output F write the final result to F

const args = process.argv.slice(2);
// Only these count as flags, so a task file named "--staging.json" still parses.
const FLAGS = new Set(["--watch", "--port", "--output"]);
const WITH_VALUE = new Set(["--port", "--output"]);
let taskFile = null;
for (let i = 0; i < args.length; i++) {
  if (FLAGS.has(args[i])) { if (WITH_VALUE.has(args[i])) i++; continue; }
  taskFile = args[i];
  break;
}
taskFile = taskFile || "task.json";
const watch = args.includes("--watch");
const outputFlag = args.indexOf("--output");
const outputFile = outputFlag >= 0 ? args[outputFlag + 1] : null;
const portFlag = args.indexOf("--port");
const port = portFlag >= 0 ? parseInt(args[portFlag + 1], 10) : 9222;

// Fail loudly instead of silently binding 9222 and then blaming a port conflict.
if (portFlag >= 0 && !Number.isInteger(port)) {
  console.error("[toolkit] --port needs a number, got: " + (args[portFlag + 1] != null ? args[portFlag + 1] : "(nothing)"));
  process.exit(1);
}
if (outputFlag >= 0 && !outputFile) {
  console.error("[toolkit] --output needs a file name");
  process.exit(1);
}

const host = "127.0.0.1";
const wss = new WebSocketServer({ host, port });
let bridge = null;
let nextId = 1;
const pending = new Map();

// Without this an occupied port surfaces as an unhandled 'error' event crash.
wss.on("error", (e) => {
  console.error(`[toolkit] cannot listen on ${host}:${port} — ${e.message}`);
  console.error("[toolkit] something else may own that port (Chrome's debugging port is 9222); retry with --port <N>");
  process.exit(1);
});

wss.on("connection", (ws) => {
  bridge = ws;
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    } catch (e) {}
  });
  ws.on("close", () => { if (bridge === ws) bridge = null; });
});

function rpc(method, params = {}, timeoutMs = 30000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    if (!bridge || bridge.readyState !== 1) { pending.delete(id); reject(new Error("extension not connected")); return; }
    bridge.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("timeout")); } }, timeoutMs);
  });
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function logStep(i, action, status, detail) {
  console.log(`[${i}] ${action}: ${status}${detail ? " — " + detail : ""}`);
}

function asNum(v) { return v == null ? v : (typeof v === "number" ? v : Number(v)); }

const tools = {
  async goto({ url, tabId, newTab = false, active = true }) {
    if (newTab) {
      const tab = await rpc("tabs.create", { url, active });
      return tab.id;
    }
    const id = asNum(tabId) || (await rpc("tabs.active")).id;
    await rpc("page.navigate", { tabId: id, url });
    return id;
  },
  async read({ selector, tabId }) {
    return rpc("page.getText", { tabId: asNum(tabId), selector });
  },
  async find({ selector, text, tabId, limit = 20, attrs = [] }) {
    const els = await rpc("page.querySelectorAll", { tabId: asNum(tabId), selector, limit, attrs });
    if (text) {
      const needle = text.toLowerCase();
      return els.filter((el) => JSON.stringify(el).toLowerCase().includes(needle));
    }
    return els;
  },
  async click({ selector, tabId }) {
    await rpc("page.click", { tabId: asNum(tabId), selector });
    return true;
  },
  async clickByText({ selector, text, tabId }) {
    await rpc("page.clickByText", { tabId: asNum(tabId), selector, text });
    return true;
  },
  async type({ selector, text, tabId }) {
    await rpc("page.setValue", { tabId: asNum(tabId), selector, value: text });
    return true;
  },
  async pressKey({ selector, key = "Enter", tabId }) {
    await rpc("page.pressKey", { tabId: asNum(tabId), selector, key });
    return true;
  },
  async submit({ selector, tabId }) {
    await rpc("page.click", { tabId: asNum(tabId), selector: `${selector} [type="submit"], ${selector} button` });
    return true;
  },
  async wait({ selector, timeoutMs = 10000, tabId }) {
    return rpc("page.waitFor", { tabId: asNum(tabId), selector, timeoutMs });
  },
  async screenshot({ tabId, format = "png" }) {
    return rpc("page.screenshot", { tabId: asNum(tabId), format });
  },
  async scroll({ dx = 0, dy = 0, selector, tabId }) {
    return rpc("page.scroll", { tabId: asNum(tabId), selector, dx, dy });
  },
  async tabs() {
    return rpc("tabs.list");
  },
  async active() {
    return rpc("tabs.active");
  },
  async findTab({ urlPattern, titlePattern }) {
    const tabs = await rpc("tabs.list");
    const re = urlPattern ? new RegExp(urlPattern) : null;
    const tRe = titlePattern ? new RegExp(titlePattern) : null;
    const tab = tabs.find((t) => (re && re.test(t.url)) || (tRe && tRe.test(t.title)));
    if (!tab) throw new Error("tab not found");
    return tab.id;
  },
  async sleep({ ms = 1000 }) {
    await wait(ms);
    return true;
  },
  async eval({ code, tabId, frameId }) {
    return rpc("page.eval", { tabId: asNum(tabId), frameId: asNum(frameId), code });
  },
  async consoleLog({ filter, limit, tabId }) {
    return rpc("console.getLog", { tabId: asNum(tabId), filter, limit });
  },
  async consoleClear({ tabId }) {
    return rpc("console.clear", { tabId: asNum(tabId) });
  },
  async perfMetrics({ tabId }) {
    return rpc("perf.metrics", { tabId: asNum(tabId) });
  },
  async perfResources({ filter, limit, tabId }) {
    return rpc("perf.resources", { tabId: asNum(tabId), filter, limit });
  },
};

function resolveRefs(value, state) {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (_, path) => {
      const keys = path.trim().split(".");
      let v = state;
      for (const k of keys) {
        if (v == null) return "";
        const m = k.match(/^(.+?)\[(\d+)\]$/);
        if (m) { v = v[m[1]]; if (v != null) v = v[parseInt(m[2])]; }
        else { v = v[k]; }
      }
      return v == null ? "" : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, state));
  if (value && typeof value === "object") {
    const out = {};
    for (const k in value) out[k] = resolveRefs(value[k], state);
    return out;
  }
  return value;
}

async function runTask(task) {
  const state = {};
  for (let i = 0; i < task.length; i++) {
    const step = resolveRefs(task[i], state);
    const action = step.action;
    const fn = tools[action];
    if (!fn) {
      logStep(i, action, "ERROR", `unknown action`);
      continue;
    }
    try {
      const result = await fn(step);
      if (step.saveAs) state[step.saveAs] = result;
      if (step.print !== false) {
        const detail = typeof result === "object" ? JSON.stringify(result).slice(0, 300) : String(result).slice(0, 300);
        logStep(i, action, "OK", detail);
      }
    } catch (e) {
      logStep(i, action, "ERROR", e.message);
      if (step.onError === "continue") continue;
      throw e;
    }
  }
  return state;
}

async function main() {
  console.log(`[toolkit] listening on ws://${host}:${port}`);
  console.log(`[toolkit] waiting for extension...`);
  while (!bridge) await wait(200);
  console.log(`[toolkit] extension connected\n`);

  const task = JSON.parse(readFileSync(taskFile, "utf8"));
  if (!Array.isArray(task)) {
    console.error("Task file must be a JSON array of action objects");
    process.exit(1);
  }

  let state = await runTask(task);
  console.log("\n[toolkit] done. state keys:", Object.keys(state).join(", "));
  if (outputFile) {
    writeFileSync(outputFile, JSON.stringify(state, null, 2));
    console.log("[toolkit] state written to", outputFile);
  }

  if (watch) {
    console.log("\n[toolkit] watching for task file changes... (Ctrl+C to stop)");
    let lastMtime = 0;
    while (true) {
      await wait(1000);
      const stat = await import("node:fs/promises").then((m) => m.stat(taskFile).catch(() => null));
      if (!stat) continue;
      if (stat.mtimeMs !== lastMtime) {
        lastMtime = stat.mtimeMs;
        console.log(`\n[toolkit] ${taskFile} changed, re-running...\n`);
        try {
          const newTask = JSON.parse(readFileSync(taskFile, "utf8"));
          state = await runTask(newTask);
        } catch (e) {
          console.error("[toolkit] error:", e.message);
        }
      }
    }
  }

  process.exit(0);
}

main().catch((e) => { console.error("[toolkit] fatal:", e.message); process.exit(1); });
