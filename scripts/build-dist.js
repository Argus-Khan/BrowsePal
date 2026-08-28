#!/usr/bin/env node
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const SHARED_FILES = [
  "background.js",
  "content.js",
  "options.html",
  "options.js",
  "options.css",
  "popup.html",
  "popup.js",
];

async function build() {
  const distDir = join(root, "dist");
  if (existsSync(distDir)) await rm(distDir, { recursive: true });

  for (const browser of ["chrome", "firefox"]) {
    const dir = join(distDir, browser);
    const libDir = join(dir, "lib");
    await mkdir(libDir, { recursive: true });

    // Copy shared files
    for (const f of SHARED_FILES) {
      await cp(join(root, f), join(dir, f));
    }

    // Copy lib/ directory
    await cp(join(root, "lib"), libDir, { recursive: true, force: true });

    // Write browser-specific manifest
    const manifestSrc = browser === "chrome" ? "manifest.json" : "manifest-firefox.json";
    const manifest = await import(join(root, manifestSrc), { with: { type: "json" } });
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest.default, null, 2));
  }

  console.log("Built dist/chrome/ and dist/firefox/");
}

build().catch((e) => { console.error(e); process.exit(1); });
