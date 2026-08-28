import { connect, sleep } from "../lib/client.mjs";

const PORT = Number(process.env.BRIDGE_PORT || 9222);
const { rpc, close } = await connect(PORT);

async function waitForBridge(maxMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      await rpc("tabs.list", {}, 2000);
      return true;
    } catch {
      await sleep(500);
    }
  }
  return false;
}

async function probeBrowser() {
  const tabs = await rpc("tabs.list");
  const sample = tabs?.[0]?.url || "";
  return { tabCount: tabs?.length || 0, sample };
}

console.log(`Waiting for bridge on ${PORT}...`);
if (!(await waitForBridge())) {
  console.error("No bridge connected");
  close();
  process.exit(1);
}

let info = await probeBrowser();
console.log("CONNECTED", info);

const usersUrl = "http://localhost:8085/wp-admin/admin.php?page=wm-consult-people";
let tab = null;
try {
  const tabs = await rpc("tabs.list");
  tab = (tabs || []).find((t) => /page=wm-consult-people/i.test(t.url || ""));
} catch (e) {
  console.log("tabs.list failed", e.message);
}

if (!tab) {
  tab = await rpc("tabs.create", { url: usersUrl, active: true });
  console.log("CREATED_TAB", tab.id);
} else {
  await rpc("tabs.activate", { tabId: tab.id });
  await rpc("page.reload", { tabId: tab.id });
  console.log("RELOADED_TAB", tab.id, tab.url);
}

await sleep(4000);

const active = await rpc("tabs.active");
console.log("ACTIVE", JSON.stringify(active, null, 2));

const tabId = active.id;
const text = await rpc("page.getText", { tabId });
console.log("\nPAGE_SNIPPET\n", String(text || "").slice(0, 3000));

const checks = ["#TB_overlay", "#TB_window", "#wm-consult-create-user", ".wm-create-open", ".wrap h1"];
for (const selector of checks) {
  try {
    const els = await rpc("page.querySelectorAll", { tabId, selector, limit: 2, attrs: ["id", "class", "style"] });
    console.log(`FIND ${selector}`, JSON.stringify(els));
  } catch (e) {
    console.log(`FIND ${selector} ERR`, e.message);
  }
}

try {
  const scripts = await rpc("page.querySelectorAll", {
    tabId,
    selector: 'script[src*="admin-create-popup"], script[src*="thickbox"]',
    limit: 10,
    attrs: ["src"],
  });
  console.log("SCRIPTS", JSON.stringify(scripts, null, 2));
} catch (e) {
  console.log("SCRIPTS ERR", e.message);
}

try {
  const shot = await rpc("page.screenshot", { tabId, format: "png" });
  const b64 = typeof shot === "string" ? (shot.includes(",") ? shot.split(",").pop() : shot) : shot?.data;
  if (b64) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync("/tmp/wm-users-firefox.png", Buffer.from(b64, "base64"));
    console.log("SCREENSHOT /tmp/wm-users-firefox.png", Buffer.from(b64, "base64").length);
  }
} catch (e) {
  console.log("SCREENSHOT_ERR", e.message);
}

close();
