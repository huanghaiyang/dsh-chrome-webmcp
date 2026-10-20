import fs from 'node:fs';

const file = process.argv[2];
const buf = fs.readFileSync(file);
const out = new Set();
const W = Number(process.argv[3] ?? 140);

for (let i = 0; i + 2 < buf.length; i++) {
  if ((buf[i] | 0x20) !== 0x6d) continue;         // m
  if ((buf[i + 1] | 0x20) !== 0x63) continue;     // c
  if ((buf[i + 2] | 0x20) !== 0x70) continue;     // p
  let s = i;
  while (s > 0 && i - s < W && buf[s - 1] >= 0x20 && buf[s - 1] < 0x7f) s--;
  let e = i;
  while (e < buf.length && e - s < W * 2 && buf[e] >= 0x20 && buf[e] < 0x7f) e++;
  const str = buf.toString('latin1', s, e);
  if (str.length < 6) continue;
  // keep only strings that look like protocol / API identifiers
  if (!/(WebMCP|modelContext|webmcp|McpTool|mcpTool|registerTool|provideContext|invokeTool|mcp[._-]|MCP)/.test(str)) continue;
  out.add(str);
}

console.log('=== ' + file + ' : ' + out.size + ' candidate strings ===');
for (const s of [...out].sort()) console.log(JSON.stringify(s));
