#!/usr/bin/env node
/**
 * Self-check for browsepal.  Run: npm run check   (or: node scripts/selfcheck.js)
 *
 * There is no test harness in this project, so this covers what can actually be
 * verified without a browser: that every file parses, that the manifest/build/
 * package wiring for console-capture.js stayed in sync, that the new RPC methods
 * are documented, and that agent-tools.mjs fails cleanly on a busy port.
 *
 * Console/performance capture itself only proves out in a real browser — see
 * examples/console-perf.json for the smoke test.
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("  ok   " + name);
  } catch (e) {
    failures++;
    console.log("  FAIL " + name + "\n       " + (e && e.message));
  }
}
function must(cond, msg) { if (!cond) throw new Error(msg); }

// ─── 1. Every shipped/edited file parses ──────────────────────────────────────

console.log("syntax");
const JS = [
  "background.js", "content.js", "console-capture.js", "options.js", "popup.js",
  "lib/rpc.js", "lib/protocol.js", "lib/net.js", "lib/page.js", "lib/storage.js",
  "lib/ws.js", "lib/browser.js", "lib/cdp.js", "lib/tabs.js", "lib/defaults.js", "lib/server.js",
  "examples/agent-tools.mjs", "examples/agent-server.js",
  "scripts/build-dist.js", "scripts/build-xpi.js", "scripts/selfcheck.js",
];
for (const f of JS) {
  check("node --check " + f, () => {
    const r = spawnSync(process.execPath, ["--check", join(root, f)], { encoding: "utf8" });
    must(r.status === 0, (r.stderr || "").trim().split("\n")[0] || "exit " + r.status);
  });
}
for (const f of ["manifest.json", "manifest-firefox.json", "package.json"]) {
  check("json " + f, () => JSON.parse(read(f)));
}

// ─── 2. console-capture.js wiring stays in sync across manifests/build ───────

console.log("wiring");
for (const f of ["manifest.json", "manifest-firefox.json"]) {
  check(f + " injects console-capture.js in MAIN world at document_start", () => {
    const m = JSON.parse(read(f));
    const cs = (m.content_scripts || []).find((c) => (c.js || []).includes("console-capture.js"));
    must(cs, "no content_scripts entry includes console-capture.js");
    must(cs.world === "MAIN", 'world must be "MAIN" — an ISOLATED script cannot see page console calls');
    must(cs.run_at === "document_start", "run_at must be document_start to catch page-load messages");
    must(cs.all_frames === true, "all_frames must be true");
  });
}
check("package.json ships console-capture.js", () => must(read("package.json").includes('"console-capture.js"'), "missing from files[]"));
check("build-dist copies console-capture.js", () => must(read("scripts/build-dist.js").includes('"console-capture.js"'), "missing from SHARED_FILES"));
check("Firefox floor covers MAIN world (128+)", () => {
  const m = JSON.parse(read("manifest-firefox.json"));
  const min = String(m.browser_specific_settings?.gecko?.strict_min_version || "");
  const major = parseInt(min.split(".")[0], 10);
  must(major >= 128, 'strict_min_version must be "128.0" or newer for world: "MAIN" (got "' + min + '")');
});
check("Chrome floor covers MAIN world (111+)", () => {
  const m = JSON.parse(read("manifest.json"));
  const raw = String(m.minimum_chrome_version || "");
  must(parseInt(raw.split(".")[0], 10) >= 111, "minimum_chrome_version must be 111+ for world: \"MAIN\" (got \"" + raw + "\")");
});

// ─── 3. New RPC surface exists and is documented ──────────────────────────────

console.log("protocol");
const bg = read("background.js");
for (const m of ["console.getLog", "console.clear", "perf.metrics", "perf.resources"]) {
  check("background.js registers " + m, () => must(bg.includes('"' + m + '"'), "not in a method list"));
}
check("content.js handles ba:console + ba:perf", () => {
  const c = read("content.js");
  must(c.includes('"ba:console"'), "no ba:console route");
  must(c.includes('"ba:perf"'), "no ba:perf route");
});
// The content script switches on msg.op, which the background side must inject
// (the RPC method name is what tells it which op to run).
check("background forwards the op that content.js switches on", () => {
  for (const ns of ["MSG.CONSOLE", "MSG.PERF"]) {
    must(new RegExp(ns + ",\\s*\\{ \\.\\.\\.params, op: name2key\\(m\\) \\}").test(bg),
      ns + " forward does not inject op: name2key(m)");
  }
  must(bg.includes("CONSOLE_METHODS = [") && bg.includes("PERF_METHODS = ["), "method lists missing");
});
check("console read paths are gated by allowRead", () => {
  for (const m of ["console.getLog", "perf.metrics", "perf.resources"]) {
    must(bg.includes('"' + m + '"'), m + " missing");
  }
  const block = bg.match(/READ_METHODS = new Set\(\[([\s\S]*?)\]\)/);
  must(block, "READ_METHODS not found");
  for (const m of ["console.getLog", "perf.metrics", "perf.resources"]) {
    must(block[1].includes('"' + m + '"'), m + " not in READ_METHODS");
  }
});
for (const f of ["README.md", "skills/browser-bridge/SKILL.md"]) {
  check(f + " documents console.* and perf.*", () => {
    const t = read(f);
    must(t.includes("console.getLog"), "no console.getLog");
    must(t.includes("perf.metrics"), "no perf.metrics");
  });
}
check("agent-tools.mjs exposes console/perf task actions", () => {
  const t = read("examples/agent-tools.mjs");
  for (const a of ["consoleLog", "consoleClear", "perfMetrics", "perfResources"]) {
    must(t.includes("async " + a + "("), "missing action " + a);
  }
});
check("agent-tools.mjs default port is overridable", () => must(read("examples/agent-tools.mjs").includes("args.indexOf(\"--port\")"), "no --port parsing"));
// Observer callbacks are queued tasks, so registering on first perf.metrics
// call means that call reads zeroed CLS/LCP/INP. Must happen at load instead.
check("perf observers register at content-script load", () => {
  const c = read("content.js");
  const fromInit = c.indexOf("─── Initialize ─");
  must(fromInit !== -1, "Initialize section not found");
  must(c.slice(fromInit).includes("_perfInit();"), "_perfInit() not called during Initialize — the first perf.metrics would read zeroed values");
});

// ─── 4. Busy port fails cleanly instead of crashing ───────────────────────────

console.log("agent-tools port");
const srv = createServer();
await new Promise((res) => srv.listen(0, "127.0.0.1", res));
const busyPort = srv.address().port;

const r = spawnSync(
  process.execPath,
  [join(root, "examples/agent-tools.mjs"), "examples/read-page.json", "--port", String(busyPort)],
  { encoding: "utf8", timeout: 15000, cwd: root },
);
srv.close();

check("exits 1 when the port is taken", () => must(r.status === 1, "status=" + r.status + " out=" + (r.stdout + r.stderr).trim()));
check("prints an actionable message, not a crash stack", () => {
  const out = r.stdout + r.stderr;
  must(out.includes("[toolkit] cannot listen on"), "no '[toolkit] cannot listen on' message:\n" + out.trim());
  must(out.includes("--port"), "message does not suggest --port");
  must(!/\n\s+at /.test(out), "printed a stack trace (unhandled 'error' event):\n" + out.trim());
});

const badPort = spawnSync(
  process.execPath,
  [join(root, "examples/agent-tools.mjs"), "examples/read-page.json", "--port", "abc"],
  { encoding: "utf8", timeout: 15000, cwd: root },
);
check("--port with a non-numeric value fails loudly", () => {
  must(badPort.status === 1, "status=" + badPort.status + " (a hang here means validation runs after the server binds)");
  must((badPort.stdout + badPort.stderr).includes("--port needs a number"), "no clear message:\n" + (badPort.stdout + badPort.stderr).trim());
});

// ─── 5. The three skill copies must not drift apart ───────────────────────────

console.log("skill copies");
check("skill copies are byte-identical to the canonical one", () => {
  const canonical = read("skills/browser-bridge/SKILL.md");
  const home = process.env.HOME || "";
  const copies = [
    join(home, ".config/opencode/skills/browser-bridge/SKILL.md"),
    join(home, ".config/ocv/skills/browser-bridge/SKILL.md"),
  ].filter(existsSync);
  // A fresh host with none of them installed has nothing to drift.
  for (const p of copies) {
    must(readFileSync(p, "utf8") === canonical, "drifted from skills/browser-bridge/SKILL.md: " + p);
  }
});
check("no docs point at the removed .opencode/skills path", () => {
  for (const f of ["README.md", "BUILD_AND_PUBLISH.md", "AGENTS.md", "CONTEXT.md",
    "skills/browser-bridge/SKILL.md", "skills/claude-code/BROWSER_BRIDGE.md",
    "skills/cursor/BROWSER_BRIDGE.md"]) {
    must(!read(f).includes(".opencode/skills"), f + " references .opencode/skills (deleted from this repo)");
  }
});
check("no docs reference the removed browser-testing-with-devtools skill", () => {
  for (const f of ["README.md", "BUILD_AND_PUBLISH.md", "AGENTS.md", "CONTEXT.md",
    "skills/browser-bridge/SKILL.md", "skills/claude-code/BROWSER_BRIDGE.md",
    "skills/cursor/BROWSER_BRIDGE.md"]) {
    must(!read(f).includes("browser-testing-with-devtools"),
      f + " references browser-testing-with-devtools (merged into browser-bridge, skill removed)");
  }
});
console.log("expr dsl");
check("content.js has no new Function / eval(", () => {
  const c = read("content.js");
  must(!/\bnew\s+Function\b/.test(c), "new Function still present");
  must(!/\beval\s*\(/.test(c), "eval( still present");
});
check("whitelist expr DSL evaluates common probes", () => {
  const c = read("content.js");
  const start = c.indexOf("// ─── Expr DSL BEGIN");
  const end = c.indexOf("// ─── Expr DSL END");
  must(start !== -1 && end !== -1 && end > start, "Expr DSL markers missing in content.js");
  // Isolate evalExpr so Node can run it without the content-script IIFE.
  const body = c.slice(start, end).replace(/^\s*\/\/[^\n]*\n/, "");
  // eslint-disable-next-line no-new-func -- test harness only, not shipped
  const evalExpr = new Function(body + "\nreturn evalExpr;")();
  const roots = {
    document: {
      title: "Example",
      body: { className: "x" },
      querySelector(sel) {
        if (sel === ".wm-status") return { textContent: "ok" };
        if (sel.includes("wm-consult")) return { innerText: "doc" };
        return null;
      },
    },
    window: { WM_CONSULT: { a: 1 }, WM_CONSULT_BOOKING: null },
    location: { href: "https://example.test/" },
    navigator: {},
    Math, JSON, Number, String, Boolean, Array, Object, Date,
    localStorage: {}, sessionStorage: {}, history: {}, performance: {},
  };
  const cases = [
    ["document.title", "Example"],
    ["location.href", "https://example.test/"],
    ["window.WM_CONSULT || window.WM_CONSULT_BOOKING || null", { a: 1 }],
    ["document.querySelector('.wm-status')?.textContent || ''", "ok"],
    ["!!document.querySelector('#missing')", false],
    ["1 + 2", null], // should throw — arithmetic not in DSL
  ];
  for (const [expr, expected] of cases.slice(0, 5)) {
    const got = evalExpr(expr, roots);
    must(JSON.stringify(got) === JSON.stringify(expected), expr + " => " + JSON.stringify(got));
  }
  let threw = false;
  try { evalExpr("1 + 2", roots); } catch { threw = true; }
  must(threw, "unsupported arithmetic should throw");
});

check("documented example task files exist", () => {
  const docs = read("README.md") + read("skills/browser-bridge/SKILL.md");
  const refs = docs.match(/examples\/[\w.-]+\.json/g) || [];
  must(refs.length, "no example task files referenced");
  for (const r of [...new Set(refs)]) must(existsSync(join(root, r)), "referenced but missing: " + r);
});

// ─── 6. Relay sticky-cid behavior (live sockets) ─────────────────────────────

console.log("relay sticky cid");

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log("  ok   " + name);
  } catch (e) {
    failures++;
    console.log("  FAIL " + name + "\n       " + (e && e.message));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connectWs(url, ms = 4000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    // Buffer every message from the start: a bridge.redirect can land
    // between the open event and a caller attaching its listener.
    ws._buf = [];
    ws.on("message", (d) => ws._buf.push(String(d)));
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("connect timeout: " + url)); }, ms);
    ws.on("open", () => { clearTimeout(t); resolve(ws); });
    ws.on("error", (e) => { clearTimeout(t); reject(new Error("connect failed: " + url + " (" + e.message + ")")); });
  });
}

function expectMessage(ws, pred, ms = 4000, label = "message") {
  return new Promise((resolve, reject) => {
    const take = (raw) => {
      let m;
      try { m = JSON.parse(String(raw)); } catch { return null; }
      return pred(m) ? m : null;
    };
    // Check messages that arrived before this call.
    const buf = ws._buf || [];
    for (let i = 0; i < buf.length; i++) {
      const m = take(buf[i]);
      if (m) { buf.splice(i, 1); return resolve(m); }
    }
    const t = setTimeout(() => { ws.off("message", on); reject(new Error("expected " + label + " not received")); }, ms);
    const on = (d) => {
      const m = take(d);
      if (m) {
        clearTimeout(t);
        ws.off("message", on);
        const at = (ws._buf || []).indexOf(String(d));
        if (at !== -1) ws._buf.splice(at, 1);
        resolve(m);
      }
    };
    ws.on("message", on);
  });
}

function waitClose(ws, ms = 4000) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === 3) return resolve();
    const t = setTimeout(() => reject(new Error("socket did not close")), ms);
    ws.on("close", () => { clearTimeout(t); resolve(); });
  });
}

/** Reply to every rpc request with a tag, so a round trip proves the pairing. */
function echoAs(ws, tag) {
  ws.on("message", (d) => {
    let m;
    try { m = JSON.parse(String(d)); } catch { return; }
    if (m && m.id != null && m.method) {
      try { ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: tag })); } catch {}
    }
  });
}

async function rpcThrough(ws, tag, ms = 4000) {
  const id = Math.floor(Math.random() * 1e9);
  const p = expectMessage(ws, (m) => m.id === id, ms, "rpc response for " + tag);
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "ping", params: {} }));
  const m = await p;
  if (m.error) throw new Error("rpc error: " + m.error.message);
  must(m.result === tag, "expected " + tag + " got " + JSON.stringify(m.result));
}

function redirectPort(m) {
  must(m && m.method === "bridge.redirect" && m.params && m.params.url, "no bridge.redirect received");
  return new URL(m.params.url).port;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

await checkAsync("in-place reclaim and sticky port assignment", async () => {
  const base = await freePort();
  const proc = spawn(process.execPath, [join(root, "lib/server.js"), "--port", String(base)], { stdio: "ignore" });
  const socks = [];
  const open = async (url) => {
    let last;
    for (let i = 0; i < 20; i++) {
      try { const w = await connectWs(url, 1000); socks.push(w); return w; }
      catch (e) { last = e; await sleep(250); }
    }
    throw last;
  };
  try {
    // ── A: same cid reclaiming its slot replaces the stale socket in place ──
    const ext1 = await open(`ws://127.0.0.1:${base}/?bridge=1&cid=bp-test`);
    echoAs(ext1, "A1");
    await sleep(100);
    const agent1 = await open(`ws://127.0.0.1:${base}/`);
    await rpcThrough(agent1, "A1");

    const ext2 = await open(`ws://127.0.0.1:${base}/?bridge=1&cid=bp-test`);
    echoAs(ext2, "A2");
    await waitClose(ext1); // the relay closed the stale socket, not us
    must(ext2.readyState === 1, "reclaiming socket was closed (displaced instead)");
    await rpcThrough(agent1, "A2");

    agent1.close();
    ext2.close();
    await sleep(400);

    // ── B: assignment sticks across disconnects ─────────────────────────────
    const sq = await open(`ws://127.0.0.1:${base}/`); // squatter claims base
    await sleep(100);

    const decoy = await open(`ws://127.0.0.1:${base}/?bridge=1&cid=bp-decoy`);
    const dPort = redirectPort(await expectMessage(decoy, (m) => m.method === "bridge.redirect", 4000, "decoy redirect"));
    must(dPort !== String(base), "decoy should be displaced off base");
    const decoy2 = await open(`ws://127.0.0.1:${dPort}/?bridge=1&cid=bp-decoy`);
    echoAs(decoy2, "D");

    const x1 = await open(`ws://127.0.0.1:${base}/?bridge=1&cid=bp-sticky`);
    const x1Port = redirectPort(await expectMessage(x1, (m) => m.method === "bridge.redirect", 4000, "x1 redirect"));
    must(x1Port !== dPort && x1Port !== String(base), "x1 should land past the squatters");
    const x1b = await open(`ws://127.0.0.1:${x1Port}/?bridge=1&cid=bp-sticky`);
    echoAs(x1b, "X1");

    // Free the slot BELOW the assigned one — a non-sticky relay would hand
    // it out next; a sticky one must return us to x1Port.
    decoy2.close();
    x1b.close();
    await sleep(400);

    const x2 = await open(`ws://127.0.0.1:${base}/?bridge=1&cid=bp-sticky`);
    const x2Port = redirectPort(await expectMessage(x2, (m) => m.method === "bridge.redirect", 4000, "x2 redirect"));
    must(x2Port === x1Port, "sticky assignment broken: got " + x2Port + ", assigned " + x1Port);
    const x2b = await open(`ws://127.0.0.1:${x2Port}/?bridge=1&cid=bp-sticky`);
    echoAs(x2b, "X2");
    const agent2 = await open(`ws://127.0.0.1:${x2Port}/`);
    await rpcThrough(agent2, "X2");
  } finally {
    for (const s of socks) { try { s.close(); } catch {} }
    try { proc.kill(); } catch {}
  }
});

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
