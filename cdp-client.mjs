// Pure-network CDP client: connects to an already-running Chrome (no process spawn).
import fs from 'node:fs';

const PORT = Number(process.env.CDP_PORT || 9333);
const MODE = process.env.MODE || 'domains';

export class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.events = []; }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', () => rej(new Error('ws connect failed to ' + this.url)), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.method + ' ' + JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
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
  close() { try { this.ws.close(); } catch {} }
}

export async function version() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
  if (!r.ok) throw new Error('bad status ' + r.status);
  return r.json();
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const v = await version();
  console.log('Browser   :', v.Browser);
  console.log('Protocol  :', v['Protocol-Version']);
  console.log('ws URL    :', v.webSocketDebuggerUrl);

  const c = new CDP(v.webSocketDebuggerUrl);
  await c.connect();

  if (MODE === 'domains') {
    const { domains } = await c.send('Schema.getDomains');
    const names = domains.map((d) => d.name);
    console.log('\ntotal domains:', names.length);
    const mcp = domains.filter((d) => /mcp/i.test(d.name));
    console.log('MCP domains  :', JSON.stringify(mcp.map((d) => d.name)));
    for (const d of mcp) {
      console.log('\n### ' + d.name + ' v' + d.version + ' experimental=' + !!d.experimental);
      for (const cmd of d.commands || []) {
        console.log('CMD ' + cmd.name + '(' + (cmd.parameters || []).map((p) => `${p.name}:${p.type || '?'}${p.optional ? '?' : ''}`).join(', ') + ')' +
          ' -> ' + ((cmd.returns || []).map((p) => `${p.name}:${p.type || '?'}`).join(', ') || 'void'));
      }
      for (const e of d.events || []) {
        console.log('EVT ' + e.name + '(' + (e.parameters || []).map((p) => `${p.name}:${p.type || '?'}`).join(', ') + ')');
      }
      for (const t of d.types || []) console.log('TYPE ' + t.id + ' ' + JSON.stringify(t));
    }
    fs.writeFileSync('webmcp-schema.json', JSON.stringify({ browser: v.Browser, domains: mcp, allNames: names }, null, 2));
    console.log('\nwrote webmcp-schema.json');
  } else if (MODE === 'targets') {
    const { targetInfos } = await c.send('Target.getTargets');
    console.log(JSON.stringify(targetInfos, null, 2));
  } else if (MODE === 'catalog') {
    const { domains } = await c.send('Schema.getDomains');
    console.log(domains.map((d) => d.name).sort().join('\n'));
  }
  c.close();
}
