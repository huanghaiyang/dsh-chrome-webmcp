# dsh-chrome-webmcp

Bridges the **WebMCP** tools registered by web pages in the locally installed Chrome
into a DeepSeek Harness profile as MCP tools.

> 中文文档：[README.zh-CN.md](README.zh-CN.md) · Install guide: [docs/INSTALL.md](docs/INSTALL.md)

Verified against **Chrome 155.0.8059.80** on Windows 11 with Node 22.

## What it does

Chrome 155 has no built-in MCP *server*, but it exposes **WebMCP** in two halves:

| Layer | Surface | Notes |
|---|---|---|
| Page API | `document.modelContext` — `registerTool`, `getTools`, `executeTool`, `ontoolchange` | **Not** `navigator.modelContext` in this build. |
| Debug protocol | CDP domain `WebMCP` (frame-scoped) | `WebMCP.enable`, `toolsAdded` / `toolsRemoved`, `invokeTool`, `toolInvoked` / `toolResponded`. |

This plugin turns that debug protocol into seven ordinary MCP tools. It is
configuration-only: `bridge.mjs` runs on the bundled Node runtime, has zero
third-party dependencies, and needs no build step.

## Install

**One click on Windows:** double-click `install.cmd` (or run `node install.mjs` from
this directory). The installer finds `dsh` on `PATH` / `DSH_BIN`, and runs the
supported command:

```bat
dsh plugin --profile web add link:<absolute path to this directory>
```

The profile's bundle selection is updated by DSH's plugin manager. HMR profiles
pick it up immediately; otherwise restart the harness. Verify with
`mcp__chrome__status`, then `mcp__chrome__launch`.

Manual alternative from the agent/Plugin Manager:

```
plugin_manager install_bundle target=<absolute path to this directory>
```

`cordis.patch.yml` resolves the bundle through the profile's dependency graph
(`createRequire(baseUrl).resolve('dsh-chrome-webmcp/package.json')`) and starts it
with `process.execPath`, so it contains **no machine paths**. Moving or cloning the
repository, or installing it from a registry, does not require editing YAML.

Uninstall: `install.cmd --uninstall` or `node install.mjs --uninstall`.

## Multi-task model

One DSH host can run many agents/tasks at once. The bridge gives each caller an
optional **task namespace**:

- `taskId` — `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, default `"default"`. Pass a
  distinct value per concurrent task and reuse the value returned by `open_page`.
- Pages opened through `open_page` are **owned** by that task. `list_tools` and
  `invoke_tool` consider the task's pages plus pages the user opened (unowned);
  pages owned by another task are invisible and fail with `TARGET_OTHER_TASK` if
  addressed directly.
- `open_page.isolated: true` puts the page in a task-exclusive Chrome browser
  context (separate cookies/storage). The context is disposed by `close`.
- `close` is task-scoped: it closes only that task's owned pages. It never closes
  the browser, unowned pages, or another task's work.
- `close_browser` is the only operation that shuts Chrome down, and it requires
  `confirm: true`.

This is what stops concurrent tasks from closing each other's tabs, invoking
tools on each other's pages, or navigating a page another task is using.

## One channel, fair scheduling

All MCP client processes that target the same `CHROME_CDP_PORT` share one
**broker** process and therefore one Chrome DevTools WebSocket:

```
MCP host A ─┐
MCP host B ─┼─ IPC ─→ broker ─→ one CDP WebSocket ─→ Chrome
MCP host C ─┘
```

- Requests are multiplexed by CDP id with a bounded FIFO scheduler, a global
  in-flight cap, and a per-client cap. A task that bursts commands cannot starve
  other tasks, and one slow tool call never holds a channel slot while waiting
  for its result.
- Tool discovery is **single-flight per page** and cached. `list_tools` returns
  the cached registry immediately; `refresh: true` re-enables WebMCP once.
- Tool results are resolved by `invocationId` from `toolResponded` events, with
  no polling loop. Result-before-ack races are handled.
- The broker starts lazily, is shared by every session, and exits after an idle
  period. Chrome keeps running.

The broker's IPC endpoint is a per-user named pipe on Windows (Unix socket
elsewhere). `tcp://127.0.0.1:<port>` is accepted for tests and constrained
environments; the default never listens on a network port.

## Tools exposed to the agent

| Tool | Parameters | Purpose |
|---|---|---|
| `status` | `taskId?`, `detail?: "summary"\|"full"` | Read-only snapshot: Chrome reachability/version, broker facts, this task's owned pages. Never attaches to a page. |
| `list_tools` | `targetId?`, `url?`, `taskId?`, `waitMs?`, `refresh?` | WebMCP registry for the task's pages + unowned pages. |
| `invoke_tool` | `toolName`, `input?`, `targetId?`, `url?`, `frameId?`, `taskId?`, `waitMs?` | Invoke a tool; `frameId` requires `targetId`. |
| `open_page` | `url`, `taskId?`, `isolated?`, `waitMs?` | Open a task-owned page and return its tools. |
| `launch` | `url?`, `timeoutMs?` | Start Chrome with the WebMCP flags if the DevTools port is closed. |
| `close` | `taskId?` | Close only this task's owned pages and isolated context. |
| `close_browser` | `confirm: true` | Whole-browser shutdown; only on explicit user request. |

Page-declared tool metadata is untrusted input: it is surfaced for reading and
only executed when the agent explicitly calls `invoke_tool`.

## Required Chrome flags

`launch` starts Chrome with:

```
--remote-debugging-port=9333
--remote-allow-origins=*
--enable-features=enable-webmcp-testing,WebMCP   # base::Feature name is "enable-webmcp-testing"
--enable-blink-features=WebMCP                   # without this document.modelContext stays undefined
```

Passing only `enable-webmcp-testing` leaves the page API undefined; passing only
`WebMCP` leaves the CDP domain unavailable.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CHROME_CDP_PORT` | `9333` | DevTools port; also keys the broker endpoint |
| `CHROME_WEBMCP_IPC` | derived from port | IPC endpoint; `tcp://host:port` for tests |
| `CHROME_WEBMCP_STATE_DIR` | `%LOCALAPPDATA%\dsh-chrome-webmcp` | Broker log and state file |
| `CHROME_PATH` | auto-detect | Chrome executable used by `launch` |
| `CHROME_USER_DATA_DIR` | `%LOCALAPPDATA%\dsh-webmcp-chrome` | Isolated profile used by `launch` |
| `CHROME_LISTEN_WAIT_MS` | `25000` | `launch` port wait |
| `CHROME_TOOL_SETTLE_MS` | `1200` | First-discovery settle ceiling |
| `CHROME_INVOKE_WAIT_MS` | `20000` | Default invocation wait |
| `CHROME_WEBMCP_BROKER_IDLE_MS` | `600000` | Broker idle exit |
| `CHROME_WEBMCP_START_WAIT_MS` | `12000` | Client wait for a spawned broker |
| `CHROME_WEBMCP_MAX_INFLIGHT` | `32` | Global CDP in-flight cap |
| `CHROME_WEBMCP_CLIENT_MAX_INFLIGHT` | `8` | Per-client CDP in-flight cap |
| `CHROME_CDP_TIMEOUT_MS` | `30000` | Per-CDP command timeout |
| `CHROME_WEBMCP_DISCOVERY_CONCURRENCY` | `4` | Parallel page discovery cap |

Broker diagnostics: `%LOCALAPPDATA%\dsh-chrome-webmcp\broker.log` (rotated at 2 MB).

## Verification

```
mcp__chrome__launch                              -> launched, Chrome/155.0.8059.80
mcp__chrome__open_page url=file:///<REPO>/webmcp-test.html taskId=demo
                                                 -> tools: [get_page_title, add_numbers]
mcp__chrome__invoke_tool toolName=add_numbers input={a:20,b:22} taskId=demo
                                                 -> status: Completed, output: {sum: 42}
mcp__chrome__close taskId=demo                   -> closes only that page
```

Hermetic tests (fake CDP, no real Chrome):

```bash
node --test --experimental-test-isolation=none test/broker.test.mjs test/mcp.test.mjs
```

The `--experimental-test-isolation=none` flag avoids the test runner's own child
process, which some sandboxed environments deny.

## Environment caveat: launching Chrome

Chrome cannot be launched by an agent-sandboxed shell on this host: the Windows
file sandbox denies crashpad's `OpenProcess`, and Chrome logs
`crash server failed to launch, self-terminating`. `--disable-breakpad` does not
help. The MCP bridge process is spawned by the harness Host (outside that
sandbox), so `mcp__chrome__launch` works; the broker it spawns inherits that
freedom.

## Known limits

- The `WebMCP` CDP domain is frame-scoped: it does not appear in
  `Schema.getDomains` or `/json/protocol`, and must be enabled on a page session.
- Pages using `document.domain` cannot expose WebMCP (Chrome limitation).
- After a cross-origin navigation a tool cannot return its result
  (`Cannot return tool results after a cross-origin navigation`).
- `close_browser` closes every page; use `close` for task cleanup.
- `invoke_tool` has no cancel command in this Chrome build: a timeout stops
  waiting, but the page-side call may still complete.

## Files

| File | Purpose |
|---|---|
| [bridge.mjs](bridge.mjs) | MCP stdio server + broker lifecycle client |
| [broker.mjs](broker.mjs) | Single CDP owner: scheduler, sessions, tasks, IPC |
| [lib/config.mjs](lib/config.mjs) | Env-driven configuration |
| [lib/ipc.mjs](lib/ipc.mjs) | Newline-JSON IPC (pipe/socket/TCP) |
| [lib/cdp.mjs](lib/cdp.mjs) | CDP WebSocket + fair scheduler |
| [lib/sessions.mjs](lib/sessions.mjs) | Attach/enable/registry/waiter machinery |
| [lib/tasks.mjs](lib/tasks.mjs) | Task namespaces and page ownership |
| [cordis.patch.yml](cordis.patch.yml) | Portable bundle patch (`!!js`, no absolute paths) |
| [install.mjs](install.mjs) | One-click installer |
| [install.cmd](install.cmd) / [install.sh](install.sh) | Double-click / POSIX wrappers |
| [scripts/check-sensitive.mjs](scripts/check-sensitive.mjs) | Repo-wide sensitive-info gate |
| [docs/INSTALL.md](docs/INSTALL.md) | Install/uninstall/troubleshooting |
| [docs/IPC.md](docs/IPC.md) | Internal broker/client contract |
| [SECURITY.md](SECURITY.md) | Security posture and reporting |
| [test/](test/) | Fake CDP + hermetic tests |
| [../webmcp-test.html](../webmcp-test.html) | Demo page registering `add_numbers`, `get_page_title` |

## License

MIT — see [LICENSE](../LICENSE).
