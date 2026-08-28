# Browser Agent Bridge — Cursor Agent Rules

Use these rules when Cursor Agent needs to control the browser through the Browser Agent Bridge extension.

For the full reference, see `.opencode/skills/browser-bridge/SKILL.md`.

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

`goto`, `read`, `find`, `click`, `type`, `pressKey`, `submit`, `wait`, `screenshot`, `scroll`, `tabs`, `active`, `findTab`, `sleep`, `eval`

## Guidelines

- Prefer `type`/`click` over `eval` on CSP-restricted sites.
- Use `wait` before reading dynamic content.
- Save important outputs with `"saveAs": "key"`.
- Chrome users: grant `debugger` permission for network tools.
- Firefox users: `net.*` CDP methods are unavailable.
