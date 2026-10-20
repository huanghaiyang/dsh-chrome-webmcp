// End-to-end WebMCP test against an already-running Chrome.
// 1. load the test page   2. WebMCP.enable   3. collect toolsAdded   4. invokeTool
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
console.log('target:', targetId, 'session:', sessionId);

async function attempt(method, params = {}) {
  try {
    const r = await c.send(method, params, sessionId);
    console.log('OK   ' + method + ' -> ' + JSON.stringify(r).slice(0, 600));
    return { ok: true, result: r };
  } catch (e) {
    console.log('FAIL ' + method + ' -> ' + e.message);
    return { ok: false, error: e.message };
  }
}

// --- discover the WebMCP domain schema from the page session (full list, filtered) ---
const sd = await attempt('Schema.getDomains');
if (sd.ok) {
  const mcp = (sd.result.domains || []).filter((d) => /mcp/i.test(d.name));
  console.log('page-session domains total=' + sd.result.domains.length + ' mcp=' + JSON.stringify(mcp.map((d) => d.name)));
  fs.writeFileSync('webmcp-page-schema.json', JSON.stringify(mcp, null, 2));
  for (const d of mcp) {
    for (const cmd of d.commands || []) {
      console.log('  CMD ' + cmd.name + '(' + (cmd.parameters || []).map((p) => `${p.name}:${p.type || p.$ref || '?'}${p.optional ? '?' : ''}`).join(', ') + ')');
    }
    for (const e of d.events || []) {
      console.log('  EVT ' + e.name + '(' + (e.parameters || []).map((p) => `${p.name}:${p.type || p.$ref || '?'}`).join(', ') + ')');
    }
    for (const t of d.types || []) console.log('  TYPE ' + t.id + ' ' + JSON.stringify(t));
  }
}

// --- enable the domain and wait for the toolsAdded replay ---
await sleep(2500); // let the page finish registering
const en = await attempt('WebMCP.enable');
await sleep(2000);

const toolEvents = events.filter((e) => /WebMCP|toolsAdded|toolsRemoved|toolInvoked|toolResponded/i.test(e.method));
console.log('\n--- WebMCP events ---');
for (const e of toolEvents) console.log(e.method + ' ' + JSON.stringify(e.params).slice(0, 1500));

// --- page-side state ---
const st = await attempt('Runtime.evaluate', {
  expression: `JSON.stringify({ href: location.href, hasModelContext: !!navigator.modelContext, log: (document.getElementById('log')||{}).textContent })`,
  returnByValue: true,
});
if (st.ok) console.log('\npage state:', st.result.result?.value);

fs.writeFileSync('webmcp-e2e-events.json', JSON.stringify({ targetId, events }, null, 2));
console.log('\nwrote webmcp-e2e-events.json');
c.close();
