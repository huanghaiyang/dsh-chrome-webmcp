// Launch an isolated Chrome with WebMCP enabled and probe the CDP domain surface.
// NOTE: stdio must be 'ignore' (not 'pipe') — piped child stdio is blocked by the
// Windows file sandbox; Chrome's own output is not needed here.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9333);
const UDD = path.join(import.meta.dirname, '.chrome-webmcp');
fs.mkdirSync(UDD, { recursive: true });

const features = process.env.FEATURES || 'WebMCP';
const extra = (process.env.EXTRA_ARGS || '').split(' ').filter(Boolean);
const args = [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${UDD}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-sync',
  `--enable-features=${features}`,
  ...extra,
  'about:blank',
];

console.log('features:', features);
console.log('extra   :', extra.join(' ') || '(none)');
const child = spawn(CHROME, args, { stdio: 'ignore', detached: false });
console.log('chrome pid:', child.pid);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForVersion(timeoutMs = 30000) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
      last = 'http ' + r.status;
    } catch (e) { last = e.message; }
    await sleep(300);
  }
  throw new Error('devtools endpoint never came up: ' + last);
}

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', (e) => rej(new Error('ws error: ' + (e.message || 'unknown'))), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  on(fn) { this.ws.addEventListener('message', fn); }
  close() { try { this.ws.close(); } catch {} }
}

let browser;
let ok = false;
try {
  const version = await waitForVersion();
  console.log('Browser        :', version.Browser);
  console.log('Protocol       :', version['Protocol-Version']);
  console.log('User-Agent     :', version['User-Agent']);

  browser = new CDP(version.webSocketDebuggerUrl);
  await browser.connect();

  const { domains } = await browser.send('Schema.getDomains');
  const names = domains.map((d) => d.name);
  console.log('\nTotal CDP domains:', names.length);
  const mcpDomains = domains.filter((d) => /mcp/i.test(d.name));
  console.log('MCP-related domains:', JSON.stringify(mcpDomains.map((d) => d.name)));

  for (const d of mcpDomains) {
    console.log('\n=== DOMAIN ' + d.name + ' (v' + d.version + ', experimental=' + !!d.experimental + ') ===');
    for (const c of d.commands || []) {
      console.log('  CMD  ' + c.name + '(' + (c.parameters || []).map((p) => `${p.name}:${p.type || '?'}${p.optional ? '?' : ''}`).join(', ') + ')' +
        ' -> ' + ((c.returns || []).map((p) => `${p.name}:${p.type || '?'}`).join(', ') || 'void'));
    }
    for (const e of d.events || []) {
      console.log('  EVT  ' + e.name + '(' + (e.parameters || []).map((p) => `${p.name}:${p.type || '?'}`).join(', ') + ')');
    }
    for (const t of d.types || []) {
      console.log('  TYPE ' + t.id + ' = ' + JSON.stringify(t));
    }
  }

  fs.writeFileSync('webmcp-schema.json', JSON.stringify({ browser: version.Browser, domainCount: names.length, mcpDomains, allNames: names }, null, 2));
  console.log('\nwrote webmcp-schema.json');
  ok = true;
} catch (err) {
  console.error('PROBE ERROR:', err.message);
} finally {
  try { browser?.close(); } catch {}
  await sleep(400);
  try { child.kill(); } catch {}
  await sleep(1500);
  if (!ok) process.exitCode = 1;
}
