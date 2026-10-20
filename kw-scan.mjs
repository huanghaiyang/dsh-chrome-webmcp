import fs from 'node:fs';
const file = process.argv[2];
const kws = process.argv.slice(3).map((k) => k.toLowerCase());
const buf = fs.readFileSync(file);
const out = new Set();
for (let i = 0; i < buf.length; i++) {
  const c = buf[i] | 0x20;
  if (c < 0x61 || c > 0x7a) continue;
  let s = i;
  while (s > 0 && buf[s - 1] >= 0x20 && buf[s - 1] < 0x7f && i - s < 40) s--;
  let e = i;
  while (e < buf.length && buf[e] >= 0x20 && buf[e] < 0x7f && e - s < 90) e++;
  const str = buf.toString('latin1', s, e);
  if (str.length < 5 || str.length > 90) continue;
  const low = str.toLowerCase();
  if (kws.some((k) => low.includes(k))) out.add(str);
}
console.log('=== ' + file + ' : ' + out.size + ' matches ===');
for (const s of [...out].sort()) console.log(JSON.stringify(s));
