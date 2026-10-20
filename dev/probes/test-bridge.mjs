// In-process test of the bridge tool handlers (no child processes: the file
// sandbox blocks piped child stdio, so the MCP stdio loop is exercised in-process).
import { callTool, toolDefinitions, config } from '../../chrome-webmcp-mcp/bridge.mjs';

const show = (label, v) => console.log('\n### ' + label + '\n' + JSON.stringify(v, null, 2).slice(0, 2500));

console.log('broker endpoint:', config.ipc);
show('tools/list', toolDefinitions().map((t) => t.name));

show('status', await callTool('status'));
show('list_tools (127.0.0.1:8788)', await callTool('list_tools', { url: '127.0.0.1:8788' }));
show('invoke add_numbers(7,35)', await callTool('invoke_tool', { toolName: 'add_numbers', input: { a: 7, b: 35 }, url: '127.0.0.1:8788' }));
show('invoke get_page_title', await callTool('invoke_tool', { toolName: 'get_page_title', url: '127.0.0.1:8788' }));
show('open_page', await callTool('open_page', { url: 'http://127.0.0.1:8788/webmcp-test.html' }));
