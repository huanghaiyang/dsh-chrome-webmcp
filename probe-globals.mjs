// Enumerate every WebMCP-ish global/property on a live page.
import { CDP, version } from './cdp-client.mjs';

const PORT = Number(process.env.CDP_PORT || 9333);
const TEST_URL = process.env.TEST_URL || 'http://127.0.0.1:8788/webmcp-test.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const v = await version();
const c = new CDP(v.webSocketDebuggerUrl);
await c.connect();

const { targetId } = await c.send('Target.createTarget', { url: TEST_URL });
const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
await c.send('WebMCP.enable', {}, sessionId).catch((e) => console.log('enable failed', e.message));
await sleep(2500);

const probe = `(() => {
  const filt = (o) => Object.getOwnPropertyNames(o).filter(k => /model|mcp|context|tool/i.test(k)).sort();
  let fp = null;
  try { fp = document.featurePolicy.allowedFeatures().filter(f => /model|mcp|context|tool/i.test(f)).sort(); }
  catch (e) { fp = 'error: ' + e.message; }
  const names = ['modelContext','modelContextTesting','mcp','ai','agent','tools'];
  const globals = {};
  for (const n of names) {
    globals['navigator.' + n] = typeof navigator[n];
    globals['window.' + n] = typeof window[n];
    globals['document.' + n] = typeof document[n];
  }
  return JSON.stringify({
    url: location.href,
    isSecureContext,
    crossOriginIsolated,
    navigatorProto: filt(Navigator.prototype),
    documentProto: filt(Document.prototype),
    windowMatches: filt(window),
    globals,
    allowedFeaturesMatching: fp,
  }, null, 1);
})()`;

const r = await c.send('Runtime.evaluate', { expression: probe, returnByValue: true }, sessionId);
console.log(r.result?.value ?? JSON.stringify(r));
c.close();
