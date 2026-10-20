# Security notes — `dsh-chrome-webmcp`

## What this plugin touches

- **stdio only.** The MCP client row runs `bridge.mjs` as a child process; the harness
  talks to it over stdin/stdout. No listening socket, no inbound network service.
- **Chrome DevTools Protocol on loopback.** `bridge.mjs` (in broker mode) opens one
  WebSocket to `ws://127.0.0.1:$CHROME_CDP_PORT/devtools/browser/<id>`. The endpoint is
  whoever already listens on that local port; the plugin never exposes it remotely.
  Starting Chrome with `--remote-allow-origins=*` widens what may connect to that port
  locally — that is a Chrome flag, used only for the isolated profile launched by
  `mcp__chrome__launch`.
- **A dedicated Chrome profile.** `launch` starts Chrome with `--user-data-dir` under
  `%LOCALAPPDATA%` (default `dsh-webmcp-chrome`), separate from the user's everyday
  profile. It does not read or upload that profile's data.
- **State on disk.** Broker log and state file live under
  `%LOCALAPPDATA%\dsh-chrome-webmcp` (override: `CHROME_WEBMCP_STATE_DIR`); the state file
  holds only `{pid, ipc, port, startedAt, version}`. Neither is committed to the repo.
- **No credentials.** The plugin has no accounts, tokens, or API keys, and stores no
  page data. It does not read cookies; a browser context created for an isolated task
  simply has its own empty storage.

## Trust boundary

Page-declared tool metadata (`name`, `description`, `inputSchema`) is **untrusted
input**: it is surfaced to the model as data and never executed implicitly. Tool calls
happen only when the agent explicitly invokes `mcp__chrome__invoke_tool`, and the page's
own `execute` function runs inside the page — the bridge does not evaluate page JavaScript.
`close_browser` requires an explicit `confirm: true` because it shuts down the whole
Chrome instance.

## Secrets and machine paths in the repository

`node scripts/check-sensitive.mjs` scans the tree for personal paths, non-system drive
paths, API tokens, private keys and literal cookie values; documented placeholders
(`<REPO>`, `%LOCALAPPDATA%`) and OS paths (`C:\Program Files`, `C:\Windows`) are
allowed. `npm run sanitize` runs it and exits non-zero on findings. `.gitignore` keeps
Chrome profiles, broker logs/state, `node_modules` and test temp directories out of git.

## Reporting a problem

Open an issue in the repository that contains this bundle. Include the harness version,
the Chrome version (`mcp__chrome__status`), and what you expected to happen. Do not paste
tokens, cookies, or full personal paths; redact user names in any pasted log.
