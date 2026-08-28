# Commands
- **Development (Chrome):** Load unpacked at `chrome://extensions`, point at the project root (uses `manifest.json`).
- **Development (Firefox):** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → pick `manifest-firefox.json`.
- **Build for distribution:** `npm run build` → creates `dist/chrome/` and `dist/firefox/`.
- **Try the demo server:** `npm install` then `node examples/agent-server.js`.
- There is no linter or test harness configured for this project.
