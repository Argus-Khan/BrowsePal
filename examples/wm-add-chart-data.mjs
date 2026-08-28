#!/usr/bin/env node
import { connect, sleep } from "../lib/client.mjs";

const PORT = Number(process.env.BRIDGE_PORT || 9222);
const FRAME = 0;
const CLINICIAN_EMAIL = "sarah.chen.1787143770066@example.com";
const PATIENT_NAME = "Emma Wilson";
const PASSWORD = "BridgeTest1234!";

const { rpc, close } = await connect(PORT);

async function clickText(tabId, text, selector = "button, a", timeoutMs = 10000) {
  return rpc("page.clickByText", { tabId, frameId: FRAME, selector, text }, timeoutMs);
}

async function set(tabId, selector, value) {
  return rpc("page.setValue", { tabId, frameId: FRAME, selector, value });
}

async function text(tabId) {
  return rpc("page.getText", { tabId, frameId: FRAME, selector: "body" });
}

const tabs = await rpc("tabs.list");
const tab = tabs.find((t) => /wellnessmetric\.net\/portal/i.test(t.url || ""));
if (!tab) throw new Error("Portal tab not found");
const tabId = tab.id;
await rpc("tabs.activate", { tabId });

let body = String(await text(tabId));

if (body.includes("Portal\n\nView upcoming visits")) {
  await clickText(tabId, "Sign out").catch(() => {});
  await sleep(4000);
  await rpc("page.reload", { tabId });
  await sleep(4000);
  body = String(await text(tabId));
}

if (body.includes("Sign in to manage appointments, charts, and clinician tools.")) {
  await set(tabId, 'form.wm-auth-form input[name="email"]', CLINICIAN_EMAIL);
  await set(tabId, 'form.wm-auth-form input[name="password"]', PASSWORD);
  await rpc("page.click", { tabId, frameId: FRAME, selector: 'form.wm-auth-form button[type="submit"]' });
  await sleep(7000);
}

await clickText(tabId, "Patients");
await sleep(3000);

await rpc("page.click", {
  tabId,
  frameId: FRAME,
  selector: "table.wm-patient-table tbody tr:nth-child(4) button.wm-btn-primary",
});
await sleep(3000);

const stamp = new Date().toISOString();

await clickText(tabId, "Vitals");
await sleep(1000);
await clickText(tabId, "Add vital", "button");
await sleep(1000);
await set(tabId, 'form.wm-popover-form input[name="type"]', "Blood pressure");
await set(tabId, 'form.wm-popover-form input[name="value"]', "118/76");
await set(tabId, 'form.wm-popover-form input[name="unit"]', "mmHg");
await rpc("page.click", { tabId, frameId: FRAME, selector: 'form.wm-popover-form button[type="submit"]' });
await sleep(3000);

await clickText(tabId, "Meds");
await sleep(1000);
await clickText(tabId, "Add med", "button");
await sleep(1000);
await set(tabId, 'form.wm-popover-form input[name="name"]', "Lisinopril");
await set(tabId, 'form.wm-popover-form input[name="dose"]', "10 mg");
await set(tabId, 'form.wm-popover-form input[name="frequency"]', "Once daily");
await set(tabId, 'form.wm-popover-form textarea[name="notes"]', `Portal med test ${stamp}`);
await rpc("page.click", { tabId, frameId: FRAME, selector: 'form.wm-popover-form button[type="submit"]' });
await sleep(3000);

await clickText(tabId, "Allergies");
await sleep(1000);
await clickText(tabId, "Add allergy", "button");
await sleep(1000);
await set(tabId, 'form.wm-popover-form input[name="substance"]', "Penicillin");
await set(tabId, 'form.wm-popover-form input[name="reaction"]', "Rash");
await set(tabId, 'form.wm-popover-form input[name="severity"]', "Moderate");
await set(tabId, 'form.wm-popover-form textarea[name="notes"]', `Portal allergy test ${stamp}`);
await rpc("page.click", { tabId, frameId: FRAME, selector: 'form.wm-popover-form button[type="submit"]' });
await sleep(3000);

body = String(await text(tabId));
console.log(body.slice(0, 4200));

console.log("\nAdded data:");
console.log(`- Patient: ${PATIENT_NAME}`);
console.log("- Vital: Blood pressure 118/76 mmHg");
console.log("- Medication: Lisinopril 10 mg, Once daily");
console.log("- Allergy: Penicillin, Rash, Moderate");

close();
