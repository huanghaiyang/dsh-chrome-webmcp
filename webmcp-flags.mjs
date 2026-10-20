// Ask Chrome itself which WebMCP-related flags exist and what state they are in,
// and test whether enabling the CDP domain before navigation exposes the page API.
import fs from 'node:fs';
import { CDP, version } from './cdp-client.mjs';

const PORT = Number(process.env.CDP_PORT || 9333);
const TEST_URL = process.env.TEST_URL || 'http://127.0.0.1:8788/webmcp-test.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const v = await version();
const c = new CDP(v.webSocketDebuggerUrl);
await c.connect();

// ---------- 1. chrome://flags ----------
const flagsTarget = await c.send('Target.createTarget', { url: 'chrome://flags' });
const flagsSess = (await c.send('Target.attachToTarget', { targetId: flagsTarget.targetId, flatten: true })).sessionId;
await sleep(2500);
const flagsEval = await (async () => {
  try {
    return await c.send('Runtime.evaluate', {
      expression: `(() => {
        const nodes = [...document.querySelectorAll('div.experiment, .experiment')];
        const hit = nodes.filter(e => /mcp/i.test(e.textContent || ''));
        return JSON.stringify({
          totalExperiments: nodes.length,
          matches: hit.map(e => {
            const sel = e.querySelector('select');
            return {
              id: e.id,
              selectValue: sel ? sel.value : null,
              options: sel ? [...sel.options].map(o => o.value + ' | ' + o.text) : [],
              text: (e.textContent || '').replace(/\\s+/g, ' ').slice(0, 400),
            };
          }),
        });
      })()`,
      returnByValue: true,
    }, flagsSess);
  } catch (e) { return { error: e.message }; }
})();
console.log('=== chrome://flags (WebMCP entries) ===');
console.log(flagsEval.result?.value ?? JSON.stringify(flagsEval));
if (flagsEval.result?.value) {
  const parsed = JSON.parse(flagsEval.result.value);
  if (!parsed.totalExperiments) {
    const txt = await c.send('Runtime.evaluate', { expression: 'document.body.innerText.slice(0,1200)', returnByValue: true }, flagsSess);
    console.log('flags page text:', txt.result?.value);
  }
}
await c.send('Target.closeTarget', { targetId: flagsTarget.targetId });

// ---------- 2. enable domain BEFORE navigation ----------
const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
console.log('\n=== enable-before-navigate test ===');
try { console.log('WebMCP.enable ->', JSON.stringify(await c.send('WebMCP.enable', {}, sessionId))); }
catch (e) { console.log('WebMCP.enable FAILED', e.message); }
await c.send('Page.enable', {}, sessionId);
await c.send('Page.navigate', { url: TEST_URL }, sessionId);
await sleep(3000);
const st = await c.send('Runtime.evaluate', {
  expression: `JSON.stringify({ href: location.href, hasModelContext: !!navigator.modelContext, log: (document.getElementById('log')||{}).textContent })`,
  returnByValue: true,
}, sessionId);
console.log('page state after enable-then-navigate:', st.result?.value);

// also check an about:blank document
const blankSt = await c.send('Runtime.evaluate', {
  expression: `JSON.stringify({ mc: typeof navigator.modelContext, keys: Object.getOwnPropertyNames(navigator).filter(k=>/context|mcp|model/i.test(k)) })`,
  returnByValue: true,
}, sessionId);
console.log('navigator probe:', blankSt.result?.value);

fs.writeFileSync('webmcp-flags.json', JSON.stringify({ flags: flagsEval.result?.value ?? flagsEval }, null, 2));
c.close();
