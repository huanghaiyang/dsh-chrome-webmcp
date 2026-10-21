# Install `dsh-chrome-webmcp`

> 中文技术文档（架构、调度、协议、源码导读）：[TECHNICAL.zh-CN.md](TECHNICAL.zh-CN.md)

Bridges the **WebMCP** tools that web pages register in your local Chrome into a
DeepSeek Harness (DSH) profile as the MCP server `chrome` (tools `mcp__chrome__*`).

This is a **configuration-only bundle**: `package.json` declares `dsh.bundle.patch`, and
`cordis.patch.yml` inserts one `@deepseek-ai/dsh-mcp-client` row that runs `bridge.mjs`
over stdio. Nothing is installed globally and no profile file is edited by hand.

- Bundle directory: `<BUNDLE>` (this file is `<BUNDLE>/docs/INSTALL.md`; the folder
  containing `package.json`, `bridge.mjs`, `cordis.patch.yml`)
- Node **>= 22**, Chrome **155** with the WebMCP features, a DSH profile that owns the
  `chrome` MCP row

---

## 1. One-click install (Windows)

Double-click **`install.cmd`** in the bundle directory. It checks Node, runs
`install.mjs`, and keeps the window open so you can read the result.

From a terminal:

```bat
cd /d <BUNDLE>
install.cmd                     :: same as below, double-click friendly
node install.mjs                :: install into the default profile ("web")
node install.mjs --profile myprof
node install.mjs --dry-run      :: print the exact command, change nothing
node install.mjs --uninstall    :: remove the bundle from the profile
node install.mjs --help
```

POSIX:

```sh
./install.sh --profile web
```

The installer only delegates to the profile-owning CLI:

```text
dsh plugin --profile <profile> add link:<BUNDLE>             # install
dsh plugin --profile <profile> remove dsh-chrome-webmcp    # uninstall
```

`link:` records this working copy as a dependency of the profile, so later edits to
`bridge.mjs` are picked up by the next harness restart. The patch file itself stays
machine-independent: it resolves the bridge through the profile's own dependency graph
(`createRequire(baseUrl).resolve('dsh-chrome-webmcp/package.json')`), so no absolute
path is ever committed.

### After installing

1. Restart the harness (or let the plugin row hot-reload). MCP servers are long-lived
   child processes; editing `bridge.mjs` alone does **not** reload them.
2. Check `mcp__chrome__status`. `reachable: true` means the bridge reaches Chrome.
3. If Chrome is not running, call `mcp__chrome__launch`. The harness **host** must start
   Chrome: an agent-sandboxed shell cannot (see §6).

## 2. Manual install without the CLI

Use the harness plugin manager, which performs the same profile update:

```text
plugin_manager install_bundle  target=<BUNDLE>
plugin_manager set_bundle      target=dsh-chrome-webmcp enabled=true
plugin_manager set_bundle      target=dsh-chrome-webmcp enabled=false   # pause
```

Or, equivalently, from a shell that has the harness CLI:

```sh
dsh plugin --profile web add link:<BUNDLE>
```

Do not edit the profile's `package.json` / `cordis.patch.yml` by hand; the CLI keeps
the bundle list and the installed dependency in sync.

## 3. Uninstall

```bat
node install.mjs --uninstall
```

```sh
./install.sh --uninstall
```

or `plugin_manager ... remove`, or `dsh plugin --profile web remove dsh-chrome-webmcp`.
Uninstalling removes the bundle row and the `chrome` MCP tools; it does not delete this
directory, the Chrome profile, or the broker state directory.

## 4. Installer options

| Option | Meaning |
|---|---|
| `--profile <name>` | Target DSH profile. Default: `$DSH_PROFILE`, else `web`. |
| `--dry-run`, `-n` | Print the resolved `dsh` command line and exit without running it. |
| `--uninstall` | Remove the bundle instead of installing it. |
| `--help`, `-h` | Usage. |

| Environment variable | Used by | Meaning |
|---|---|---|
| `DSH_BIN` | installer | Path or command name of the `dsh` CLI when it is not on `PATH` |
| `DSH_PROFILE` | installer | Default profile when `--profile` is omitted |

## 5. Runtime environment (read by `bridge.mjs`)

Set these in the profile row's `env` (currently `CHROME_CDP_PORT`) or in the harness
environment. Defaults come from `lib/config.mjs`.

| Variable | Default | Meaning |
|---|---|---|
| `CHROME_CDP_PORT` | `9333` | Chrome DevTools port; also keys the broker IPC endpoint |
| `CHROME_PATH` | auto-detect | Chrome executable for `mcp__chrome__launch` |
| `CHROME_USER_DATA_DIR` | `%LOCALAPPDATA%\dsh-webmcp-chrome` | Isolated Chrome profile used by `launch` |
| `CHROME_LISTEN_WAIT_MS` | `25000` | How long `launch` waits for the DevTools port |
| `CHROME_TOOL_SETTLE_MS` | `1200` | First-discovery settle window for `toolsAdded` |
| `CHROME_INVOKE_WAIT_MS` | `20000` | Default `invoke_tool` wait |
| `CHROME_WEBMCP_STATE_DIR` | `%LOCALAPPDATA%\dsh-chrome-webmcp` | Broker state file and log |
| `CHROME_WEBMCP_IPC` | derived from the port | IPC endpoint override (tests use it) |

## 6. Troubleshooting

**`dsh` not found.** The installer reports `dsh : not found` and stops with the command
to run yourself. Fix by starting the harness first and running the installer from that
shell, or set `DSH_BIN`, e.g. on Windows `set "DSH_BIN=C:\path\to\dsh.cmd"`. `--dry-run`
always works and shows the command it would run.

**The `chrome` row does not appear / `mcp__chrome__*` tools are missing.** The harness
must reload the profile: restart it (recommended), or use `plugin_manager set_bundle`
to toggle the row. A running MCP server keeps its old code until it is restarted.

**`failOnStartupError` / "1 entry did not activate".** The stdio command failed to
start. In the harness log look for the resolved `args[0]`: it must end in
`bridge.mjs`. If the bundle was not installed with `link:` (so the profile does not
depend on `dsh-chrome-webmcp`), the row cannot resolve its own path — reinstall with
`node install.mjs`.

**Chrome cannot be launched from an agent shell.** On this host the Windows file
sandbox denies Chrome's crashpad `OpenProcess`, and Chrome then logs
`crash server failed to launch, self-terminating`. `--disable-breakpad` does not help.
Always use `mcp__chrome__launch` (the harness host is not sandboxed that way).

**`reachable: false` but Chrome is open.** Chrome was not started with the DevTools
flags. Either call `mcp__chrome__launch`, or start Chrome with
`--remote-debugging-port=9333 --remote-allow-origins=*` plus
`--enable-features=enable-webmcp-testing,WebMCP --enable-blink-features=WebMCP`.
`http://127.0.0.1:9333/json/version` must answer.

**No tools listed for a page.** The page must publish `document.modelContext` tools (not
`navigator.modelContext`), and the browser must have been started with both WebMCP
flags. `list_tools` on a page without tools is a valid empty result, not an error.

**Node too old.** Both the harness and the installer require Node >= 22
(`engines.node`). `node -v` must report `v22` or newer.

## 7. Verification checklist

```sh
node --check install.mjs
node install.mjs --dry-run
node scripts/check-sensitive.mjs                  # exit 0 = no personal paths or secrets
node --test --experimental-test-isolation=none "test/*.test.mjs"   # hermetic tests
```

`--experimental-test-isolation=none` keeps Node's test runner from spawning a child
with piped stdio, which some sandboxed environments deny. On an ordinary machine the
plain `node --test test/` form also works (after removing `test/tmp/` scratch).

Then, inside the harness: `mcp__chrome__launch` → `mcp__chrome__status`
(`reachable: true`) → `mcp__chrome__open_page` on a page that registers a WebMCP tool →
`mcp__chrome__invoke_tool`.
