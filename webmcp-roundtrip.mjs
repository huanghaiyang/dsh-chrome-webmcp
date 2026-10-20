// Full WebMCP round trip: page registers tools via document.modelContext,
// CDP client enables the frame-scoped WebMCP domain, observes toolsAdded, invokes a tool.
import fs from 'node:fs';
import { CDP, version } from './cdp-client.mjs';

const PORT = Number(process.env.CDP_PORT || 9333);
const TEST_URL = process.env.TEST_URL || 'http://127.0.0.1:8788/webmcp-test.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const v = await version();
console.log('Browser:', v.Browser);
const c = new CDP(v.webSocketDebuggerUrl);
await c.connect();
const events = [];
c.ws.addEventListener('message', (ev) => {
  const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
  if (m.method) events.push(m);
});

const { targetId } = await c.send('Target.createTarget', { url: TEST_URL });
const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
console.log('target:', targetId);

async function attempt(method, params = {}, sess = sessionId, quiet = false) {
  try {
    const r = await c.send(method, params, sess);
    if (!quiet) console.log('OK   ' + method + ' -> ' + JSON.stringify(r).slice(0, 500));
    return { ok: true, result: r };
  } catch (e) {
    console.log('FAIL ' + method + ' ' + JSON.stringify(params).slice(0, 200) + ' -> ' + e.message);
    return { ok: false, error: e.message };
  }
}

// 1. enable the frame-scoped domain, then let the page register
await sleep(1200);
await attempt('WebMCP.enable');
await sleep(2500);

// 2. what did the domain report?
const wmEvents = events.filter((e) => /^WebMCP\./.test(e.method));
console.log('\n--- WebMCP domain events (' + wmEvents.length + ') ---');
for (const e of wmEvents) console.log(e.method + ' ' + JSON.stringify(e.params).slice(0, 2000));

// 3. page state
const st = await attempt('Runtime.evaluate', {
  expression: `JSON.stringify({ title: document.title, hasMc: !!document.modelContext, log: (document.getElementById('log')||{}).textContent })`,
  returnByValue: true,
}, sessionId);
if (st.ok) console.log('\npage:', st.result.result?.value);

// 4. try to invoke a tool (parameter shapes unknown -> probe several)
console.log('\n--- invokeTool attempts ---');
const shapes = [
  { toolName: 'add_numbers', input: { a: 2, b: 3 } },
  { toolName: 'add_numbers', arguments: { a: 2, b: 3 } },
  { name: 'add_numbers', input: { a: 2, b: 3 } },
  { tool: 'add_numbers', input: { a: 2, b: 3 } },
  { toolName: 'add_numbers', toolArguments: { a: 2, b: 3 } },
  { toolName: 'add_numbers', params: { a: 2, b: 3 } },
  { toolName: 'add_numbers' },
];
for (const s of shapes) {
  const r = await attempt('WebMCP.invokeTool', s);
  if (r.ok) { console.log('   ^^ SUCCESS with', JSON.stringify(s)); break; }
}

await sleep(1500);
const st2 = await attempt('Runtime.evaluate', {
  expression: `JSON.stringify({ log: (document.getElementById('log')||{}).textContent })`,
  returnByValue: true,
}, sessionId);
if (st2.ok) console.log('\npage after invoke:', st2.result.result?.value);

const all = events.filter((e) => /^WebMCP\./.test(e.method));
console.log('\n--- WebMCP events after invoke (' + all.length + ') ---');
for (const e of all) console.log(e.method + ' ' + JSON.stringify(e.params).slice(0, 2000));

fs.writeFileSync('webmcp-roundtrip.json', JSON.stringify({ targetId, events: all }, null, 2));
console.log('\nwrote webmcp-roundtrip.json');
c.close();
