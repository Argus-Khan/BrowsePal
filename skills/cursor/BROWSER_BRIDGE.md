# Browser Agent Bridge — Cursor Agent Rules

Use these rules when Cursor Agent needs to control the browser through the Browser Agent Bridge extension.

For the full reference, see `skills/browser-bridge/SKILL.md` (or `README.md` → Protocol).

## How to run browser tasks

Start the toolkit with a JSON task file:

```bash
node examples/agent-tools.mjs <task-file>.json
```

## Standard toolkit actions

```json
[
  { "action": "goto", "url": "https://example.com" },
  { "action": "wait", "selector": "h1", "timeoutMs": 10000 },
  { "action": "read", "selector": "article" },
  { "action": "click", "selector": "button#submit" },
  { "action": "type", "selector": "input#email", "text": "user@example.com" },
  { "action": "screenshot" }
]
```

## Action reference

`goto`, `read`, `find`, `click`, `clickByText`, `type`, `pressKey`, `submit`, `wait`, `screenshot`, `scroll`, `tabs`, `active`, `findTab`, `consoleLog`, `consoleClear`, `perfMetrics`, `perfResources`, `sleep`, `eval`

## Guidelines

- Prefer `type`/`click` over `eval` on CSP-restricted sites.
- Use `wait` before reading dynamic content.
- Save important outputs with `"saveAs": "key"`.
- Chrome users: `debugger` is granted at install (required in MV3); network tools work out of the box.
- Firefox users: `net.*` CDP methods are unavailable — use `agent.passiveLog` for a request list (status/timing, no bodies).
