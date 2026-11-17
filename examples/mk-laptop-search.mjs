// MK laptop search: RTX 2060+ (or comparable AMD, no xx50) <= 800 EUR in North
// Macedonia, posted 2026-10-01 or later. Drives Firefox via the BrowsePal relay
// (PORT env, default 9223).
// URL contracts (verified 2026-11-17):
//   Reklama5: /Search?q=<term>&cat=582&page=N   (53 ads/page, price in MKD or EUR)
//   Pazar3:   /oglasi/elektronika/kompjuteri-komplet/laptopi-notebook/prodazba/q-<term>?Search=<term>&Page=N
//             (50 ads/page, JSON-LD ItemList with price/priceCurrency/url)
import WebSocket from "ws";

const PORT = Number(process.env.PORT || 9223);
const MKD_PER_EUR = 61.5045;
const MAX_PAGES = 8; // safety cap per search

function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  let id = 1;
  const pending = new Map();
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject, t } = pending.get(msg.id);
      clearTimeout(t);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const rpc = (method, params = {}, timeoutMs = 45000) =>
    new Promise((resolve, reject) => {
      const my = id++;
      const t = setTimeout(() => {
        pending.delete(my);
        reject(new Error(`timeout ${method}`));
      }, timeoutMs);
      pending.set(my, { resolve, reject, t });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }));
    });
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve({ ws, rpc }));
    ws.on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function stripTags(s) { return decodeEntities(s.replace(/<[^>]*>/g, " ")); }

// ── parsers ────────────────────────────────────────────────────────────────

function parseR5(html) {
  const ads = [];
  const parts = html.split('<h3><a href="/AdDetails');
  for (const chunk of parts.slice(1)) {
    const m = /\?ad=(\d+)" class="SearchAdTitle">([\s\S]*?)<\/a>/.exec(chunk);
    if (!m) continue;
    const desc = /class="searchAdDesc">([\s\S]*?)<\/p>/.exec(chunk);
    const price = /class="search-ad-price">\s*([\d.,]+)\s*([^\s<]*)/.exec(chunk);
    const city = /class="city-span"[\s\S]*?<\/i>([\s\S]*?)<\/span>/.exec(chunk);
    const cur = price ? price[2] : "";
    const raw = price ? Number(price[1].replace(/\./g, "").replace(",", ".")) : 0;
    let eur = 0, curTag = cur;
    if (raw) {
      if (/МКД|MKD|ден/i.test(cur) || !/€|EUR/i.test(cur)) { eur = raw / MKD_PER_EUR; curTag = cur || "MKD"; }
      else { eur = raw; curTag = "EUR"; }
    }
    ads.push({
      site: "reklama5",
      id: m[1],
      title: stripTags(m[2]),
      desc: desc ? stripTags(desc[1]) : "",
      priceEur: eur,
      currency: curTag,
      location: city ? stripTags(city[1]) : "",
      url: `https://www.reklama5.mk/AdDetails?ad=${m[1]}`,
    });
  }
  return ads;
}

function parseP3(html) {
  const ads = [];
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) return ads;
  let graph;
  try { graph = JSON.parse(m[1])["@graph"]; } catch { return ads; }
  for (const node of graph || []) {
    if (node["@type"] !== "ItemList") continue;
    for (const li of node.itemListElement || []) {
      const p = li.item || {};
      const o = p.offers || {};
      const price = Number(o.price) || 0;
      const cur = o.priceCurrency || "";
      const eur = !price ? 0 : cur === "MKD" ? price / MKD_PER_EUR : price;
      const loc = /\/prodazba\/([^/]+)\/([^/]+)\//.exec(p.url || "");
      // media.pazar3.mk/Image/<uuid>/<YYYYMMDD>/… — image upload date, used as
      // a free "definitely old" signal so old ads skip their detail fetch.
      const im = Array.isArray(p.image) ? p.image[0] : p.image;
      const md = im && /\/Image\/[^/]+\/(\d{4})(\d{2})(\d{2})\//.exec(im);
      ads.push({
        site: "pazar3",
        id: (p.url || "").split("/").pop(),
        title: p.name || "",
        desc: "",
        priceEur: eur,
        currency: cur,
        imgDate: md ? `${md[1]}-${md[2]}-${md[3]}` : null,
        location: loc ? `${loc[1]}, ${loc[2]}` : "",
        url: p.url || "",
      });
    }
  }
  return ads;
}

// ── GPU + laptop classification ────────────────────────────────────────────

function gpuInfo(text) {
  const t = text.toUpperCase();
  let m = /RTX[\s\-–]*([0-9]{4})/.exec(t);
  if (m) {
    const n = Number(m[1]);
    const last = n % 100;
    const series = Math.floor(n / 100);
    if (series >= 20 && last >= 60) return { ok: true, gpu: `RTX ${n}` };
    return { ok: false, gpu: `RTX ${n}`, why: "xx50-tier or below 2060" };
  }
  m = /RX[\s\-–]*([0-9]{4})M?/.exec(t);
  if (m) {
    const n = Number(m[1]);
    const series = Math.floor(n / 1000);
    const min = series === 5 ? 5600 : series === 6 ? 6600 : series === 7 ? 7600 : series === 8 ? 8600 : 0;
    if (min && n >= min) return { ok: true, gpu: `RX ${n}` };
    if (min) return { ok: false, gpu: `RX ${n}`, why: "below 6600-class" };
    return { ok: false, gpu: `RX ${n}`, why: "unsupported series" };
  }
  if (/GTX[\s\-–]*[0-9]{4}/.test(t)) return { ok: false, gpu: (t.match(/GTX[\s\-–]*[0-9]{4}/) || [])[0], why: "GTX, below RTX 2060 class" };
  return { ok: false, gpu: "", why: "no GPU in listing text" };
}

function isLaptopAd(title) {
  return !/\b(DESKTOP|MONITOR|GRAFI[CK]A|KONFIGURACIJ|CASE|POWER SUPPLY|TASTATURA|MIŠ|MOUSE|SSD|RAM)\b/i.test(title);
}

// ── publish dates ──────────────────────────────────────────────────────────
// Neither site dates its listing cards — both date only detail pages:
//   Reklama5: <span><small>08.05.2024 14:32</small></span>  (dd.MM.yyyy)
//   Pazar3:   <bdi class="published-date">септ. 29 2026</bdi> (mk month abbr)
const MK_MONTH = {
  "јан": 1, "јануари": 1, "фев": 2, "февруари": 2, "мар": 3, "март": 3,
  "апр": 4, "април": 4, "мај": 5, "јун": 6, "јуни": 6, "јул": 7, "јули": 7,
  "авг": 8, "август": 8, "септ": 9, "септември": 9, "окт": 10, "октомври": 10,
  "ноем": 11, "ноември": 11, "дек": 12, "декември": 12,
};

function detailDate(site, html) {
  if (site === "reklama5") {
    const m = /<small>(\d{2})\.(\d{2})\.(\d{4})(?: \d{2}:\d{2})?<\/small>/.exec(html);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  }
  const m = /class="published-date">([^<]+)</.exec(html);
  if (!m) return null;
  const p = m[1].trim().split(/\s+/); // "септ. 29 2026"
  const mo = MK_MONTH[(p[0] || "").replace(/\.$/, "").toLowerCase()];
  return mo && p[1] && p[2]
    ? `${p[2]}-${String(mo).padStart(2, "0")}-${String(p[1]).padStart(2, "0")}`
    : null;
}

// ── driver ─────────────────────────────────────────────────────────────────

const R5 = "https://www.reklama5.mk/Search?cat=582&q=";
const P3 = "https://www.pazar3.mk/oglasi/elektronika/kompjuteri-komplet/laptopi-notebook/prodazba/q-";
const SEARCHES = [
  { url: (t) => `${R5}${t}`, page: (u, n) => `${u}&page=${n}`, parse: parseR5 },
  { url: (t) => `${P3}${t}?Search=${t}`, page: (u, n) => `${u}&Page=${n}`, parse: parseP3 },
];
const TERMS = ["rtx", "gaming", "rx", "radeon"];

// ── start: join Firefox's room as an AGENT, never as the bridge ─────────────
// A plain `/` connect to an EMPTY room claims the bridge slot (legacy
// behavior in lib/server.js) — that would squat Firefox's port, block it,
// and mute our own requests. So discover a LIVE Firefox bridge from the
// relay log first, then confirm from the log that we joined as an agent.
const fs = await import("node:fs");
const RELAY_LOG = process.env.RELAY_LOG || "";

function readLog() { try { return fs.readFileSync(RELAY_LOG, "utf8"); } catch { return ""; } }

function liveFirefoxPort() {
  if (!RELAY_LOG) return PORT;
  const log = readLog();
  const lines = log.split("\n").filter((l) => l.includes("identified: Firefox on port"));
  if (!lines.length) return null;
  const last = lines[lines.length - 1];
  const port = Number(/port (\d+)/.exec(last)[1]);
  const after = log.slice(log.lastIndexOf(last) + last.length);
  if (after.includes(`extension disconnected from port ${port}`)) return null;
  return port;
}

let session = null;
for (let attempt = 0; attempt < 30 && !session; attempt++) {
  const port = liveFirefoxPort();
  if (port == null) { console.log(`wait ${attempt}: no live Firefox bridge`); await sleep(5000); continue; }
  const t0 = new Date().toISOString();
  const s = await connect(port);
  await sleep(1200); // let the relay log the join
  const tail = readLog();
  const mine = tail.split("\n").filter((l) => l.includes(`on port ${port}`) && l >= t0);
  if (mine.some((l) => l.includes("extension connected"))) {
    console.log(`lost race: squatted empty room ${port}, backing off`);
    try { s.ws.close(); } catch {}
    await sleep(4000);
    continue;
  }
  if (mine.some((l) => l.includes("agent connected"))) {
    session = s;
    console.log(`joined port ${port} as agent`);
  } else {
    console.log(`join unverified (attempt ${attempt}, t0=${t0}, log lines seen: ${mine.length}, log bytes: ${tail.length})`);
    s.ws.close();
    await sleep(2000);
  }
}
if (!session) { console.error("could not join a live Firefox bridge"); process.exit(1); }

const { ws, rpc } = session;

// Firefox's MV3 background is an event page: idle ~30s → suspended → socket
// closed with 1001, alarm reconnect ~90s later. Constant traffic keeps it up.
let pingBusy = false;
const keepalive = setInterval(() => {
  if (pingBusy) return;
  pingBusy = true;
  rpc("agent.status", {}, 8000).catch(() => {}).finally(() => { pingBusy = false; });
}, 5000);

async function retry(fn, tries, gapMs, label) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { err = e; console.log(`${label} retry ${i}: ${e.message}`); await sleep(gapMs); }
  }
  throw err;
}

await retry(() => rpc("agent.status", {}, 8000), 12, 5000, "status");
console.log("status OK");

const tab = await retry(() => rpc("tabs.create", { url: "https://www.reklama5.mk/", active: false }, 15000), 4, 4000, "tabs.create");
const tabId = tab.id ?? tab.tabId ?? tab;
console.log("tab", tabId);
await sleep(4000);

// page.eval without frameId is broadcast to every frame and the first
// responder wins — sub-frames (R5's header <embed>s, Pazar3's GSI iframe)
// routinely beat the top frame, which is what looked like "tab hijacking".
// Pin all reads to the tab's top frame explicitly.
let FRAME = null;
try {
  const frames = await rpc("page.frames", { tabId }, 15000);
  const top = (frames || []).find((f) => f.parentFrameId === -1);
  FRAME = top ? top.frameId : null; // null → fall back to broadcast
} catch (e) { console.log("page.frames failed:", e.message); }
console.log("top frame", FRAME);
const ev = (code) =>
  rpc("page.eval", FRAME == null ? { tabId, code } : { tabId, frameId: FRAME, code }, 15000);

async function fetchHtml(url) {
  let err;
  for (let i = 0; i < 10; i++) {
    try {
      const prev = await ev("location.href").catch(() => "");
      await rpc("page.navigate", { tabId, url }, 15000);
      // Adaptive wait with commit detection: until the new navigation commits,
      // evals still answer from the PREVIOUS document — poll until location
      // changes (or already equals the target), then until DOMContentLoaded.
      const t0 = Date.now();
      for (;;) {
        await sleep(400);
        try {
          const l = await ev("location.href");
          if ((l === url || l !== prev) && (await ev("document.readyState")) !== "loading") break;
        } catch { /* navigating / content script not injected yet */ }
        if (Date.now() - t0 > 6000) break;
      }
      // Sanity check we're on the requested URL before extracting.
      const loc = await ev("location.href");
      if (loc !== url) { err = new Error(`wrong document → ${loc}`); console.log(`  fetch try ${i}: ${err.message}`); await sleep(2000); continue; }
      const html = await ev("document.documentElement.outerHTML");
      if (html && html.length > 5000) return html;
      err = new Error("short html " + (html || "").length);
      console.log(`  fetch try ${i}: ${err.message}`);
    } catch (e) { err = e; console.log(`  fetch try ${i}: ${e.message}`); }
    await sleep(3000);
  }
  throw err;
}

const all = [];
const seen = new Set();
for (const site of SEARCHES) {
  for (const term of TERMS) {
    const base = site.url(term);
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = site.page(base, page);
      let ads;
      try {
        const html = await fetchHtml(url);
        ads = site.parse(html);
      } catch (e) {
        console.log("FAIL", url, "->", e.message);
        break;
      }
      console.log(`${url} -> ${ads.length} ads`);
      if (!ads.length) break; // last page reached
      let fresh = 0;
      for (const a of ads) {
        const key = a.url || a.id;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(a);
        fresh++;
      }
      if (!fresh) break; // no new ads → no further pages
    }
  }
}
console.log(`\ncollected ${all.length} unique ads`);

// ── filter + report ────────────────────────────────────────────────────────

const MIN_DATE = "2026-10-01"; // "older than oct" → drop ads posted before this

// Phase 1: listing-level filters. GPU from the listing when it names one;
// every survivor then needs ONE detail fetch for the publish date (and for
// the GPU when the listing never named it).
const candidates = [];
for (const a of all) {
  if (!isLaptopAd(a.title)) { a.rej = "laptop"; continue; }
  if (!a.priceEur) { a.rej = "noprice"; continue; }
  if (a.priceEur > 800) { a.rej = "price"; continue; }
  const g = gpuInfo(`${a.title} ${a.desc}`);
  if (g.ok) a.gpu = g.gpu;
  candidates.push(a);
}

console.log(`detail-checking ${candidates.length} price-qualifying ads (date + GPU)…`);
let checked = 0, skippedOld = 0;
for (const a of candidates) {
  if (checked++ >= 500) break;
  // Pazar3's image URL carries the upload date — a free "definitely old"
  // signal from the listing. Skip the detail fetch for those (a brand-new ad
  // reusing a photo uploaded before Oct would be skipped too — rare, accepted).
  if (a.imgDate && a.imgDate < MIN_DATE) { a.date = a.imgDate; skippedOld++; continue; }
  if (checked % 10 === 0) console.log(`  detail ${checked}/${candidates.length}`);
  try {
    const html = await fetchHtml(a.url);
    a.date = detailDate(a.site, html);
    if (!a.gpu) {
      const g = gpuInfo(`${a.title} ${a.desc} ${stripTags(html)}`);
      if (g.ok) a.gpu = g.gpu;
    }
  } catch (e) { console.log(`  detail fail: ${e.message}`); }
}

// Phase 2: recency first (known-old ads are dropped regardless of GPU), then
// GPU. Ads whose date could not be parsed are kept but flagged "?" rather
// than guessed out.
const kept = [];
for (const a of candidates) {
  if (a.date && a.date < MIN_DATE) { a.rej = "date"; continue; }
  if (!a.gpu) { a.rej = "gpu"; continue; }
  a.rej = null;
  kept.push(a);
}
kept.sort((x, y) => x.priceEur - y.priceEur);

const summary = { price: 0, noprice: 0, gpu: 0, laptop: 0, date: 0 };
for (const a of all) if (a.rej) summary[a.rej]++;
const lines = [];
lines.push(`MATCHES: ${kept.length}  (scanned ${all.length} unique ads, posted on/after ${MIN_DATE}; ${skippedOld} old Pazar3 ads skipped via image date)`);
lines.push(`rejected: >800€ ${summary.price} | no/negotiable price ${summary.noprice} | GPU not qualifying ${summary.gpu} | older than ${MIN_DATE} ${summary.date} | not a laptop ${summary.laptop}\n`);
kept.forEach((a, i) => {
  lines.push(
    `${String(i + 1).padStart(2)}. ${a.title}\n` +
    `    ${a.priceEur.toFixed(0)} EUR (${a.currency}) | GPU: ${a.gpu} | ${a.date || "?"} | ${a.location} | ${a.site}\n` +
    `    ${a.url}`
  );
});
const out = lines.join("\n");
console.log(out);
fs.writeFileSync("/tmp/opencode/mk-laptop-results.txt", out + "\n");
clearInterval(keepalive);
ws.close();
