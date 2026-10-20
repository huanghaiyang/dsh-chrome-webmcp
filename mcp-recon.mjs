import fs from 'node:fs';
import path from 'node:path';

const targets = process.argv.slice(2);
const hits = new Map(); // string -> Set(file)

function scanBuffer(buf, file) {
  const needle = [0x6d, 0x63, 0x70]; // 'm','c','p'
  for (let i = 0; i + 2 < buf.length; i++) {
    if ((buf[i] | 0x20) !== needle[0]) continue;
    if ((buf[i + 1] | 0x20) !== needle[1]) continue;
    if ((buf[i + 2] | 0x20) !== needle[2]) continue;
    // extract printable run around it, max 96 chars
    let s = i;
    while (s > 0 && i - s < 48 && buf[s - 1] >= 0x20 && buf[s - 1] < 0x7f) s--;
    let e = i;
    while (e < buf.length && e - s < 96 && buf[e] >= 0x20 && buf[e] < 0x7f) e++;
    const str = buf.toString('latin1', s, e).trim();
    if (str.length < 4) continue;
    if (!/mcp/i.test(str)) continue;
    if (!hits.has(str)) hits.set(str, new Set());
    hits.get(str).add(file);
  }
}

for (const t of targets) {
  if (!fs.existsSync(t)) { console.log('MISSING', t); continue; }
  const st = fs.statSync(t);
  if (st.isDirectory()) {
    for (const f of fs.readdirSync(t, { withFileTypes: true })) {
      console.log('DIRENT', path.join(t, f.name), f.isDirectory() ? '<dir>' : st2(path.join(t, f.name)));
    }
    continue;
  }
  const buf = fs.readFileSync(t);
  scanBuffer(buf, t);
  console.log('SCANNED', t, buf.length, 'bytes');
}

function st2(p) { try { return fs.statSync(p).size; } catch { return 0; } }

const interesting = [...hits.entries()]
  .filter(([s]) => /mcp/i.test(s))
  .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));

console.log('\n=== MCP-ish strings: ' + interesting.length + ' ===');
for (const [s, files] of interesting.slice(0, 400)) {
  console.log(JSON.stringify(s), '|', [...files].map(f => path.basename(f)).join(','));
}
