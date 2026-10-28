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
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
check("documented example task files exist", () => {
  const docs = read("README.md") + read("skills/browser-bridge/SKILL.md");
  const refs = docs.match(/examples\/[\w.-]+\.json/g) || [];
  must(refs.length, "no example task files referenced");
  for (const r of [...new Set(refs)]) must(existsSync(join(root, r)), "referenced but missing: " + r);
});

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
