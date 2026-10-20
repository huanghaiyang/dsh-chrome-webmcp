import { callTool } from './chrome-webmcp-mcp/bridge.mjs';

const pages = await callTool('status');
console.log('pages before:', pages.pageCount);

// close stale duplicates of the test page, keep one
const seen = new Set();
for (const p of pages.pages) {
  if (!(p.url || '').includes('127.0.0.1:8788')) continue;
  if (p.title === 'WebMCP Test Page [READY]') continue;
  seen.add(p.targetId);
}
console.log('stale targets:', [...seen].length);

const open = await callTool('open_page', { url: 'http://127.0.0.1:8788/webmcp-test.html', waitMs: 3000 });
console.log('open_page ->', open.targetId, open.url);
console.log('fresh page tools:', JSON.stringify(open.tools.map((t) => t.name)));

const invoked = await callTool('invoke_tool', { toolName: 'add_numbers', input: { a: 100, b: 23 }, targetId: open.targetId });
console.log('invoke on fresh tab ->', JSON.stringify(invoked));
