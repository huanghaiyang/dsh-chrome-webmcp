# dev/ — historical WebMCP / CDP investigation material

This directory keeps the one-off probes and captured evidence from the initial
Chrome **155** WebMCP investigation (2026-10). It exists for traceability only:

- the installable plugin and its tests live in [`../chrome-webmcp-mcp/`](../chrome-webmcp-mcp/README.md);
- **none of these files are imported, packaged, or executed by the plugin**;
- several scripts were written against the v1 bridge/tool shape. Their imports and
  the demo-page paths were adjusted for the new location, but API drift since v2 means
  they are reference material, not a maintained test suite.

## probes/ (22 scripts)

Run from this directory or with an absolute path; scripts that create files write
into the current working directory. The demo page remains at
[`../webmcp-test.html`](../webmcp-test.html); `serve.mjs` serves the repository root.

| Probe | Purpose |
|---|---|
| [cdp-client.mjs](probes/cdp-client.mjs) | Pure-network CDP client against an already-running Chrome (no process spawn) |
| [cdp-close.mjs](probes/cdp-close.mjs) | Gracefully close Chrome through the browser-level CDP endpoint |
| [cdp-protocol.mjs](probes/cdp-protocol.mjs) | Fetch the authoritative CDP protocol and locate the WebMCP domain |
| [ws-probe.mjs](probes/ws-probe.mjs) | Minimal `/json/version` + WebSocket + `Target.getTargets` liveness check |
| [check-launch.mjs](probes/check-launch.mjs) | Read a launched browser's real command line and one page's WebMCP state |
| [identify-instance.mjs](probes/identify-instance.mjs) | Prove which Chrome instance/profile sits behind the DevTools port |
| [inspect-target.mjs](probes/inspect-target.mjs) | Inspect one existing target: page log and WebMCP API availability |
| [probe-globals.mjs](probes/probe-globals.mjs) | Enumerate WebMCP-ish globals/properties on a live page |
| [webmcp-probe.mjs](probes/webmcp-probe.mjs) | Launch an isolated Chrome with WebMCP and probe the CDP domain surface |
| [webmcp-diag.mjs](probes/webmcp-diag.mjs) | Diagnose the frame-scoped WebMCP domain on a page session |
| [webmcp-flags.mjs](probes/webmcp-flags.mjs) | Ask Chrome which WebMCP flags exist and test page-API exposure |
| [webmcp-e2e.mjs](probes/webmcp-e2e.mjs) | Load page → `WebMCP.enable` → collect tools → invoke |
| [webmcp-invoke.mjs](probes/webmcp-invoke.mjs) | Invoke a page tool through the CDP `WebMCP` domain |
| [webmcp-roundtrip.mjs](probes/webmcp-roundtrip.mjs) | Full page-register → enable → toolsAdded → invoke round trip |
| [test-bridge.mjs](probes/test-bridge.mjs) | In-process old bridge handler test (no child stdio) |
| [test-bridge-file.mjs](probes/test-bridge-file.mjs) | Old bridge check on a `file://` page |
| [test-open-page.mjs](probes/test-open-page.mjs) | Old bridge `open_page`/invoke check against the local demo server |
| [kw-scan.mjs](probes/kw-scan.mjs) | Printable-string keyword scanner for a binary/file |
| [mcp-recon.mjs](probes/mcp-recon.mjs) | Scan files for MCP-ish printable strings and group by source |
| [mcp-recon2.mjs](probes/mcp-recon2.mjs) | Extract protocol/API-like identifiers around `mcp` in a binary |
| [string-neighborhood.mjs](probes/string-neighborhood.mjs) | Dump strings around key WebMCP markers in `chrome.dll` to find feature names |
| [serve.mjs](probes/serve.mjs) | Loopback static server for the demo page on port 8788 |

## evidence/ (12 captured files)

The Chrome logs and instance proof are **sanitized**: vendor install paths,
extension ids, DevTools instance UUIDs, user names, absolute paths, and the OS exact
build are replaced with placeholders such as `<VENDOR_PATH>`, `<ext-id>`,
`<WORKSPACE>`, `<CHROME_EXE>`, `<redacted>`. Timestamps and process ids are kept
because they are transient and not identifying.

| Evidence | Content |
|---|---|
| [webmcp-flags.json](evidence/webmcp-flags.json) | WebMCP-related feature flags observed |
| [webmcp-protocol.json](evidence/webmcp-protocol.json) | Whether the WebMCP domain is listed by the protocol endpoint |
| [webmcp-page-schema.json](evidence/webmcp-page-schema.json) | Page-side schema capture (empty result at that point) |
| [webmcp-e2e-events.json](evidence/webmcp-e2e-events.json) | Event trace from the end-to-end probe |
| [webmcp-invoke.json](evidence/webmcp-invoke.json) | `toolInvoked` / `toolResponded` trace for one invocation |
| [webmcp-probe-result.json](evidence/webmcp-probe-result.json) | Launch/probe event capture |
| [webmcp-roundtrip.json](evidence/webmcp-roundtrip.json) | Full round-trip event trace |
| [chrome-err.txt](evidence/chrome-err.txt) / [chrome-err2.txt](evidence/chrome-err2.txt) / [chrome-err3.txt](evidence/chrome-err3.txt) | Sandbox crashpad `OpenProcess` failure that prevents a sandboxed shell from launching Chrome |
| [chrome-live.txt](evidence/chrome-live.txt) | Live Chrome stderr showing the DevTools endpoint; vendor/extension/UUID fields sanitized |
| [chrome-instance-identity.txt](evidence/chrome-instance-identity.txt) | `chrome://version` output proving the isolated profile; machine-specific fields sanitized |

## Reproducing the demo page

```sh
node dev/probes/serve.mjs        # http://127.0.0.1:8788/webmcp-test.html
# or open ../webmcp-test.html directly as file://
```

Runtime verification lives in the maintained suite:

```sh
cd ../chrome-webmcp-mcp
node --test --experimental-test-isolation=none "test/*.test.mjs"
```
