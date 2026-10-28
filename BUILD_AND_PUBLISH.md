# Build & Publish Guide — Browser Agent Bridge

Personal reference for shipping the Browser Agent Bridge extension and toolkit.

---

## 1. What you are shipping

Two separate artifacts:

1. **Browser extension** — runs inside Chrome or Firefox, connects out to a local WebSocket.
2. **npm toolkit** — `browser-agent-tools` CLI that runs the WebSocket server and executes JSON task files.

The extension ships in two formats:
- `dist/chrome/` — for Chrome Web Store (unpacked zip works too).
- `dist/firefox/` — for Firefox Add-ons / temporary install.

---

## 2. Prerequisites

Before publishing, make sure you have:

- [ ] Google account with Chrome Web Store Developer access ($5 one-time fee).
- [ ] Firefox Add-ons account at [addons.mozilla.org](https://addons.mozilla.org).
- [ ] npm account, logged in locally (`npm login`).
- [ ] `node` and `npm` installed.
- [ ] Git repo pushed to GitHub (optional but recommended for source-code review).

---

## 3. Clean the working tree

Before a release, make sure there are no stale test files or temporary scripts in the repo.

Files to keep:
- `manifest.json`, `manifest-firefox.json`
- `background.js`, `content.js`
- `options.html`, `options.js`, `options.css`
- `popup.html`, `popup.js`
- `lib/` (includes `defaults.js`, `esc.js`, `client.mjs`, and other shared modules)
- `examples/agent-tools.mjs`, `examples/agent-server.js`, `examples/*.json`
- `scripts/build-dist.js`
- `README.md`, `CONTEXT.md`, `AGENTS.md`
- `.opencode/`, `skills/`
- `package.json`, `package-lock.json`

Files you can delete or move out before publishing:
- `test-bridge.mjs` (optional test harness)
- `inspect-*.mjs`, `find-*.mjs`, `read-tab.mjs`, `ask-gemini.mjs` (your one-off scripts)
- `node_modules/`

Do not ship `node_modules/` in the extension zip or in git. It is already `.gitignore`d.

---

## 4. Update the version

Bump the version in BOTH places:

1. `package.json` — version of the npm toolkit.
2. `manifest.json` and `manifest-firefox.json` — version of the extension.

Keep them in sync. Use [SemVer](https://semver.org/):

```json
{
  "manifest_version": 3,
  "version": "0.2.0"
}
```

```json
{
  "name": "browser-agent-tools",
  "version": "0.2.0"
}
```

---

## 5. Build the distribution folders

```bash
npm install
npm run build
```

This creates:

```
dist/
  chrome/
    manifest.json
    background.js
    content.js
    options.html
    options.js
    options.css
    lib/
  firefox/
    manifest.json
    background.js
    content.js
    options.html
    options.js
    options.css
    lib/
```

Verify the manifests are valid:

```bash
node -e "JSON.parse(require('fs').readFileSync('dist/chrome/manifest.json')); console.log('chrome ok')"
node -e "JSON.parse(require('fs').readFileSync('dist/firefox/manifest.json')); console.log('firefox ok')"
```

---

## 6. Test locally before publishing

### Chrome

1. Go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `dist/chrome/`.
5. Open the extension options, set URL to `ws://localhost:9222`.
6. Click **Grant debugger (CDP) permission** if you want `net.*` features.
7. Run:
   ```bash
   npm run tools examples/list-tabs.json
   ```

### Firefox

1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `dist/firefox/manifest.json`.
4. Open the extension options, set URL to `ws://localhost:9222`.
5. Run:
   ```bash
   npm run tools examples/list-tabs.json
   ```

### Test results you should see

- Extension connects to `ws://localhost:9222`.
- `tabs.list` returns your open tabs.
- `agent.status` shows `connected: true`.

---

## 7. Publish to npm

The npm package ships the toolkit and the extension folders.

```bash
npm run build
npm publish
```

If you want to test the package first without publishing:

```bash
npm pack
```

This creates a `.tgz` file you can inspect.

After publishing, verify:

```bash
npm info browser-agent-tools
```

### What users install

```bash
npm install -g browser-agent-tools
browser-agent-tools examples/list-tabs.json
```

They still need to load the extension manually from:
- Chrome: `node_modules/browser-agent-tools/dist/chrome/`
- Firefox: `node_modules/browser-agent-tools/dist/firefox/manifest.json`

---

## 8. Publish to Chrome Web Store

### 8.1 Create the zip

```bash
cd dist/chrome
zip -r ../../browser-agent-bridge-chrome.zip .
cd ../..
```

### 8.2 Upload

1. Go to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Click **New item**.
3. Upload `browser-agent-bridge-chrome.zip`.
4. Fill in:
   - **Description**: copy from README.md.
   - **Category**: Developer Tools.
   - **Privacy practices**: explain why each permission is needed (see README permissions table).
   - **Distribution**: Public or Unlisted.
   - **Screenshots**: optional.
5. Submit for review.

### 8.3 Chrome Web Store review notes

Include this in the review notes:

> This extension is a developer tool that exposes browser capabilities to a local AI agent over a WebSocket bound to localhost. All permissions are used exactly as described in the extension description. The debugger permission is optional and only requested at runtime via the options page for users who need CDP network features.

Review usually takes 1–3 days.

---

## 9. Publish to Firefox Add-ons

### 9.1 Prepare the source

Firefox requires source code for review if the extension is minified or generated. You are not minifying, so you can submit the extension directly.

```bash
cd dist/firefox
zip -r ../../browser-agent-bridge-firefox.zip .
cd ../..
```

### 9.2 Upload

1. Go to [Firefox Add-ons Developer Hub](https://addons.mozilla.org/developers/).
2. Click **Submit a New Add-on**.
3. Choose **On this site**.
4. Upload `browser-agent-bridge-firefox.zip`.
5. When asked if source code is needed, choose **No** if you are submitting exactly the built files.
6. Fill in the listing:
   - Name, description, summary.
   - Categories: Developer Tools, Search Tools.
   - License: MIT.
   - Privacy policy: link to your repo or a short page.
7. Submit.

### 9.3 Firefox review notes

Include this:

> This extension connects to a local WebSocket server (ws://localhost:9222) so an external AI agent can read and manipulate the browser. The extension does not collect or transmit data to any remote server. The `debugger` permission is not included in the Firefox manifest because Firefox does not support the chrome.debugger API; CDP features are unavailable on Firefox by design.

Firefox review can take a few days to a week.

---

## 10. Versioning workflow

For every release:

1. Update `manifest.json` and `manifest-firefox.json` version.
2. Update `package.json` version to match.
3. Run `npm install` to update `package-lock.json` if dependencies changed.
4. Run `npm run build`.
5. Test `dist/chrome/` and `dist/firefox/` locally.
6. `npm publish`.
7. Upload `dist/chrome/` zip to Chrome Web Store.
8. Upload `dist/firefox/` zip to Firefox Add-ons.
9. Tag the release:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

---

## 11. After publishing

### Update the README

After the extension is live in stores, update the README install section with store links:

```markdown
### Install from stores

- [Chrome Web Store](https://chrome.google.com/webstore/detail/YOUR_ID)
- [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/YOUR_SLUG)

### Install the agent toolkit

```bash
npm install -g browser-agent-tools
```
```

### Update skills

If you change the toolkit actions or protocol, update **every** copy of the skill
— they must stay byte-identical (drift between copies is how they got stale):

- `skills/browser-bridge/SKILL.md` — canonical, lives in this repo
- `~/.config/opencode/skills/browser-bridge/SKILL.md` — what opencode actually loads (symlink into the dots repo)
- `~/.config/ocv/skills/browser-bridge/SKILL.md` — same content, second config

Then update the tool-specific wrappers to reference it:
- `.opencode/agent/browser-agent.md`
- `skills/claude-code/BROWSER_BRIDGE.md`
- `skills/cursor/BROWSER_BRIDGE.md`

`npm run check` fails when the canonical reference goes stale, when a protocol
method is added without documentation, or when the copies drift apart.

These skills live in the repo, so they update automatically when users pull.

---

## 12. Common issues

### Chrome: `debugger` permission

If `net.*` methods fail, the user did not grant the debugger permission. They must:
1. Open the extension options.
2. Click **Grant debugger (CDP) permission**.

### Firefox: temporary add-on resets on restart

Firefox temporary add-ons are removed when the browser closes. For a persistent install, the extension must be signed and installed from Firefox Add-ons.

### Extension does not connect

1. Check that the WebSocket URL in options matches the toolkit server.
2. Check the background page console for `[bridge]` logs.
3. Make sure the server is running (`npm run tools ...` or `npm start`).

### CSP blocks eval on some sites

Do not use `page.eval` on CSP-restricted sites like Gemini, ChatGPT, or banking sites. Use `type`, `click`, `read`, `wait`, and other toolkit actions instead.

---

## 13. Checklist before every release

- [ ] Version bumped in `manifest.json`, `manifest-firefox.json`, `package.json`.
- [ ] `npm install` ran.
- [ ] `npm run build` succeeded.
- [ ] `dist/chrome/manifest.json` and `dist/firefox/manifest.json` valid.
- [ ] Chrome local test passed.
- [ ] Firefox local test passed.
- [ ] `npm pack` inspected.
- [ ] `npm publish` succeeded.
- [ ] Chrome Web Store zip uploaded.
- [ ] Firefox Add-ons zip uploaded.
- [ ] Git tag pushed.
- [ ] README updated with store links.

---

## 14. One-liner smoke test

After installing, run this to confirm everything works:

```bash
browser-agent-tools examples/list-tabs.json
```

You should see a list of your open tabs.
