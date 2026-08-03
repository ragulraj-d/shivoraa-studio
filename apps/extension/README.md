# Shivoraa Studio for VS Code

Send API requests, explain errors, and generate tests — without leaving your editor.

## Why this exists

Cloud API clients cannot reach `http://localhost:8000`. That is exactly where your
code runs while you are writing it.

This extension sends requests **from your machine**, so localhost, private
networks, VPN-only services and self-signed certificates all work. The server
resolves variables, auth and inherited headers into a plan; the extension
executes it. Both paths share one resolver, so a request behaves identically
whether it runs here or in the browser.

## Commands

| Command | What it does |
|---|---|
| `Shivoraa: Sign In` | Device-code flow — no token pasting |
| `Shivoraa: Send Request` | `⌘⌥↵` / `Ctrl+Alt+Enter` |
| `Shivoraa: New Request` | Create and send in one step |
| `Shivoraa: Send from cURL in Clipboard` | Paste from devtools, hit send |
| `Shivoraa: Explain This Error` | Select a stack trace → right-click |
| `Shivoraa: Generate Tests for Selection` | Select code → right-click |
| `Shivoraa: Select Environment` | Switch environments from the status bar |

## Settings

| Setting | Default | Notes |
|---|---|---|
| `shivoraa.apiUrl` | `https://api.shivoraa.in/api/v1` | Change only if self-hosting |
| `shivoraa.execution` | `auto` | `auto` runs locally for private hosts, server otherwise |
| `shivoraa.timeout` | `30000` | Milliseconds |

## Security

Tokens are stored in **VS Code SecretStorage**, backed by your OS keychain —
never in `settings.json`, never in a log line, never in the workspace folder.

In local mode the response body stays on your machine. Only metadata (status,
duration, size) syncs to history, so internal API data is not sent anywhere you
did not ask it to go.

## Building

```bash
npm install
npm run build      # bundle to dist/
npm run package    # produce a .vsix
```

Press `F5` in VS Code to launch an Extension Development Host.
