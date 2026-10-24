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
  - `lib/pages.mjs` — browser-use page sessions: attach, isolated world,
    evaluation, mouse/keyboard input, navigation (broker-owned).
  - `lib/page-scripts.mjs` — the page-side snapshot/click/type/ready scripts
    injected through `Runtime.evaluate`.

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
  Pages that could not be confirmed closed are reported in `stillOpen` and keep
  their ownership so a later retry can finish the job.
- `close_browser` is the only operation that shuts Chrome down and requires
  `confirm: true`.
- Ownership is persisted under the broker state directory (`ownership.json`,
  per-port state directory). A broker restart re-loads it and reconciles it with
  `Target.getTargets`; targets that disappeared are dropped.

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
- First-time discovery uses an **adaptive settle**: after `WebMCP.enable`, wait
  for a quiet window of 120 ms once `toolsAdded`/`toolsRemoved` events start, a
  short 450 ms idle fallback when the page replays no tools, or the hard
  `waitMs` ceiling (default `CHROME_TOOL_SETTLE_MS`), whichever comes first.
  Never a fixed 1.5 s sleep on every call.
- Attach/enable/discovery must be single-flight per target: concurrent callers
  share one promise and one enable.

### Tool invocation

- `invoke_tool` waits for `WebMCP.toolResponded` keyed by `invocationId`. No
  polling loop. Send `WebMCP.invokeTool` first; when the response arrives before
  the `{invocationId}` acknowledgement it is parked in a short-lived `recent`
  table, and the waiter is attached as soon as the id is known.
- Waiting for a response must not occupy a CDP scheduler slot: the CDP command
  returns `{invocationId}` immediately; the wait is local state.
- A timeout (`waitMs`, default `CHROME_INVOKE_WAIT_MS`, cap 120000) rejects with
  `TOOL_TIMEOUT`; the late response is discarded. The page-side call is not
  cancelled (Chrome exposes no cancel command in this build).
- Multiple concurrent invocations on the same page, same tool name, different
  clients must each resolve with their own `invocationId` output.
- `frameId` requires `targetId`; otherwise `FRAME_WITHOUT_TARGET`.

### Browser-use page sessions

Independent of the WebMCP session registry, the broker keeps a `PageBook` session
per page target:

- `Target.attachToTarget {flatten:true}` then `Page.createIsolatedWorld` with the
  world name `dsh-browser-use`. All browser-use scripts run in that world, so the
  page's DOM, styles and globals are untouched.
- The ref table lives in the isolated world as a non-enumerable
  `globalThis.__dshBrowserUse`. A snapshot assigns each interactive element a
  monotonically increasing integer index (`nextIndex` never resets while the
  document lives). Only the latest snapshot's indices are current; an old index
  fails with `REF_NOT_FOUND` instead of addressing a different element.
- `index` must be an integer in `0..2147483647` (a pure decimal string such as
  `"12"` is accepted). `null`, booleans, arrays and other non-numeric types are
  rejected with `INVALID_PARAMS` rather than coerced, so a caller mistake can
  never turn into a click on element 0.
- Navigation destroys the isolated world. The next `snapshot` creates a new one
  and restarts indices at 0; the broker cannot reuse refs across navigation.
- Works on any page target, including pages with no WebMCP tools.
- `close_task` drops this session together with the WebMCP session.

Snapshot semantics:

- Serialized as one line per element: `[12]<button type="submit">Sign in</button>`,
  `[13]<input type="text" name="email" ... />`, `[14]<select ... options="..."/>`.
- Candidates are links, buttons, inputs, selects, textareas, `summary`,
  `contenteditable`, ARIA widgets and `tabindex` elements. Elements hidden by
  `checkVisibility` (opacity/visibility/content-visibility), `aria-hidden`,
  `inert`, `display:none`, or a zero box are skipped.
- Password input values are omitted. Open shadow roots are traversed for **every**
  host element, whether or not the host itself is interactive; closed shadow roots
  and iframe documents are not reachable.
- `maxElements` defaults to `CHROME_SNAPSHOT_MAX_ELEMENTS` (200) and is capped at
  2000. `total` is the number of candidates found; `truncated` is true when the
  serialized list hit the budget.

Action semantics:

- Actions dispatch real CDP `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`
  / `Input.insertText`, never `element.click()`, so hover menus, framework
  handlers and form submission behave like user input.
- Before clicking, the page script scrolls the element into view, waits two
  animation frames (150 ms fallback), computes the center point and verifies it
  with a composed `elementFromPoint` hit test that descends open shadow roots.
  Covered or off-screen elements fail with `ELEMENT_COVERED` /
  `ELEMENT_NOT_VISIBLE`.
- `<select>` is handled by `type_text`: the option is matched by value, exact
  label, or label substring and set through the native setter, then `input` and
  `change` are dispatched. Native OS dropdowns are never opened, so these two
  events are necessarily synthetic (`isTrusted:false`); framework bindings still
  react to them.
- `type_text` with `clear` sends `Control+A` (`Meta+A` on macOS), then inserts the
  text. `submit` presses Enter afterwards.
- Action timeouts and stale contexts surface as `PAGE_CONTEXT_LOST`; call
  `snapshot` again.

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
| `snapshot` | `taskId`, `targetId?`, `url?`, `maxElements?` | see below |
| `click` | `taskId`, `index`*, `targetId?`, `url?`, `button?`, `clickCount?`, `waitMs?` | see below |
| `type_text` | `taskId`, `index`*, `text`*, `targetId?`, `url?`, `clear?`, `submit?`, `waitMs?` | see below |
| `press_key` | `taskId`, `key`*, `targetId?`, `url?`, `waitMs?` | see below |
| `navigate` | `taskId`, `url`*, `targetId?`, `waitMs?` | see below |
| `open_page` | `taskId`, `url`*, `isolated?`, `waitMs?` | see below |
| `close_task` | `taskId` | `{taskId, closedTargetIds, stillOpen, disposedContext}` |
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
When Chrome is unreachable, `status` still answers with
`chrome.reachable: false` and a top-level `pageIndexError` (for example
`CHROME_UNREACHABLE`) instead of failing.

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

Resolution order: task-owned pages (most recently opened first), then unowned
pages. If more than one candidate has the tool, `ambiguous` is true and the
chosen target is reported. If no candidate has the tool: `TOOL_NOT_FOUND` with
`data: {toolName, taskId, candidates}`.

### `open_page`

```json
{"taskId":"default","targetId":"...","url":"...","title":"...","isolated":false,
 "tools":[{"name":"...","description":"...","inputSchema":{},"frameId":"..."}]}
```

`waitMs` bounds page-load + first tool discovery (default 2500). The page becomes
owned by the task even if no tools register.

### Browser-use methods

An explicit `targetId` must be owned by the task or be unowned (otherwise
`TARGET_OTHER_TASK`); a `targetId` that no longer exists is `TARGET_NOT_FOUND`.

Perception and action resolve their page differently:

- `snapshot` (perception) may omit `targetId`. It then takes the first candidate:
  task-owned pages (most recently opened first), then unowned pages.
- `click`, `type_text`, `press_key` and `navigate` (actions) may act on an
  unowned page, but **only when its `targetId` is passed explicitly**. Without a
  `targetId` they never pick an unowned page implicitly: if the first candidate
  is unowned they fail with `TARGET_ID_REQUIRED`. That keeps a concurrent task
  from driving a tab the user — or another agent — already has open.
- An empty candidate set is `TARGET_NOT_FOUND`.

#### `snapshot`

```json
{
  "taskId": "default",
  "targetId": "...",
  "url": "https://example.test/login",
  "title": "Sign in",
  "snapshotId": 3,
  "elements": 12,
  "total": 12,
  "truncated": false,
  "snapshot": "[12]<button type=\"submit\">Sign in</button>\n[13]<input ..."
}
```

`snapshot` is idempotent with respect to the page: it only reads. `elements` is
the number of serialized lines; `total` the candidate count before the budget.
Indices in `snapshot` are the only valid `index` values for the next action.

#### `click`

```json
{
  "taskId": "default", "targetId": "...", "action": "click",
  "index": 12, "tag": "button", "label": "Sign in",
  "x": 42, "y": 24, "button": "left", "clickCount": 1,
  "url": "...", "title": "..."
}
```

`button` is `left` (default), `right` or `middle`; `clickCount` is clamped to
1–3. After the click the broker waits `waitMs` (default
`CHROME_ACTION_SETTLE_MS` = 300) before reading page facts.

#### `type_text`

```json
{
  "taskId": "default", "targetId": "...", "action": "type_text",
  "index": 13, "mode": "typed", "tag": "input", "label": "Email",
  "text": "ada@example.test", "cleared": true, "submitted": false,
  "url": "...", "title": "..."
}
```

`mode` is `typed` for input/textarea/contenteditable and `selected` for a
`<select>`, where the result carries the chosen `value`/`label` instead of the
input text. An unmatched option is `OPTION_NOT_FOUND` with
`data: {options}`. Non-editable targets are `NOT_EDITABLE`.

#### `press_key`

```json
{"taskId":"default","targetId":"...","action":"press_key","key":"Enter",
 "modifiers":[],"url":"...","title":"..."}
```

Supported keys: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Space`,
`ArrowUp/Down/Left/Right`, `Home`, `End`, `PageUp`, `PageDown`, single
letters/digits, optionally prefixed with `Alt+`, `Ctrl+`, `Meta+`, `Shift+`.
Anything else is `INVALID_PARAMS`.

#### `navigate`

```json
{"taskId":"default","targetId":"...","action":"navigate",
 "requestedUrl":"https://...","url":"https://...","title":"...",
 "loaded":true,"elapsedMs":412}
```

Only `http(s)`, `file:` and `about:` URLs are accepted. The broker invalidates
the old isolated world, sends `Page.navigate`, then polls `document.readyState`
until `complete`. Load failure is `NAVIGATION_FAILED`; exceeding `waitMs`
(default `CHROME_NAVIGATE_WAIT_MS` = 10000) is `NAVIGATION_TIMEOUT`.
Because the world is replaced, the next action needs a new `snapshot`.

## 5. Broker architecture requirements

### One channel, fair scheduling

- Exactly one CDP WebSocket to Chrome per broker. Never one socket per client.
- `lib/cdp.mjs` exposes `send(method, params, sessionId, {clientId, timeoutMs})`
  and an event subscription. It enforces:
  - global in-flight cap `CHROME_WEBMCP_MAX_INFLIGHT` (default 32),
  - per-client in-flight cap `CHROME_WEBMCP_CLIENT_MAX_INFLIGHT` (default 8),
  - FIFO selection with a per-client in-flight cap: entries from a client that
    is already at its cap are skipped, so other clients behind it still get a
    slot and one client cannot starve the rest,
  - per-command timeout `CHROME_CDP_TIMEOUT_MS` (default 30000); a timed-out
    command frees its slot and its late response is ignored.
- Discovery scans run with `CHROME_WEBMCP_DISCOVERY_CONCURRENCY` (default 4)
  in parallel and must not block unrelated commands.

### Event routing

- `WebMCP.toolsAdded` / `toolsRemoved` update the registry for `sessionId`.
- `WebMCP.toolResponded` resolves exactly one waiter by `invocationId`, wherever
  it came from; nothing is broadcast to clients.
- `Target.targetDestroyed` / `Target.detachedFromTarget` / `Inspector.detached`
  clean session, registry, ownership and the browser-use page session, and
  reject that target's waiters with `TARGET_GONE`.
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
| `snapshot` | `targetId`, `url`, `taskId`, `maxElements` | perceive: numbered interactive elements |
| `click` | `index`* , `targetId`, `url`, `taskId`, `button`, `clickCount`, `waitMs` | act: real mouse click |
| `type_text` | `index`* , `text`* , `targetId`, `url`, `taskId`, `clear`, `submit`, `waitMs` | act: focus + type, or select an option |
| `press_key` | `key`* , `targetId`, `url`, `taskId`, `waitMs` | act: key or chord |
| `navigate` | `url`* , `targetId`, `taskId`, `waitMs` | act: navigate and wait for load |
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
- They must also describe the browser-use loop: call `snapshot` to perceive,
  act with `click`/`type_text`/`press_key`/`navigate` using indices from the
  latest snapshot only, and take a new snapshot after every action or
  navigation. Prefer WebMCP tools when the page exposes them.
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
| `CHROME_SNAPSHOT_MAX_ELEMENTS` | `200` | default `snapshot` element budget (cap 2000) |
| `CHROME_ACTION_SETTLE_MS` | `300` | settle after click/type/press before reading page facts |
| `CHROME_NAVIGATE_WAIT_MS` | `10000` | default `navigate` load wait |
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

Browser-use additions:

| code | raised by | meaning |
|---|---|---|
| `PAGE_NOT_READABLE` | attach / isolated world | the target cannot run page scripts (`chrome://`, devtools, etc.) |
| `TARGET_ID_REQUIRED` | `click` / `type_text` / `press_key` / `navigate` | the resolved page is unowned and no explicit `targetId` was given |
| `PAGE_EVALUATION_FAILED` | `Runtime.evaluate` | the page script threw during snapshot/action |
| `PAGE_CONTEXT_LOST` | any action | the isolated world was destroyed (navigation/reload); take a new snapshot |
| `REF_NOT_FOUND` | `click` / `type_text` | the index does not belong to the latest snapshot |
| `REF_STALE` | `click` / `type_text` | the element was removed from the DOM |
| `ELEMENT_NOT_VISIBLE` | `click` | zero box or outside the viewport |
| `ELEMENT_COVERED` | `click` | another element is on top at the click point |
| `NOT_EDITABLE` | `type_text` | target is not an input, textarea or contenteditable |
| `OPTION_NOT_FOUND` | `type_text` | no `<option>` matches; `data.options` lists them |
| `NAVIGATION_FAILED` | `navigate` | Chrome rejected the URL (`errorText`) |
| `NAVIGATION_TIMEOUT` | `navigate` | `readyState` did not reach `complete` within `waitMs` |

## 9. Test hooks

- The broker must accept `CHROME_CDP_PORT` pointing at a fake CDP server. The
  fake implements `/json/version` plus
  `Target.getTargets` (result key `targetInfos`), `Target.attachToTarget`,
  `Target.createTarget`, `Target.closeTarget`,
  `Target.disposeBrowserContext`, `Target.createBrowserContext`, `Browser.close`,
  and the `WebMCP` domain.
- For browser-use it must also implement `Target.getTargetInfo`,
  `Target.targetDestroyed`, `Page.getFrameTree`, `Page.createIsolatedWorld`,
  `Page.navigate`, `Runtime.evaluate` and
  `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText`.
  The fake recognizes the page scripts by their leading marker comments
  (`MARKERS` in `lib/page-scripts.mjs`) and returns canned values, so tests can
  assert the real CDP traffic (coordinates, key events, ordering) without a
  browser.
- Tests use unique `CHROME_WEBMCP_IPC` + `CHROME_WEBMCP_STATE_DIR` so they never
  touch a user's broker or Chrome.
- The broker API must be usable from a test that imports `broker.mjs`
  (`runBroker({ ipcName, port, idleMs })` returns `{ close }` after listening);
  spawning `node bridge.mjs --broker` with env is equally acceptable.
