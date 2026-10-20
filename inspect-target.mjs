// Inspect one existing target: page log + WebMCP API availability.
import { CDP, version } from './cdp-client.mjs';

const targetId = process.argv[2];
const v = await version();
const c = new CDP(v.webSocketDebuggerUrl);
await c.connect();
const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
const r = await c.send('Runtime.evaluate', {
  expression: `JSON.stringify({
    url: location.href,
    readyState: document.readyState,
    hasDocumentModelContext: typeof document.modelContext,
    hasNavigatorModelContext: typeof navigator.modelContext,
    log: (document.getElementById('log') || {}).textContent || null
  })`,
  returnByValue: true,
}, sessionId);
console.log(r.result?.value);
c.close();
process.exit(0);
