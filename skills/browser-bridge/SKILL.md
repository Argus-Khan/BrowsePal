---
name: browser-bridge
description: Browser automation via the Browser Agent Bridge extension. Use for reading pages, clicking, typing, screenshots, and tab management across any website.
---

# Browser Agent Bridge Skill

This skill lets you control the user's browser through the Browser Agent Bridge extension.

For the full reference, see `.opencode/skills/browser-bridge/SKILL.md`.

## Quick start

1. Install the Browser Agent Bridge extension in Chrome or Firefox.
2. Start the agent toolkit:
   ```bash
   node examples/agent-tools.mjs examples/read-page.json
   ```

## Toolkit actions

Write a JSON task file with actions like:

```json
[
  { "action": "goto", "url": "https://example.com" },
  { "action": "wait", "selector": "h1" },
  { "action": "read", "selector": "article" },
  { "action": "click", "selector": "button#accept" },
  { "action": "type", "selector": "input#search", "text": "hello" },
  { "action": "screenshot" }
]
```

Run it:
```bash
node examples/agent-tools.mjs task.json
```

## Available actions

`goto`, `read`, `find`, `click`, `type`, `pressKey`, `submit`, `wait`, `screenshot`, `scroll`, `tabs`, `active`, `findTab`, `sleep`, `eval`

## Notes

- Firefox: `net.*` CDP methods are unavailable.
- Chrome: grant `debugger` permission for `net.*` network tools.
- Prefer `type`/`click` over `eval` on CSP-restricted sites.
