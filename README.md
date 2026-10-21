# Chrome WebMCP bridge — development workspace

The installable DeepSeek Harness bundle lives in
[`chrome-webmcp-mcp/`](chrome-webmcp-mcp/README.md). Start there for installation,
the task-isolation model, and the broker/channel design. The detailed Chinese
technical document is
[`chrome-webmcp-mcp/docs/TECHNICAL.zh-CN.md`](chrome-webmcp-mcp/docs/TECHNICAL.zh-CN.md).

```
chrome-webmcp-mcp/   installable plugin (bundle patch, bridge, broker, tests, docs)
webmcp-test.html     demo page registering add_numbers / get_page_title
dev/probes/          one-off CDP/WebMCP investigation scripts (not shipped)
dev/evidence/        sanitized protocol captures, Chrome logs, profile proof
dev/README.md        index and context for the archived investigation
```

The plugin has no runtime dependency on `dev/`; that directory is history and
reference material only. See [`dev/README.md`](dev/README.md) for the per-file index.

## Quick start

```bat
cd chrome-webmcp-mcp
node install.mjs --dry-run
node install.mjs
```

Then in the harness: `mcp__chrome__launch` → `mcp__chrome__status` →
`mcp__chrome__open_page` on a WebMCP page → `mcp__chrome__invoke_tool`.

## Repository hygiene

- `chrome-webmcp-mcp/scripts/check-sensitive.mjs` scans tracked-style text for
  personal paths, non-system drive absolutes, tokens, private keys, and cookies.
  Run `node chrome-webmcp-mcp/scripts/check-sensitive.mjs` before committing.
- `.gitignore` excludes Chrome profiles, broker logs/state, test scratch, and
  `.scratch/`.
- The reconnaissance scripts and captures now live under [`dev/`](dev/README.md).
  Their Chrome logs were sanitized: vendor install paths, extension ids, DevTools
  instance UUIDs, user names, and absolute paths are replaced with placeholders.
- `webmcp-test.html` stays at the repository root because the plugin README and the
  manual verification flow link to it; the maintained automated tests use their own
  copy under `chrome-webmcp-mcp/test/fixtures/`.

## License

MIT — see [LICENSE](LICENSE).
