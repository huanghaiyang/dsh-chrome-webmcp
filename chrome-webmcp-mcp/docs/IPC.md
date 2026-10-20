# Chrome WebMCP bridge — internal contract (v2)

This document is the single source of truth shared by the three written parts of
the plugin: the **broker** (owns Chrome), the **MCP client** (owns stdio), and
the **tests**. If an implementation detail is not fixed here, keep it local and
do not change an interface another part depends on.

## 1. Processes and files

```
MCP host
  └─ spawns: node bridge.mjs                 (one per host; stdio MCP server)
       └─ connects/spawns: node bridge.mjs --broker   (one per Chrome port, detached)
            └─ one CDP WebSocket: ws://127.0.0.1:<port>/devtools/browser/<id>
                 └─ Chrome (many page targets, many browser contexts)
```

- `bridge.mjs` is the only entry. `--broker` switches it to broker mode.
- The broker is **per Chrome port**, not per MCP client. Every MCP client process
  that targets the same `CHROME_CDP_PORT` must share the same broker.
- The broker is spawned detached with `stdio: 'ignore'` by a client, after a
  failed connect attempt. It may start while Chrome is down.
- Files:
  - `bridge.mjs` — MCP stdio server, tool definitions, broker lifecycle client.
  - `broker.mjs` — broker implementation; exports `runBroker()`, imported by
    `bridge.mjs` in `--broker` mode.
  - `lib/config.mjs` — shared configuration (already written).
  - `lib/ipc.mjs` — newline-JSON IPC (already written).
  - `lib/cdp.mjs` — CDP WebSocket client, scheduler, event bus (broker-owned).
  - `lib/sessions.mjs` — per-target attach + WebMCP registry (broker-owned).
  - `lib/tasks.mjs` — task namespaces and page ownership (broker-owned).

## 2. IPC transport

- Endpoint: `lib/config.mjs` `IPC_NAME` (Windows named pipe, else Unix socket in
  the OS temp directory). Override with `CHROME_WEBMCP_IPC` (tests).
- Framing: one UTF-8 JSON object per line (`\n`). No request batching.
- Client → broker request: `{"id":<number>,"method":<string>,"params":<object>}`
- Broker → client response: `{"id":<number>,"ok":true,"result":<any>}` or
  `{"id":<number>,"ok":false,"error":{"code":<string>,"message":<string>,"data"?:<any>}}`
- Broker never sends unsolicited notifications in v1.
- A request id is unique per connection. The broker must answer every request,
  including invalid parameters, without dropping the connection.
- Malformed JSON or a frame larger than `MAX_LINE_BYTES` closes that connection
  only; the broker keeps serving other clients.

### Handshake

The first request on a connection must be `hello`:

```json
{"id":1,"method":"hello","params":{"clientId":"mcp-1234-ab12","pid":1234,"version":"2.0.0","taskId":"default"}}
```

Result:

```json
{"brokerId":"b-<pid>","version":"2.0.0","pid":4321,"ipc":"...","port":9333,
 "startedAt":"2026-10-20T15:00:00.000Z",
 "chrome":{"reachable":true,"browser":"Chrome/155.0.8059.39","protocolVersion":"1.3"}}
```

`chrome.reachable` is a cached probe result; it may be `false` without an error.

## 3. Semantic model

### Task namespaces

- `taskId` is a logical namespace chosen by the caller: `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`,
  default `"default"`.
- Every task-scoped request takes `taskId` and every task-scoped result returns
  the normalized `taskId`.
- A task can own page targets. Ownership is recorded only when the broker creates
  a page through `open_page`; pages created by the user or by other software are
  **unowned** and shared read-only by all tasks.
- Candidates for `list_tools` and `invoke_tool` are: the task's owned pages plus
  all unowned pages. Pages owned by another task are never candidates.
- An explicit `targetId` that belongs to another task fails with
  `TARGET_OTHER_TASK`. Unknown target fails with `TARGET_NOT_FOUND`.
- A task may also own one isolated browser context (Chrome
  `Target.createBrowserContext`) when `open_page.isolated` is true. Its pages use
  that context (separate cookies/storage). Non-isolated pages use the browser
  default context.
- `close_task` closes only that task's owned pages and disposes its context. It
  never closes unowned pages or another task's pages, and never closes Chrome.
- `close_browser` is the only operation that shuts Chrome down and requires
  `confirm: true`.

### Page facts

For each page target the broker keeps: `targetId`, `url`, `title`,
`browserContextId` (may be empty), `ownerTaskId` (or `null`), `isolated`.

URLs of other tasks' pages must not appear in `status` summary output.

### WebMCP session registry

- One page target has at most one attached CDP session and one WebMCP enable.
- `Target.attachToTarget {targetId, flatten: true}` yields `sessionId`.
- `WebMCP.enable` is called once per session. Chrome replays registered tools as
  `WebMCP.toolsAdded`; subsequent changes arrive as `toolsAdded`/`toolsRemoved`.
- The registry is persistent: once a target has been discovered, later
  `list_tools` calls return the cached registry immediately. `refresh: true`
  re-enables and waits for a settle window.
- First-time discovery uses an **adaptive settle**: resolve on the first
  `toolsAdded` after a quiet window of 150 ms, or after `waitMs`
  (default `CHROME_TOOL_SETTLE_MS`), whichever comes first. Never a fixed
  1.5 s sleep on every call.
- Attach/enable/discovery must be single-flight per target: concurrent callers
  share one promise and one enable.

### Tool invocation

- `invoke_tool` waits for `WebMCP.toolResponded` keyed by `invocationId`. No
  polling loop. Register the waiter **before** sending `WebMCP.invokeTool`.
- Waiting for a response must not occupy a CDP scheduler slot: the CDP command
  returns `{invocationId}` immediately; the wait is local state.
- A timeout (`waitMs`, default `CHROME_INVOKE_WAIT_MS`, cap 120000) rejects with
  `TOOL_TIMEOUT`; the late response is discarded. The page-side call is not
  cancelled (Chrome exposes no cancel command in this build).
- Multiple concurrent invocations on the same page, same tool name, different
  clients must each resolve with their own `invocationId` output.
- `frameId` requires `targetId`; otherwise `FRAME_WITHOUT_TARGET`.

## 4. Broker methods

All methods except `hello` and `ping` are task-scoped where noted. `params`
fields are optional unless marked.

| method | params | result |
|---|---|---|
| `hello` | `clientId`*, `pid`, `version`, `taskId?` | broker + Chrome facts (see above) |
| `ping` | — | `{pong:true, uptimeMs}` |
| `status` | `taskId`, `detail: "summary"\|"full"` | see below |
| `list_tools` | `taskId`, `targetId?`, `url?`, `waitMs?`, `refresh?` | see below |
| `invoke_tool` | `taskId`, `toolName`*, `input?`, `targetId?`, `url?`, `frameId?`, `waitMs?` | see below |
| `open_page` | `taskId`, `url`*, `isolated?`, `waitMs?` | see below |
| `close_task` | `taskId` | `{taskId, closedTargetIds, disposedContext}` |
| `close_browser` | `confirm`* (must be `true`) | `{closed:true}` |
| `launch` | `url?`, `timeoutMs?` | `{launched, alreadyRunning, pid?, userDataDir?, browser?}` |
| `shutdown` | — | `{stopping:true}` (test-only; broker exits) |

### `status`

```json
{
  "chrome": {"reachable": true, "browser": "Chrome/155...", "protocolVersion": "1.3", "error": null},
  "broker": {"pid": 4321, "version": "2.0.0", "uptimeMs": 12345, "clients": 2},
  "port": 9333,
  "ipc": "\\\\.\\pipe\\dsh-chrome-webmcp-9333",
  "task": {"id": "default", "pages": [{"targetId":"...","url":"...","title":"...","isolated":false}], "isolated": false},
  "otherTasks": [{"id": "a", "pages": 1, "lastUsedAt": "..."}]
}
```

`status` is read-only: it must not attach a session or enable WebMCP.
`detail: "full"` may include other tasks' page counts, never their URLs.

### `list_tools`

```json
{
  "taskId": "default",
  "candidates": 2,
  "pages": [
    {"targetId":"...","url":"...","title":"...","isolated":false,
     "ownedBy": null,
     "tools":[{"name":"add_numbers","description":"...","inputSchema":{...},"frameId":"..."}]}
  ],
  "skipped": 0
}
```

Pages that cannot be attached (e.g. `chrome://`, devtools) are skipped and
counted. `refresh` is coalesced per target.

### `invoke_tool`

```json
{
  "taskId": "default",
  "toolName": "add_numbers",
  "targetId": "...",
  "frameId": "...",
  "status": "Completed",
  "output": {"sum": 42},
  "invocationId": "...",
  "durationMs": 18,
  "ambiguous": false
}
```

Resolution order: task-owned pages (most recently used first), then unowned
pages. If more than one candidate has the tool, `ambiguous` is true and the
chosen target is reported. If no candidate has the tool: `TOOL_NOT_FOUND` with
`data: {pages, candidates, toolName}`.

### `open_page`

```json
{"taskId":"default","targetId":"...","url":"...","title":"...","isolated":false,
 "tools":[{"name":"...","description":"...","inputSchema":{},"frameId":"..."}]}
```

`waitMs` bounds page-load + first tool discovery (default 2500). The page becomes
owned by the task even if no tools register.

## 5. Broker architecture requirements

### One channel, fair scheduling

- Exactly one CDP WebSocket to Chrome per broker. Never one socket per client.
- `lib/cdp.mjs` exposes `send(method, params, sessionId, {clientId, timeoutMs})`
  and an event subscription. It enforces:
  - global in-flight cap `CHROME_WEBMCP_MAX_INFLIGHT` (default 32),
  - per-client in-flight cap `CHROME_WEBMCP_CLIENT_MAX_INFLIGHT` (default 8),
  - FIFO round-robin across clients so one client cannot starve another,
  - per-command timeout `CHROME_CDP_TIMEOUT_MS` (default 30000); a timed-out
    command frees its slot and its late response is ignored.
- Discovery scans run with `CHROME_WEBMCP_DISCOVERY_CONCURRENCY` (default 4)
  in parallel and must not block unrelated commands.

### Event routing

- `WebMCP.toolsAdded` / `toolsRemoved` update the registry for `sessionId`.
- `WebMCP.toolResponded` resolves exactly one waiter by `invocationId`, wherever
  it came from; nothing is broadcast to clients.
- `Target.targetDestroyed` / `Inspector.detached` clean session, registry,
  ownership, and reject that target's waiters with `TARGET_GONE`.
- WebSocket close rejects all pending CDP commands and waiters
  (`CHROME_DISCONNECTED`), clears sessions; tasks survive. The next request
  reconnects. Reconcile owned targets with `Target.getTargets` and drop targets
  that no longer exist.

### Broker lifecycle

- On start: ensure `STATE_DIR`, rotate `broker.log` at ~2 MB, write `STATE_FILE`
  with `{pid, ipc, port, startedAt, version}`.
- Log to `LOG_FILE`; never write diagnostics to stdout (broker stdout is unused).
- Idle exit after `CHROME_WEBMCP_BROKER_IDLE_MS` with zero clients: close the CDP
  socket, remove `STATE_FILE`, exit 0. Chrome keeps running.
- `SIGINT`/`SIGTERM`: close server, remove state file, exit.
- Starting a second broker on an endpoint already served must fail cleanly
  (`EADDRINUSE`); the client treats that as success if it can connect.

### Chrome attach / launch

- `version()` = `fetch(ENDPOINT + '/json/version')` with a 2 s timeout; cache for
  2 s. Failure → `CHROME_UNREACHABLE` for operations that need Chrome.
- `launch` spawns Chrome detached with:
  `--user-data-dir`, `--remote-debugging-port`, `--remote-allow-origins=*`,
  `--no-first-run`, `--no-default-browser-check`, `--disable-background-networking`,
  `--disable-sync`, `--enable-features=enable-webmcp-testing,WebMCP`,
  `--enable-blink-features=WebMCP`, plus URL. Wait for `/json/version` up to
  `timeoutMs` (default `CHROME_LISTEN_WAIT_MS`).
- Chrome is launched by the broker, which the harness Host spawns outside its
  file sandbox; do not attempt to launch Chrome from an agent shell.

## 6. MCP client behavior (`bridge.mjs`)

- stdio MCP server, newline-delimited JSON-RPC 2.0. stdout carries protocol
  frames only; diagnostics go to stderr.
- `initialize` echoes the requested protocol version (fallback `2024-11-05`) and
  returns serverInfo `{name:"chrome-webmcp", version:"2.0.0"}`.
- Lazy broker connection: connect to `IPC_NAME`; on failure spawn
  `process.execPath bridge.mjs --broker` detached (`stdio:"ignore"`,
  `windowsHide:true`), then retry connect until `BROKER_START_WAIT_MS`. Send
  `hello` once per connection.
- On connection loss: reject the in-flight MCP call with a clear message; do not
  silently retry mutating calls (`open_page`, `invoke_tool`, `close_*`,
  `launch`). The next call reconnects.
- Request timeout = `params.waitMs + 15000` (or 45 s for non-wait methods).
- Every tool call is one IPC request. No client-side caching of page state.

### MCP tool definitions

| tool | params (all optional unless noted) | notes |
|---|---|---|
| `status` | `taskId`, `detail: "summary"\|"full"` | read-only; default task `default` |
| `list_tools` | `targetId`, `url`, `taskId`, `waitMs`, `refresh` | scoped to task + unowned pages |
| `invoke_tool` | `toolName`* , `input`, `targetId`, `url`, `frameId`, `taskId`, `waitMs` | `frameId` needs `targetId` |
| `open_page` | `url`* , `taskId`, `isolated`, `waitMs` | creates a task-owned page |
| `launch` | `url`, `timeoutMs` | starts Chrome if not reachable; never closes tasks |
| `close` | `taskId` | closes that task's owned pages only |
| `close_browser` | `confirm`* (`const true`) | whole Chrome; requires explicit confirmation |

- Put defaults and pairing rules in the parameter descriptions, not repeated in
  the tool description (see the agent-experience guidance).
- The `initialize` instructions must state: pass a distinct `taskId` per
  concurrent task; reuse the `taskId`/`targetId` returned by `open_page`;
  `close` is task-scoped; `close_browser` shuts Chrome down and is only for an
  explicit user request.
- Error result: MCP `isError: true` with `Error: <message>`; include the broker
  error code in the message when present (`Error [CODE]: message`).

## 7. Configuration

| env | default | meaning |
|---|---|---|
| `CHROME_CDP_PORT` | `9333` | Chrome DevTools port; also keys the broker endpoint |
| `CHROME_WEBMCP_IPC` | derived from port | IPC endpoint (tests use a unique one) |
| `CHROME_WEBMCP_STATE_DIR` | `%LOCALAPPDATA%\dsh-chrome-webmcp` | logs + state file |
| `CHROME_PATH` | auto-detect | Chrome executable |
| `CHROME_USER_DATA_DIR` | `%LOCALAPPDATA%\dsh-webmcp-chrome` | isolated profile for `launch` |
| `CHROME_LISTEN_WAIT_MS` | `25000` | `launch` port wait |
| `CHROME_TOOL_SETTLE_MS` | `1200` | first-discovery max settle |
| `CHROME_INVOKE_WAIT_MS` | `20000` | default invocation wait |
| `CHROME_WEBMCP_BROKER_IDLE_MS` | `600000` | idle exit |
| `CHROME_WEBMCP_START_WAIT_MS` | `12000` | client waits for a spawned broker |
| `CHROME_WEBMCP_MAX_INFLIGHT` | `32` | global CDP in-flight cap |
| `CHROME_WEBMCP_CLIENT_MAX_INFLIGHT` | `8` | per-client CDP in-flight cap |
| `CHROME_CDP_TIMEOUT_MS` | `30000` | per CDP command timeout |
| `CHROME_WEBMCP_DISCOVERY_CONCURRENCY` | `4` | parallel page discovery cap |

## 8. Error codes

`INVALID_PARAMS`, `CHROME_UNREACHABLE`, `CHROME_DISCONNECTED`, `CDP_TIMEOUT`,
`TARGET_NOT_FOUND`, `TARGET_OTHER_TASK`, `TARGET_GONE`, `FRAME_WITHOUT_TARGET`,
`TOOL_NOT_FOUND`, `TOOL_TIMEOUT`, `CONFIRM_REQUIRED`, `BROWSER_LAUNCH_FAILED`,
`BROKER_UNAVAILABLE`, `IPC_TIMEOUT`, `IPC_CLOSED`, `METHOD_NOT_FOUND`, `INTERNAL`.

## 9. Test hooks

- The broker must accept `CHROME_CDP_PORT` pointing at a fake CDP server. The
  fake implements `/json/version` plus
  `Target.getTargets` (result key `targetInfos`), `Target.attachToTarget`,
  `Target.createTarget`, `Target.closeTarget`,
  `Target.disposeBrowserContext`, `Target.createBrowserContext`, `Browser.close`,
  and the `WebMCP` domain.
- Tests use unique `CHROME_WEBMCP_IPC` + `CHROME_WEBMCP_STATE_DIR` so they never
  touch a user's broker or Chrome.
- The broker API must be usable from a test that imports `broker.mjs`
  (`runBroker({ ipcName, port, idleMs })` returns `{ close }` after listening);
  spawning `node bridge.mjs --broker` with env is equally acceptable.
