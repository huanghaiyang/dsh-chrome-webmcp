// Dump printable strings surrounding key WebMCP markers in chrome.dll,
// to find the exact base::Feature / Blink runtime-feature names.
import fs from 'node:fs';
const file = process.argv[2];
const markers = process.argv.slice(3);
const buf = fs.readFileSync(file);

function stringsIn(start, end) {
  const out = [];
  let i = start;
  while (i < end) {
    if (buf[i] >= 0x20 && buf[i] < 0x7f) {
      let s = i;
      while (s < end && buf[s] >= 0x20 && buf[s] < 0x7f) s++;
      if (s - i >= 4) out.push(buf.toString('latin1', i, s));
      i = s;
    } else i++;
  }
  return out;
}

for (const m of markers) {
  const mb = Buffer.from(m, 'latin1');
  let idx = -1;
  const hits = [];
  while ((idx = buf.indexOf(mb, idx + 1)) !== -1) hits.push(idx);
  console.log('\n########## marker ' + JSON.stringify(m) + ' : ' + hits.length + ' hit(s)');
  for (const h of hits.slice(0, 4)) {
    const list = stringsIn(Math.max(0, h - 1600), Math.min(buf.length, h + 1600));
    console.log('  @' + h + ' neighborhood (' + list.length + ' strings):');
    for (const s of list) console.log('    ' + JSON.stringify(s.slice(0, 120)));
  }
}
