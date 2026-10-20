// Identify the browser behind the DevTools endpoint: open chrome://version and read its profile path.
import { CDP, version } from './cdp-client.mjs';
import fs from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const v = await version();
console.log('browser:', v.Browser, v.webSocketDebuggerUrl);
const c = new CDP(v.webSocketDebuggerUrl);
await c.connect();
const { targetId } = await c.send('Target.createTarget', { url: 'chrome://version' });
const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
await sleep(3000);
const r = await c.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, sessionId);
const text = r.result?.value || '';
const pick = (label) => (text.split('\n').find((l) => l.startsWith(label)) || '').trim();
console.log('Profile Path :', pick('Profile Path'));
console.log('Command Line :', pick('Command Line').slice(0, 400));
console.log('Executable   :', pick('Executable Path'));
fs.writeFileSync('chrome-instance-identity.txt', text);
await c.send('Target.closeTarget', { targetId });
c.close();
process.exit(0);
