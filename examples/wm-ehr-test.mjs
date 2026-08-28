#!/usr/bin/env node
import { connect, sleep } from "../lib/client.mjs";

const EMAIL = process.env.WM_EMAIL || "sarah.chen.1787143770066@example.com";
const PASSWORD = process.env.WM_PASSWORD || "BridgeTest1234!";
const PORT = Number(process.env.BRIDGE_PORT || 9222);
const FRAME = 0;
const PORTAL_URL = "https://www.wellnessmetric.net/portal/#/";

const { rpc, close } = await connect(PORT);

async function qAll(tabId, selector, attrs = ["class", "id", "name", "type", "href"], limit = 20) {
  return rpc("page.querySelectorAll", { tabId, frameId: FRAME, selector, attrs, limit });
}

async function readText(tabId, selector) {
  return rpc("page.getText", { tabId, frameId: FRAME, selector });
}

let tabs = await rpc("tabs.list");
let tab = tabs.find((t) => /wellnessmetric\.net\/portal/i.test(t.url || ""));
if (!tab) {
  tab = await rpc("tabs.create", { url: PORTAL_URL, active: true });
  await sleep(5000);
} else {
  await rpc("tabs.activate", { tabId: tab.id });
}
const tabId = tab.id;
console.log("TAB", tabId, tab.url);

const before = await readText(tabId, "body");
console.log("BEFORE\n", String(before).slice(0, 1400));

const loginFields = await qAll(tabId, 'input[name="email"], input[name="password"], button');
console.log("LOGIN_FIELDS", JSON.stringify(loginFields, null, 2));

const needsLogin = JSON.stringify(loginFields).includes('input') && JSON.stringify(loginFields).includes('Sign in');
if (needsLogin) {
  await rpc("page.setValue", { tabId, frameId: FRAME, selector: 'form.wm-auth-form input[name="email"]', value: EMAIL });
  await rpc("page.setValue", { tabId, frameId: FRAME, selector: 'form.wm-auth-form input[name="password"]', value: PASSWORD });
  await rpc("page.click", { tabId, frameId: FRAME, selector: 'form.wm-auth-form button[type="submit"]' });
  await sleep(7000);
}

const after = await readText(tabId, "body");
console.log("AFTER_LOGIN\n", String(after).slice(0, 2200));

const sessionBits = await qAll(
  tabId,
  '#wm-consult-portal-user, #wm-consult-clinician-root, .wm-clinician-shell, .wm-clinician-nav button, .wm-patient-card, .wm-patient-row, [data-patient-id]',
  ["class", "id", "name", "type", "href", "data-patient-id"],
  50
);
console.log("SESSION_BITS", JSON.stringify(sessionBits, null, 2));

await rpc("page.clickByText", { tabId, frameId: FRAME, selector: "button, a", text: "Patients" });
await sleep(4000);

const patientText = await readText(tabId, "body");
console.log("PATIENTS\n", String(patientText).slice(0, 2600));

const patientItems = await qAll(
  tabId,
  '.wm-patient-card, .wm-patient-row, [data-patient-id], button, a',
  ["class", "id", "href", "data-patient-id"],
  80
);
console.log("PATIENT_ITEMS", JSON.stringify(patientItems, null, 2));

const wantedNames = ["Emma Wilson", "Noah Patel", "Sofia Nguyen", "Bridge TestUser"];
let opened = false;
for (const name of wantedNames) {
  try {
    await rpc("page.clickByText", { tabId, frameId: FRAME, selector: "button, a, .wm-patient-card, .wm-patient-row, [data-patient-id]", text: name }, 8000);
    opened = true;
    console.log("OPENED_PATIENT", name);
    break;
  } catch {}
}

if (!opened) {
  console.log("OPENED_PATIENT", "none");
}
await sleep(4000);

const chartText = await readText(tabId, "body");
console.log("CHART\n", String(chartText).slice(0, 3200));

close();
