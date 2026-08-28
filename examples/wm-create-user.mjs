#!/usr/bin/env node
import { connect, sleep } from "../lib/client.mjs";
import { writeFileSync } from "node:fs";

const PORT = Number(process.env.BRIDGE_PORT || 9333);
const { rpc, close } = await connect(PORT);

const tabs = await rpc("tabs.list");
const tab = (tabs || []).find((t) => /page=wm-consult-people/i.test(t.url || ""));
if (!tab) throw new Error("Users page tab not found");
const tabId = tab.id;
await rpc("tabs.activate", { tabId });
console.log("Using tab", tabId, tab.url);

const stamp = Date.now();
const user = {
  firstName: "Bridge",
  lastName: "TestUser",
  email: `bridge.test.${stamp}@example.com`,
  phone: "+15555550100",
  password: "BridgeTest1234!",
  role: "patient",
};

console.log("Creating user", user.email);

await rpc("page.scrollIntoView", { tabId, selector: "a.wm-create-open" });
await rpc("page.click", { tabId, selector: "a.wm-create-open" });
await sleep(1500);

await rpc("page.waitFor", { tabId, selector: "#TB_window #wm_boot_first", timeoutMs: 10000 });

await rpc("page.setValue", { tabId, selector: "#wm_boot_first", value: user.firstName });
await rpc("page.setValue", { tabId, selector: "#wm_boot_last", value: user.lastName });
await rpc("page.setValue", { tabId, selector: "#wm_boot_email", value: user.email });
await rpc("page.setValue", { tabId, selector: "#wm_boot_phone", value: user.phone });
await rpc("page.setValue", { tabId, selector: "#wm_boot_pass", value: user.password });
await rpc("page.setValue", { tabId, selector: "#wm_boot_role", value: user.role });

await sleep(300);
await rpc("page.click", { tabId, selector: "#TB_window .wm-create-form input[type='submit']" });

await sleep(4000);

const active = await rpc("tabs.active");
const text = await rpc("page.getText", { tabId: active.id });
const snippet = String(text || "").slice(0, 4000);
console.log("\nPAGE AFTER SUBMIT\n", snippet);

const row = await rpc("page.querySelectorAll", {
  tabId: active.id,
  selector: "table.wm-users-table tbody tr",
  limit: 5,
  attrs: ["innerText"],
});
console.log("\nTOP TABLE ROWS\n", JSON.stringify(row, null, 2));

try {
  const shot = await rpc("page.screenshot", { tabId: active.id, format: "png" });
  const b64 = typeof shot === "string" ? (shot.includes(",") ? shot.split(",").pop() : shot) : shot?.data;
  if (b64) {
    writeFileSync("/tmp/wm-create-user-result.png", Buffer.from(b64, "base64"));
    console.log("Screenshot /tmp/wm-create-user-result.png");
  }
} catch (e) {
  console.log("Screenshot failed", e.message);
}

const created = snippet.includes(user.email) || JSON.stringify(row).includes(user.email);
console.log("\nRESULT", created ? "SUCCESS" : "UNCLEAR", user.email);

close();
process.exit(created ? 0 : 2);
