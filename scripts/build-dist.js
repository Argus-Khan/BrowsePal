#!/usr/bin/env node
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import manifestChrome from "../manifest.json" with { type: "json" };
import manifestFirefox from "../manifest-firefox.json" with { type: "json" };

const files = [
  "background.js",
  "content.js",
  "options.html",
  "options.js",
  "options.css",
  "popup.html",
  "popup.js",
];

async function build() {
  if (existsSync("dist")) await rm("dist", { recursive: true });

  await mkdir("dist/chrome", { recursive: true });
  await mkdir("dist/firefox", { recursive: true });
  await mkdir("dist/chrome/lib", { recursive: true });
  await mkdir("dist/firefox/lib", { recursive: true });

  for (const f of files) {
    await cp(f, `dist/chrome/${f}`);
    await cp(f, `dist/firefox/${f}`);
  }

  await cp("lib/", "dist/chrome/lib/", { recursive: true, force: true });
  await cp("lib/", "dist/firefox/lib/", { recursive: true, force: true });

  await writeFile("dist/chrome/manifest.json", JSON.stringify(manifestChrome, null, 2));
  await writeFile("dist/firefox/manifest.json", JSON.stringify(manifestFirefox, null, 2));

  console.log("Built dist/chrome/ and dist/firefox/");
}

build().catch((e) => { console.error(e); process.exit(1); });
