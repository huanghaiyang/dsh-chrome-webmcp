# Chrome WebMCP bridge — development workspace

The installable DeepSeek Harness bundle lives in
[`chrome-webmcp-mcp/`](chrome-webmcp-mcp/README.md). Start there for installation,
the task-isolation model, and the broker/channel design.

```
chrome-webmcp-mcp/   installable plugin (bundle patch, bridge, broker, tests, docs)
webmcp-test.html     demo page registering add_numbers / get_page_title
*.mjs, *.json        one-off CDP/WebMCP reconnaissance scripts and captures
.chrome-*/           isolated Chrome profiles (ignored by git)
```

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
- The reconnaissance scripts under this root are development history. Their
  Chrome logs (`chrome-instance-identity.txt`, `chrome-live.txt`,
  `chrome-err*.txt`) were sanitized: vendor install paths, extension ids,
  DevTools instance UUIDs, user names, and absolute paths are replaced with
  placeholders.

## License

MIT — see [LICENSE](LICENSE).
