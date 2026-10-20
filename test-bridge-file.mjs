// Bridge verification on a file:// page (no long-lived server needed).
import { callTool } from './chrome-webmcp-mcp/bridge.mjs';

const FILE_URL = process.env.TEST_URL || new URL('./webmcp-test.html', import.meta.url).href;

const status = await callTool('status');
console.log('chrome reachable:', status.chromeReachable, '| webmcpDomain:', status.webmcpDomain, '| pages:', status.pageCount);

const open = await callTool('open_page', { url: FILE_URL, waitMs: 3000 });
console.log('open_page ->', open.targetId, open.url);
console.log('tools:', JSON.stringify(open.tools.map((t) => t.name)));

const add = await callTool('invoke_tool', { toolName: 'add_numbers', input: { a: 100, b: 23 }, targetId: open.targetId });
console.log('invoke add_numbers(100,23) ->', JSON.stringify(add));

const title = await callTool('invoke_tool', { toolName: 'get_page_title', targetId: open.targetId });
console.log('invoke get_page_title ->', JSON.stringify(title));

const err = await callTool('invoke_tool', { toolName: 'does_not_exist', url: 'webmcp-test' }).catch((e) => ({ expectedError: e.message }));
console.log('missing tool ->', JSON.stringify(err));

process.exit(0);
