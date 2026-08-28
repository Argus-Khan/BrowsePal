#!/usr/bin/env node
/**
 * Example: High-level browser agent using the new SDK
 * 
 * Demonstrates the new snapshot + action plan API.
 * 
 * Usage:
 *   1. Start the relay server:  node lib/server.js
 *   2. Load the extension (it connects to the relay)
 *   3. Run this example:  node examples/snapshot-example.mjs
 */

import { BrowserAgent } from "../lib/client.mjs";

async function main() {
  console.log("Connecting to Browser Agent Bridge...");
  const agent = await BrowserAgent.connect("127.0.0.1:9222", {
    onNotification: (method, params) => {
      console.log("  [notification]", method, params?.url || "");
    },
  });

  console.log("Connected!\n");

  // Get the active page
  const page = await agent.page();

  // ── 1. Take a snapshot ──────────────────────────────────────────────────
  console.log("=== Taking snapshot ===");
  const snap = await page.snapshot();
  console.log("URL:", snap.url);
  console.log("Title:", snap.title);
  console.log("Interactive elements:", snap.refs().length);

  // Print all interactive elements
  for (const ref of snap.refs()) {
    console.log(`  [${ref.ref}] ${ref.role}: "${ref.name || ""}" ${ref.value ? `value="${ref.value}"` : ""}`);
  }

  // ── 2. Find elements by name ────────────────────────────────────────────
  console.log("\n=== Finding elements ===");
  const searchBox = snap.find("search");
  if (searchBox) {
    console.log("Found search box:", searchBox.ref, searchBox.role);
  }

  const buttons = snap.findAll("button");
  console.log("Buttons found:", buttons.length);
  for (const btn of buttons) {
    console.log(`  [${btn.ref}] "${btn.name}"`);
  }

  // ── 3. Execute an action plan (one round trip) ──────────────────────────
  console.log("\n=== Action plan ===");
  if (searchBox) {
    const results = await page.act([
      { action: "fill", ref: searchBox.ref, value: "hello world" },
      { action: "press", ref: searchBox.ref, key: "Enter" },
      { action: "wait", state: "navigation", timeoutMs: 5000 },
      { action: "snapshot" },
    ]);
    console.log("Action results:");
    for (const r of results) {
      console.log(`  step ${r.step}: ${r.ok ? "OK" : "FAIL"} ${r.err || ""}`);
    }
  }

  // ── 4. Low-level operations still work ──────────────────────────────────
  console.log("\n=== Low-level read ===");
  const text = await page.read("body");
  console.log("Page text (first 500 chars):", (text || "").slice(0, 500));

  // ── 5. Take a screenshot ────────────────────────────────────────────────
  console.log("\n=== Screenshot ===");
  const shot = await page.screenshot({ format: "jpeg", quality: 50 });
  console.log("Screenshot:", shot.format, shot.dataUrl?.slice(0, 50) + "...");

  // ── Done ────────────────────────────────────────────────────────────────
  agent.close();
  console.log("\nDone!");
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
