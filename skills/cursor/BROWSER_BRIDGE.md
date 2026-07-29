# Browser Agent Bridge — Cursor Agent Rules

Use these rules when Cursor Agent needs to control the browser through the Browser Agent Bridge extension.

## How to run browser tasks

Start the toolkit with a JSON task file:

```bash
node examples/agent-tools.mjs <task-file>.json
```

The toolkit connects to the Browser Agent Bridge extension over WebSocket and executes standard actions.

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

- `goto` — navigate to URL
- `read` — read text from page/selector
- `find` — find elements by selector or text
- `click` — click element
- `type` — type/set value
- `pressKey` — press a key
- `submit` — submit a form
- `wait` — wait for element
- `screenshot` — take screenshot
- `scroll` — scroll page/element
- `tabs` — list tabs
- `active` — get active tab
- `sleep` — pause
- `eval` — run JS (may fail on CSP sites)

## Guidelines

- Prefer `type`/`click` over `eval` on CSP-restricted sites.
- Use `wait` before reading dynamic content.
- Save important outputs with `"saveAs": "key"`.
- Chrome users: grant `debugger` permission for network tools.
- Firefox users: `net.*` CDP methods are unavailable.
