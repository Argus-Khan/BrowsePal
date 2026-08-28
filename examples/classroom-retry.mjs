#!/usr/bin/env node
// Retry client that tries to catch the extension during its brief connection window
import { connect } from "../lib/client.mjs";

const PORTS = [9333, 9222];

async function tryConnect(port) {
  const { rpc, ws, close } = await connect(port);
  try {
    const status = await rpc("agent.status");
    if (status && status.connected) {
      console.log(`  Extension is CONNECTED on port ${port}!`);
      return { rpc, ws, close, port, status };
    }
    console.log(`  Extension not connected (status: ${JSON.stringify(status)})`);
    close();
    throw new Error("extension not connected");
  } catch (e) {
    console.log(`  RPC failed on port ${port}: ${e.message}`);
    close();
    throw e;
  }
}

async function main() {
  for (let attempt = 1; attempt <= 5; attempt++) {
    console.log(`\nAttempt ${attempt}/5...`);
    for (const port of PORTS) {
      try {
        const { rpc, close, port: p, status } = await tryConnect(port);
        console.log(`\n=== BRIDGE STATUS (port ${p}) ===`);
        console.log(JSON.stringify(status, null, 2));

        // List tabs
        const tabs = await rpc("tabs.list");
        console.log("\n=== ALL TABS ===");
        tabs.forEach((t, i) => console.log(`  [${i}] id=${t.id}  title="${t.title}"  url=${t.url}`));

        // Active tab
        const active = await rpc("tabs.active");
        console.log("\n=== ACTIVE TAB ===");
        console.log(`  id=${active.id}  title="${active.title}"  url=${active.url}`);

        // Find classroom tab
        const classroomTab = tabs.find(t => t.url && t.url.includes("classroom.google.com"));
        const targetTab = classroomTab || active;
        console.log(`\n=== TARGET TAB: ${classroomTab ? "Classroom" : "Active"} ===`);
        console.log(`  id=${targetTab.id}  title="${targetTab.title}"  url=${targetTab.url}`);

        // Read body
        console.log("\n=== PAGE TEXT ===");
        const bodyText = await rpc("page.getText", { tabId: targetTab.id, selector: "body" });
        const text = typeof bodyText === 'string' ? bodyText : JSON.stringify(bodyText);
        console.log(text.slice(0, 15000));

        // Screenshot
        console.log("\n=== SCREENSHOT ===");
        const screenshot = await rpc("page.screenshot", { tabId: targetTab.id, format: "png" });
        if (typeof screenshot === 'string') {
          const fs = await import("node:fs");
          const buf = Buffer.from(screenshot, 'base64');
          fs.writeFileSync("/tmp/classroom-screenshot.png", buf);
          console.log(`Saved to /tmp/classroom-screenshot.png (${buf.length} bytes)`);
        }

        close();
        process.exit(0);
      } catch (e) {
        console.log(`  Failed: ${e.message}`);
      }
    }
    // Wait before retry
    if (attempt < 5) {
      console.log("  Waiting 3s before retry...");
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  console.log("\nFailed to connect after 5 attempts.");
  process.exit(1);
}

main();
