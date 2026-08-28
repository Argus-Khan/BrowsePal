import { connect } from "../lib/client.mjs";

const { rpc, close } = await connect(9222);

const tabs = await rpc("tabs.list");
console.log("TABS", JSON.stringify(tabs, null, 2));

const portal = (tabs || []).find((t) => /wellnessmetric\.net\/portal/i.test(t.url || ""));
const live = (tabs || []).find((t) => /wellnessmetric\.net/i.test(t.url || ""));
console.log("PORTAL_TAB", portal || live || null);

const tabId = (portal || live)?.id;
if (!tabId) {
  console.log("NO_LIVE_TAB");
  close();
  process.exit(0);
}

await rpc("tabs.activate", { tabId });

const text = await rpc("page.getText", { tabId });
console.log("\nPAGE_TEXT_START\n", String(text || "").slice(0, 4000), "\nPAGE_TEXT_END\n");

try {
  const shot = await rpc("page.screenshot", { tabId, format: "png" });
  if (shot && typeof shot === "string") {
    const { writeFileSync } = await import("node:fs");
    const b64 = shot.includes(",") ? shot.split(",").pop() : shot;
    writeFileSync("/tmp/wm-portal.png", Buffer.from(b64, "base64"));
    console.log("SCREENSHOT /tmp/wm-portal.png", Buffer.from(b64, "base64").length);
  } else if (shot && shot.data) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync("/tmp/wm-portal.png", Buffer.from(shot.data, "base64"));
    console.log("SCREENSHOT /tmp/wm-portal.png bytes", Buffer.from(shot.data, "base64").length);
  } else {
    console.log("SCREENSHOT_SHAPE", typeof shot, Object.keys(shot || {}));
  }
} catch (e) {
  console.log("SCREENSHOT_ERR", e.message);
}

const probe = await rpc("page.eval", {
  tabId,
  code: `(() => {
    const cfg = window.WM_CONSULT || window.WM_CONSULT_BOOKING || null;
    const scripts = [...document.querySelectorAll('script[src*="clinician"],script[src*="booking"]')].map(s => s.src);
    const status = document.querySelector('.wm-status')?.textContent || '';
    const who = document.querySelector('#wm-consult-portal-user, .wm-portal-header')?.innerText || '';
    return {
      href: location.href,
      title: document.title,
      cfg,
      scripts,
      status,
      who,
      bodyClass: document.body.className,
      hasRoot: !!document.querySelector('#wm-consult-clinician-root, #wm-consult-booking-root'),
    };
  })()`,
});
console.log("\nPROBE", JSON.stringify(probe, null, 2));

close();
