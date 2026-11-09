#!/usr/bin/env node
/**
 * Generic copy-paste examples for driving a browser over the bridge.
 * Reuse this file instead of rewriting the plumbing every time.
 *
 *   node examples/generic-examples.mjs [port] [url]
 *   node examples/generic-examples.mjs 9223 http://localhost:8080/
 *
 * Two layers:
 *   1. SDK  — import { BrowserAgent } from "../lib/client.mjs"  (this file)
 *   2. raw  — agent.rpc("any.method", params)  for anything the SDK misses
 *
 * Signatures live in lib/client.mjs (Page / BrowserAgent classes) — read them
 * instead of guessing. Never hardcode credentials; pass them via env.
 */
import { BrowserAgent } from "../lib/client.mjs";

const port = Number(process.argv[2]) || 9222;
const url = process.argv[3] || "https://example.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The content script injects a few seconds after a tab opens; poll for it
// instead of a fixed sleep. "Receiving end does not exist" / -32003 = not
// injected yet (or a privileged page where it never will be).
async function whenReady(page, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try {
      return await page.snapshot();
    } catch {
      await sleep(1500);
    }
  }
  throw new Error("content script never answered");
}

const agent = await BrowserAgent.connect(port); // port, "port", or "host:port"
let tab;
try {
  // ── tabs ───────────────────────────────────────────────────────────────
  const tabs = await agent.tabs();
  console.log(`open tabs (${tabs.length}):`, tabs.map((t) => t.id).join(", "));

  tab = await agent.newTab(url); // resolves to the full tab object
  const page = await agent.page(tab.id); // await it — page() is async

  // ── read ───────────────────────────────────────────────────────────────
  const snap = await whenReady(page);
  console.log("interactive elements (refs):", snap.refs().length);
  console.log("page text:", (await page.read()).slice(0, 120) + "…"); // page.read("css") for one element

  // ── interact ───────────────────────────────────────────────────────────
  // Refs from a snapshot are the safest target; a plain CSS selector works too.
  // Replace the lookup with the element YOUR task needs.
  const target = snap.find("Login") || snap.findAll("button")[0];
  if (target) {
    await page.click(target.ref); // ref like "e7" — resolved inside the page
    await sleep(1500);
    console.log("after click:", (await page.read()).slice(0, 100) + "…");
  } else {
    console.log("no button on this page — click skipped");
  }

  // Positional args — easy to get wrong:
  //   await page.type("hello", "input#q");        // (text, selector?)
  //   await page.press("Enter", "input#q");       // (key, selector?)
  //   await page.waitFor("h1", { timeoutMs: 5000 }); // → true, or throws
  //   await page.goto(url); await page.reload();
  // There is no page.fill — use page.type, or raw page.setValue.

  // ── screenshot → { format, dataUrl } ───────────────────────────────────
  const shot = await page.screenshot({ format: "png" });
  console.log("screenshot:", shot.dataUrl.slice(0, 30) + "…", shot.dataUrl.length, "chars");

  // ── raw escape hatch: any protocol method ──────────────────────────────
  const logs = await agent.rpc("console.getLog", {});
  console.log("console entries:", Array.isArray(logs) ? logs.length : logs);
  // Firefox: net.* needs chrome.debugger → -32010 there; use agent.passiveLog.
  // Errors reject as Error; e.message carries {code,message}:
  //   -32003 not injected yet, -32004 page CSP blocks eval, -32010 no debugger.

  // ── cookies (count only — they hold live sessions) ─────────────────────
  console.log("cookies:", (await agent.cookies()).length);
} finally {
  // Close tabs YOU opened; never touch the user's existing tabs.
  if (tab) await agent.closeTab(tab.id).catch(() => {});
  agent.close();
}
