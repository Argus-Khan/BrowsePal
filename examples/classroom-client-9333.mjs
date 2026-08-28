#!/usr/bin/env node
// Client for the agent-server on port 9333 (where Firefox extension connects)
import { connect } from "../lib/client.mjs";

const { rpc, close } = await connect(9333);

console.log("Connected to agent-server on port 9333\n");

try {
  // 1. Check bridge status
  const status = await rpc("agent.status");
  console.log("=== BRIDGE STATUS ===");
  console.log(JSON.stringify(status, null, 2));

  // 2. List all tabs
  const tabs = await rpc("tabs.list");
  console.log("\n=== ALL TABS ===");
  tabs.forEach((t, i) => console.log(`  [${i}] id=${t.id}  title="${t.title}"  url=${t.url}`));

  // 3. Get active tab
  const active = await rpc("tabs.active");
  console.log("\n=== ACTIVE TAB ===");
  console.log(`  id=${active.id}  title="${active.title}"  url=${active.url}`);

  // 4. Read body text of active tab
  console.log("\n=== READING PAGE BODY ===");
  const bodyText = await rpc("page.getText", { tabId: active.id, selector: "body" });
  const text = typeof bodyText === 'string' ? bodyText : JSON.stringify(bodyText);
  console.log(text.slice(0, 10000));

  // 5. Take screenshot
  console.log("\n=== SCREENSHOT ===");
  const screenshot = await rpc("page.screenshot", { tabId: active.id, format: "png" });
  if (typeof screenshot === 'string') {
    const fs = await import("node:fs");
    const buf = Buffer.from(screenshot, 'base64');
    fs.writeFileSync("/tmp/classroom-screenshot.png", buf);
    console.log(`Saved to /tmp/classroom-screenshot.png (${buf.length} bytes)`);
  } else {
    console.log("Screenshot result:", JSON.stringify(screenshot).slice(0, 500));
  }

} catch (e) {
  console.error("ERROR:", e.message);
}

close();
process.exit(0);
