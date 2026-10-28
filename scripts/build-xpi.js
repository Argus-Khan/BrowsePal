#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const distFirefox = join(root, "dist", "firefox");
const xpiPath = join(root, "dist", "browser-agent-bridge.xpi");

// Build first if dist/firefox doesn't exist
if (!existsSync(distFirefox)) {
  console.log("Building dist/ first...");
  execSync("npm run build", { cwd: root, stdio: "inherit" });
}

// Create XPI (ZIP with .xpi extension)
console.log("Creating XPI file...");
execSync(`cd "${distFirefox}" && zip -r "${xpiPath}" .`, { stdio: "inherit" });

console.log(`\nXPI created at: ${xpiPath}`);
console.log("\nTo install in Firefox:");
console.log("1. Open Firefox and go to about:debugging#/runtime/this-firefox");
console.log("2. Click 'Load Temporary Add-on...'");
console.log("3. Select the XPI file from: dist/browser-agent-bridge.xpi");
