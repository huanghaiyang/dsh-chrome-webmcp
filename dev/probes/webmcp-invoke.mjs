// Invoke a page-registered WebMCP tool through the CDP WebMCP domain.
import fs from 'node:fs';
import { CDP, version } from './cdp-client.mjs';

const PORT = Number(process.env.CDP_PORT || 9333);
const TEST_URL = process.env.TEST_URL || 'http://127.0.0.1:8788/webmcp-test.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const v = await version();
const c = new CDP(v.webSocketDebuggerUrl);
await c.connect();
const events = [];
c.ws.addEventListener('message', (ev) => {
  const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
  if (m.method) events.push(m);
});

const { targetId } = await c.send('Target.createTarget', { url: TEST_URL });
const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
await sleep(1200);
await c.send('WebMCP.enable', {}, sessionId);
await sleep(2500);

const added = events.filter((e) => e.method === 'WebMCP.toolsAdded');
const tools = added.flatMap((e) => e.params.tools || []);
console.log('discovered tools:', JSON.stringify(tools.map((t) => ({ name: t.name, frameId: t.frameId }))));
const frameId = tools[0]?.frameId;
console.log('frameId:', frameId);

async function invoke(params) {
  try {
    const r = await c.send('WebMCP.invokeTool', params, sessionId);
    console.log('OK   invokeTool ' + JSON.stringify(params) + ' -> ' + JSON.stringify(r).slice(0, 800));
    return { ok: true, result: r };
  } catch (e) {
    console.log('FAIL invokeTool ' + JSON.stringify(params).slice(0, 220) + ' -> ' + e.message);
    return { ok: false, error: e.message };
  }
}

const shapes = [
  { frameId, toolName: 'add_numbers', input: { a: 2, b: 3 } },
  { frameId, name: 'add_numbers', input: { a: 2, b: 3 } },
  { frameId, toolName: 'add_numbers', arguments: { a: 2, b: 3 } },
  { frameId, toolName: 'add_numbers', params: { a: 2, b: 3 } },
  { frameId, tool: 'add_numbers', input: { a: 2, b: 3 } },
  { frameId, toolName: 'add_numbers' },
];
let winner = null;
for (const s of shapes) {
  const r = await invoke(s);
  if (r.ok) { winner = s; break; }
}

await sleep(2000);
console.log('\n--- all WebMCP events ---');
for (const e of events.filter((x) => /^WebMCP\./.test(x.method))) {
  console.log(e.method + ' ' + JSON.stringify(e.params).slice(0, 1200));
}

const st = await c.send('Runtime.evaluate', {
  expression: `JSON.stringify({ title: document.title, log: (document.getElementById('log')||{}).textContent })`,
  returnByValue: true,
}, sessionId);
console.log('\npage log:\n' + st.result?.value);

fs.writeFileSync('webmcp-invoke.json', JSON.stringify({ targetId, frameId, winner, events: events.filter((x) => /^WebMCP\./.test(x.method)) }, null, 2));
console.log('wrote webmcp-invoke.json');
c.close();
