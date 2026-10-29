# Browser Agent Bridge — Claude Code Instructions

Use these instructions to control the browser through the Browser Agent Bridge extension from Claude Code.

For the full reference, see `skills/browser-bridge/SKILL.md` (or `README.md` → Protocol).

## Setup

1. Install the Browser Agent Bridge extension in Chrome or Firefox.
2. Ensure the extension is connected to `ws://127.0.0.1:9222`.

## Running browser tasks

Use the JSON task runner:

```bash
node examples/agent-tools.mjs <task-file>.json
```

Example `task.json`:

```json
[
  { "action": "goto", "url": "https://example.com" },
  { "action": "wait", "selector": "h1" },
  { "action": "read", "selector": "article" },
  { "action": "screenshot" }
]
```

## Standard actions

`goto`, `read`, `find`, `click`, `clickByText`, `type`, `pressKey`, `submit`, `wait`, `screenshot`, `scroll`, `tabs`, `active`, `findTab`, `consoleLog`, `consoleClear`, `perfMetrics`, `perfResources`, `sleep`, `eval`

## Tips

- Use `type` and `click` instead of `eval` on CSP-restricted sites (Gemini, ChatGPT, banking).
- Save results with `"saveAs": "name"` to capture them for later steps.
- On Chrome the `debugger` permission is granted at install (MV3 makes it required), so network tools work out of the box.
- Firefox does not support `net.*` CDP methods — use `agent.passiveLog` for a request list (status/timing, no bodies).
