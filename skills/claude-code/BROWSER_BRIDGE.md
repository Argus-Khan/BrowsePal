# Browser Agent Bridge — Claude Code Instructions

Use these instructions to control the browser through the Browser Agent Bridge extension from Claude Code.

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

- `goto`, `read`, `find`, `click`, `type`, `pressKey`, `submit`
- `wait`, `screenshot`, `scroll`, `tabs`, `active`, `sleep`, `eval`

## Tips

- Use `type` and `click` instead of `eval` on CSP-restricted sites (Gemini, ChatGPT, banking).
- Save results with `"saveAs": "name"` to capture them for later steps.
- On Chrome, grant the `debugger` permission in extension options to enable network tools.
- Firefox does not support `net.*` CDP methods.

## Example: ask Gemini

```json
[
  { "action": "goto", "url": "https://gemini.google.com/app" },
  { "action": "wait", "selector": "[aria-label='Enter a prompt for Gemini']" },
  { "action": "type", "selector": "[aria-label='Enter a prompt for Gemini']", "text": "What are safer browser AI agents?" },
  { "action": "click", "selector": ".send-button button" },
  { "action": "sleep", "ms": 15000 },
  { "action": "read", "selector": "[data-test-id='conversation-turn-response']" }
]
```
