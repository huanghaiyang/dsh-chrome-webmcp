// Gracefully close a Chrome instance through CDP (browser-level endpoint).
import { CDP, version } from './cdp-client.mjs';
const v = await version();
console.log('closing browser:', v.Browser, v.webSocketDebuggerUrl);
const c = new CDP(v.webSocketDebuggerUrl);
await c.connect();
try {
  await Promise.race([
    c.send('Browser.close'),
    new Promise((r) => setTimeout(() => r('timeout'), 3000)),
  ]);
  console.log('Browser.close sent');
} catch (e) {
  console.log('close error (expected if connection drops):', e.message);
}
c.close();
