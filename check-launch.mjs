// Read the launched browser's real command line + one target's WebMCP API state.
import { CDP, version } from './cdp-client.mjs';

const targetId = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const v = await version();
const c = new CDP(v.webSocketDebuggerUrl);
await c.connect();

const ver = await c.send('Target.createTarget', { url: 'chrome://version' });
const s1 = (await c.send('Target.attachToTarget', { targetId: ver.targetId, flatten: true })).sessionId;
await sleep(3000);
const t = (await c.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, s1)).result?.value || '';
for (const line of t.split('\n')) {
  if (/^命令行|^Command Line/.test(line)) console.log('CMDLINE:', line.slice(0, 500));
  if (/^个人资料路径|^Profile Path/.test(line)) console.log('PROFILE:', line);
}
await c.send('Target.closeTarget', { targetId: ver.targetId });

if (targetId) {
  const s2 = (await c.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  const r = await c.send('Runtime.evaluate', {
    expression: `JSON.stringify({ mc: typeof document.modelContext, log: (document.getElementById('log')||{}).textContent })`,
    returnByValue: true,
  }, s2);
  console.log('TARGET:', r.result?.value);
}
c.close();
process.exit(0);
