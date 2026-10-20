// Fetch the authoritative CDP protocol description and print the WebMCP domain.
import fs from 'node:fs';
const PORT = Number(process.env.CDP_PORT || 9333);

const res = await fetch(`http://127.0.0.1:${PORT}/json/protocol`);
if (!res.ok) throw new Error('protocol fetch failed: ' + res.status);
const proto = await res.json();
console.log('protocol version:', proto.version?.major + '.' + proto.version?.minor, '| domains:', proto.domains.length);

const mcp = proto.domains.filter((d) => /mcp/i.test(d.name));
console.log('MCP-related domains:', JSON.stringify(mcp.map((d) => d.name)));

for (const d of mcp) {
  console.log('\n### ' + d.domain + '  experimental=' + !!d.experimental);
  for (const c of d.commands || []) {
    console.log('CMD ' + c.name + '(' + (c.parameters || []).map((p) => `${p.name}:${ref(p)}${p.optional ? '?' : ''}`).join(', ') + ')' +
      ' -> ' + ((c.returns || []).map((p) => `${p.name}:${ref(p)}`).join(', ') || 'void'));
  }
  for (const e of d.events || []) {
    console.log('EVT ' + e.name + '(' + (e.parameters || []).map((p) => `${p.name}:${ref(p)}`).join(', ') + ')');
  }
  console.log('--- raw domain JSON ---');
  console.log(JSON.stringify(d, null, 2));
}

function ref(p) {
  if (p.type) return p.type + (p.items ? '<' + (p.items.type || p.items.$ref) + '>' : '');
  if (p.$ref) return p.$ref;
  return '?';
}

fs.writeFileSync('webmcp-protocol.json', JSON.stringify({ version: proto.version, mcpDomains: mcp }, null, 2));
console.log('\nwrote webmcp-protocol.json');
