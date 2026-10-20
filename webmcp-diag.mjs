// Diagnose the WebMCP CDP domain on a page session of an already-running Chrome.
import fs from 'node:fs';
import { CDP, version } from './cdp-client.mjs';

const PORT = Number(process.env.CDP_PORT || 9333);
const TEST_URL = process.env.TEST_URL || new URL('./webmcp-test.html', import.meta.url).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const v = await version();
console.log('Browser:', v.Browser, '| ws:', v.webSocketDebuggerUrl);
const c = new CDP(v.webSocketDebuggerUrl);
await c.connect();
const allEvents = [];
c.ws.addEventListener('message', (ev) => {
  const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
  if (m.method) allEvents.push(m);
});

// 1. create a fresh page target for the test file
const { targetId } = await c.send('Target.createTarget', { url: TEST_URL });
console.log('created target:', targetId);
const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
console.log('sessionId:', sessionId);

async function attempt(method, params = {}) {
  try {
    const r = await c.send(method, params, sessionId);
    console.log('OK   ' + method + ' -> ' + JSON.stringify(r).slice(0, 800));
    return { ok: true, result: r };
  } catch (e) {
    console.log('FAIL ' + method + ' -> ' + e.message);
    return { ok: false, error: e.message };
  }
}

console.log('\n--- schema discovery ---');
await attempt('Schema.getDomains');
await attempt('Schema.getDomains', {});

console.log('\n--- WebMCP domain ---');
await attempt('WebMCP.enable');
await sleep(1500);

console.log('\n--- page state ---');
const evalRes = await attempt('Runtime.evaluate', {
  expression: `JSON.stringify({ href: location.href, hasModelContext: !!navigator.modelContext, log: document.getElementById('log') ? document.getElementById('log').textContent : null })`,
  returnByValue: true,
  awaitPromise: false,
});
if (evalRes.ok) console.log('page:', evalRes.result.result?.value);

console.log('\n--- WebMCP commands to try ---');
for (const m of ['WebMCP.getTools', 'WebMCP.tools', 'WebMCP.getRegisteredTools']) {
  await attempt(m);
}

console.log('\n--- collected events ---');
for (const e of allEvents) console.log(e.method, JSON.stringify(e.params || {}).slice(0, 700));

fs.writeFileSync('webmcp-probe-result.json', JSON.stringify({ version: v.Browser, targetId, events: allEvents }, null, 2));
c.close();
