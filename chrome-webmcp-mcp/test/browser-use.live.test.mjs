/**
 * Optional real-Chrome test for the five browser-use bridge methods
 * (snapshot / click / type_text / press_key / navigate). Skipped unless
 * `CHROME_E2E=1`.
 *
 * It drives the broker over its normal IPC contract (the same path the bridge
 * uses), against a Chrome already listening on CHROME_CDP_PORT with remote
 * debugging enabled (see README "Required Chrome flags"; `mcp__chrome__launch`
 * does this). Page state is verified independently over a second CDP connection,
 * so the assertions never trust the bridge's own report.
 *
 * Run:
 *   $env:CHROME_E2E='1'; node --test --experimental-test-isolation=none test/browser-use.live.test.mjs
 *
 * The broker runs in-process: the DSH Windows sandbox denies piped stdio spawns,
 * and an in-process broker needs no pipes. Run this file on its own so that its
 * module graph does not inherit another test file's configuration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runBroker } from '../broker.mjs';
import {
  PKG_DIR,
  connectClient,
  reserveIpcEndpoint,
  rmrf,
  uniqueStateDir,
  waitForIpc,
} from './helpers.mjs';

const ENABLED = process.env.CHROME_E2E === '1';
const PORT = Number(process.env.CHROME_CDP_PORT || 9333);
const FIXTURE1 = path.join(PKG_DIR, 'test', 'fixtures', 'browser-use.html');
const FIXTURE2 = path.join(PKG_DIR, 'test', 'fixtures', 'browser-use-2.html');

/** Parse `[12]<button ...>` lines out of a snapshot payload. */
function parseElements(snapshotText) {
  const elements = [];
  for (const line of String(snapshotText).split('\n')) {
    const match = line.match(/^\[(\d+)\]<([a-z0-9-]+)/i);
    if (match) elements.push({ index: Number(match[1]), tag: match[2].toLowerCase(), line });
  }
  return elements;
}

/** Index of the first snapshot line containing `needle`. */
function indexOf(snapshotText, needle) {
  const hit = parseElements(snapshotText).find((element) => element.line.toLowerCase().includes(needle.toLowerCase()));
  assert.ok(hit, `no snapshot element matching ${JSON.stringify(needle)} in:\n${snapshotText}`);
  return hit.index;
}

/** Minimal CDP client used only to read/verify page state out of band. */
class Verifier {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.sessions = new Map();
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('CDP websocket failed'));
    });
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const waiter = this.pending.get(message.id);
      if (waiter) {
        this.pending.delete(message.id);
        waiter(message);
      }
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }

  async session(targetId) {
    if (!this.sessions.has(targetId)) {
      const reply = await this.send('Target.attachToTarget', { targetId, flatten: true });
      assert.ok(!reply.error, `attach failed: ${JSON.stringify(reply.error)}`);
      this.sessions.set(targetId, reply.result.sessionId);
    }
    return this.sessions.get(targetId);
  }

  async evaluate(targetId, expression) {
    const sessionId = await this.session(targetId);
    const reply = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    const failure = reply.result?.exceptionDetails;
    assert.ok(!failure, `page evaluation failed: ${failure?.exception?.description || failure?.text}`);
    return reply.result?.result?.value;
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

test(
  'real Chrome: browser-use loop (snapshot/click/type_text/press_key/navigate)',
  { skip: ENABLED ? false : 'set CHROME_E2E=1 with Chrome on CHROME_CDP_PORT to run', timeout: 240000 },
  async (t) => {
    let reachable = false;
    try {
      reachable = (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
      reachable = false;
    }
    if (!reachable) {
      t.skip(`no Chrome DevTools endpoint on 127.0.0.1:${PORT}`);
      return;
    }

    const ipcName = await reserveIpcEndpoint('live-use');
    const stateDir = uniqueStateDir('live-use-state');
    const broker = await runBroker({
      ipcName,
      port: PORT,
      stateFile: path.join(stateDir, 'broker.json'),
      logFile: path.join(stateDir, 'broker.log'),
      idleMs: 60000,
      handleSignals: false,
    });

    const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const verifier = new Verifier(version.webSocketDebuggerUrl);
    await verifier.open();

    const task = `live-use-${Date.now()}`;
    const otherTask = `${task}-other`;
    let client;
    let page; // fixture 1 target handled by `task`
    let second; // fixture 2 target handled by `task`

    try {
      await waitForIpc(ipcName, { timeoutMs: 15000 });
      client = await connectClient(ipcName, { taskId: task });

      page = await client.call('open_page', { taskId: task, url: pathToFileURL(FIXTURE1).href, waitMs: 8000 });
      assert.ok(page.targetId, 'open_page returned no targetId');

      await t.test('snapshot lists numbered interactive elements and excludes hidden ones', async () => {
        const reply = await client.call('snapshot', { taskId: task, targetId: page.targetId });
        const elements = parseElements(reply.snapshot);
        assert.ok(elements.length >= 10, `too few elements: ${elements.length}\n${reply.snapshot}`);
        assert.equal(reply.elements, elements.length, 'elements count must match the payload');
        assert.ok(reply.total >= reply.elements, 'total counts every candidate');
        assert.equal(reply.truncated, false);
        assert.match(reply.snapshot, /^\[\d+\]<button/m);
        for (const needle of ['Increment', 'you@example.com', 'Sign in', 'Custom ARIA action', 'Go to page two']) {
          assert.ok(reply.snapshot.includes(needle), `missing ${needle}`);
        }
        assert.ok(reply.snapshot.includes('options="Basic | Pro"'), 'select options not summarized');
        assert.ok(!reply.snapshot.includes('Hidden button'), 'display:none element leaked');
        assert.ok(!reply.snapshot.includes('Zero size'), 'zero-size element leaked');
        assert.ok(!/In frame/i.test(reply.snapshot), 'iframe document content leaked');
      });

      await t.test('snapshot pierces open shadow roots for every host shape', async () => {
        const reply = await client.call('snapshot', { taskId: task, targetId: page.targetId });
        for (const needle of [
          'Shadow plain host inner',
          'Shadow role host inner',
          'Shadow custom host inner',
          'Shadow tabindex-1 host inner',
        ]) {
          assert.ok(reply.snapshot.includes(needle), `shadow root not pierced for ${needle}:\n${reply.snapshot}`);
        }
      });

      await t.test('snapshot never exposes password values', async () => {
        const reply = await client.call('snapshot', { taskId: task, targetId: page.targetId });
        const actual = await verifier.evaluate(page.targetId, 'document.getElementById("password").value');
        assert.equal(actual, 's3cret-value');
        assert.ok(!reply.snapshot.includes('s3cret-value'), 'password value leaked into the snapshot');
        assert.ok(/type="password"/.test(reply.snapshot), 'password field not reported at all');
      });

      await t.test('snapshot leaves the page DOM, attributes and globals untouched', async () => {
        const probe = `(() => ({
          html: document.documentElement.outerHTML,
          attrs: [...document.querySelectorAll('*')].map((e) => [...e.attributes].map((a) => a.name).join(' ')).join('|'),
          keys: Object.keys(window).sort().join(','),
        }))()`;
        const before = await verifier.evaluate(page.targetId, probe);
        await client.call('snapshot', { taskId: task, targetId: page.targetId });
        const after = await verifier.evaluate(page.targetId, probe);
        assert.equal(after.html, before.html, 'outerHTML changed');
        assert.equal(after.attrs, before.attrs, 'element attributes changed');
        assert.equal(after.keys, before.keys, 'window keys changed');
        const mainWorldRefs = await verifier.evaluate(page.targetId, 'typeof window.__dshBrowserUse');
        assert.equal(mainWorldRefs, 'undefined', 'the ref table must live only in the isolated world');
      });

      await t.test('click sends trusted events and honours clickCount', async () => {
        const before = await client.call('snapshot', { taskId: task, targetId: page.targetId });
        const index = indexOf(before.snapshot, 'Increment');
        const click = await client.call('click', { taskId: task, targetId: page.targetId, index });
        assert.equal(await verifier.evaluate(page.targetId, 'document.getElementById("count").textContent'), '1');
        assert.equal(typeof click.x, 'number');
        assert.equal(typeof click.y, 'number');

        const second = await client.call('snapshot', { taskId: task, targetId: page.targetId });
        const again = indexOf(second.snapshot, 'Increment');
        await client.call('click', {
          taskId: task, targetId: page.targetId, index: again, clickCount: 2,
        });
        assert.equal(await verifier.evaluate(page.targetId, 'document.getElementById("count").textContent'), '3');
        const trusted = await verifier.evaluate(page.targetId,
          'window.__events.filter((e) => e.type === "click").map((e) => e.trusted)');
        assert.ok(trusted.length > 0 && trusted.every(Boolean), `synthetic events: ${JSON.stringify(trusted)}`);
      });

      await t.test('a ref from an older snapshot fails with REF_NOT_FOUND', async () => {
        const stale = await client.call('snapshot', { taskId: task, targetId: page.targetId });
        const staleIndex = indexOf(stale.snapshot, 'Increment');
        await client.call('snapshot', { taskId: task, targetId: page.targetId });
        await assert.rejects(
          () => client.call('click', { taskId: task, targetId: page.targetId, index: staleIndex }),
          (error) => error.code === 'REF_NOT_FOUND',
          'a stale index must not address a different element',
        );
      });

      await t.test('index validation rejects wrong types and out-of-range values', async () => {
        const before = await verifier.evaluate(page.targetId, 'document.getElementById("count").textContent');
        for (const index of [null, '', false, true, [], {}, 1.5, -1, 2 ** 31]) {
          await assert.rejects(
            () => client.call('click', { taskId: task, targetId: page.targetId, index }),
            (error) => error.code === 'INVALID_PARAMS',
            `index ${JSON.stringify(index)} must be rejected`,
          );
        }
        assert.equal(
          await verifier.evaluate(page.targetId, 'document.getElementById("count").textContent'),
          before,
          'no click may be sent for an invalid index',
        );
      });

      await t.test('type_text fills, appends, escapes quotes and refuses disabled fields', async () => {
        const current = await client.call('snapshot', { taskId: task, targetId: page.targetId });
        const email = indexOf(current.snapshot, 'you@example.com');
        await client.call('type_text', { taskId: task, targetId: page.targetId, index: email, text: 'agent@example.com' });
        assert.equal(await verifier.evaluate(page.targetId, 'document.getElementById("email").value'), 'agent@example.com');

        await client.call('type_text', {
          taskId: task, targetId: page.targetId, index: email, text: '!', clear: false,
        });
        assert.equal(await verifier.evaluate(page.targetId, 'document.getElementById("email").value'), 'agent@example.com!');

        const payload = `x" ); throw new Error('injected'); //`;
        await client.call('type_text', { taskId: task, targetId: page.targetId, index: email, text: payload });
        assert.equal(
          await verifier.evaluate(page.targetId, 'document.getElementById("email").value'),
          payload,
          'caller text must be inserted literally, never evaluated',
        );

        const disabled = indexOf(current.snapshot, 'disabled');
        await assert.rejects(
          () => client.call('type_text', { taskId: task, targetId: page.targetId, index: disabled, text: 'nope' }),
          (error) => error.code === 'NOT_EDITABLE',
        );
        assert.equal(await verifier.evaluate(page.targetId, 'document.getElementById("disabled-input").value'), 'nope');
      });

      await t.test('type_text chooses a <select> option by label', async () => {
        const current = await client.call('snapshot', { taskId: task, targetId: page.targetId });
        const plan = indexOf(current.snapshot, 'Basic');
        await client.call('type_text', { taskId: task, targetId: page.targetId, index: plan, text: 'Pro' });
        assert.equal(await verifier.evaluate(page.targetId, 'document.getElementById("plan").value'), 'pro');
        const changes = await verifier.evaluate(page.targetId,
          'window.__events.filter((e) => e.type === "change" && e.id === "plan").length');
        assert.ok(changes > 0, 'a select change must dispatch input/change for framework bindings');
      });

      await t.test('press_key selects all, moves focus and submits with Enter', async () => {
        const current = await client.call('snapshot', { taskId: task, targetId: page.targetId });
        const email = indexOf(current.snapshot, 'you@example.com');
        await client.call('click', { taskId: task, targetId: page.targetId, index: email });
        await client.call('type_text', { taskId: task, targetId: page.targetId, index: email, text: 'hello world' });
        await client.call('press_key', { taskId: task, targetId: page.targetId, key: 'Control+A' });
        assert.equal(
          await verifier.evaluate(page.targetId,
            'document.getElementById("email").selectionEnd - document.getElementById("email").selectionStart'),
          11,
          'Control+A must select the field content',
        );
        await client.call('press_key', { taskId: task, targetId: page.targetId, key: 'Backspace' });
        assert.equal(await verifier.evaluate(page.targetId, 'document.getElementById("email").value'), '');
        await client.call('press_key', { taskId: task, targetId: page.targetId, key: 'Tab' });
        assert.equal(await verifier.evaluate(page.targetId, 'document.activeElement.id'), 'password');
        await client.call('press_key', { taskId: task, targetId: page.targetId, key: 'Enter' });
        assert.equal(await verifier.evaluate(page.targetId, 'window.__submitted === true'), true);
        await assert.rejects(
          () => client.call('press_key', { taskId: task, targetId: page.targetId, key: 'NotAKey' }),
          (error) => error.code === 'INVALID_PARAMS',
        );
      });

      await t.test('navigate reloads the tab, resets refs and rejects unsafe URLs', async () => {
        const current = await client.call('snapshot', { taskId: task, targetId: page.targetId });
        const staleIndex = indexOf(current.snapshot, 'Increment');
        const navigated = await client.call('navigate', {
          taskId: task, targetId: page.targetId, url: pathToFileURL(FIXTURE2).href,
        });
        assert.equal(navigated.url, pathToFileURL(FIXTURE2).href);
        assert.equal(await verifier.evaluate(page.targetId, 'document.title'), 'Browser Use Two');
        assert.equal(await verifier.evaluate(page.targetId, 'document.readyState'), 'complete');
        await assert.rejects(
          () => client.call('click', { taskId: task, targetId: page.targetId, index: staleIndex }),
          (error) => ['REF_NOT_FOUND', 'PAGE_CONTEXT_LOST', 'REF_STALE'].includes(error.code),
        );
        await assert.rejects(
          () => client.call('navigate', { taskId: task, targetId: page.targetId, url: 'javascript:alert(1)' }),
          (error) => error.code === 'INVALID_PARAMS',
        );
      });

      await t.test('snapshot caps rows, reports truncation and restarts ids after navigation', async () => {
        const fresh = await client.call('snapshot', { taskId: task, targetId: page.targetId });
        assert.equal(fresh.snapshotId, 1, 'a new document starts a new ref table');
        const capped = await client.call('snapshot', {
          taskId: task, targetId: page.targetId, maxElements: 5,
        });
        assert.equal(parseElements(capped.snapshot).length, 5);
        assert.equal(capped.truncated, true);
        assert.ok(capped.total > 5);
        const defaulted = await client.call('snapshot', { taskId: task, targetId: page.targetId });
        assert.equal(parseElements(defaulted.snapshot).length, 200, 'default cap is 200');
      });

      await t.test('another task cannot perceive or drive this task\'s page', async () => {
        await client.call('open_page', { taskId: otherTask, url: pathToFileURL(FIXTURE2).href, waitMs: 8000 });
        const attempts = [
          ['snapshot', { taskId: otherTask, targetId: page.targetId }],
          ['click', { taskId: otherTask, targetId: page.targetId, index: 0 }],
          ['type_text', { taskId: otherTask, targetId: page.targetId, index: 0, text: 'x' }],
          ['press_key', { taskId: otherTask, targetId: page.targetId, key: 'Enter' }],
          ['navigate', { taskId: otherTask, targetId: page.targetId, url: 'about:blank' }],
        ];
        for (const [method, params] of attempts) {
          await assert.rejects(
            () => client.call(method, params),
            (error) => error.code === 'TARGET_OTHER_TASK',
            `${method} must not reach another task's page`,
          );
        }
      });

      await t.test('a user-owned tab may be perceived, but actions must name it', async () => {
        // Create a tab outside the bridge: no task owns it, exactly like a tab the
        // user opened. `Target.createTarget` goes straight to Chrome.
        const created = await verifier.send('Target.createTarget', { url: pathToFileURL(FIXTURE1).href });
        assert.ok(!created.error, `createTarget failed: ${JSON.stringify(created.error)}`);
        const userTab = created.result.targetId;
        try {
          for (let attempt = 0; attempt < 40; attempt += 1) {
            const ready = await verifier.evaluate(userTab, 'document.readyState');
            if (ready === 'complete') break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          assert.equal(await verifier.evaluate(userTab, 'document.title'), 'Browser Use Fixture');

          // A fresh task that owns nothing can still perceive an unowned tab…
          const stranger = `live-stranger-${Date.now()}`;
          const perceived = await client.call('snapshot', { taskId: stranger });
          assert.ok(perceived.targetId, 'snapshot must resolve an unowned page implicitly');

          // …but no action may run without naming the page.
          for (const [method, params] of [
            ['click', { index: 0 }],
            ['type_text', { index: 0, text: 'x' }],
            ['press_key', { key: 'Enter' }],
            ['navigate', { url: 'about:blank' }],
          ]) {
            await assert.rejects(
              () => client.call(method, { taskId: stranger, ...params }),
              (error) => error.code === 'TARGET_ID_REQUIRED',
              `${method} must refuse to pick an unowned page implicitly`,
            );
          }

          // Naming it explicitly is the allowed path, and it really reaches the page.
          await client.call('snapshot', { taskId: stranger, targetId: userTab });
          const before = await verifier.evaluate(userTab, 'document.getElementById("count").textContent');
          const clicked = await client.call('click', {
            taskId: stranger, targetId: userTab, index: indexOf(
              (await client.call('snapshot', { taskId: stranger, targetId: userTab })).snapshot, 'Increment',
            ),
          });
          assert.equal(clicked.action, 'click');
          assert.equal(
            await verifier.evaluate(userTab, 'document.getElementById("count").textContent'),
            String(Number(before) + 1),
            'an explicitly named unowned page must be drivable',
          );
        } finally {
          await verifier.send('Target.closeTarget', { targetId: userTab });
        }
      });

      await t.test('close_task is scoped to this task and leaves Chrome running', async () => {
        const closed = await client.call('close_task', { taskId: task });
        assert.deepEqual([...closed.closedTargetIds].sort(), [page.targetId, second?.targetId].filter(Boolean).sort());
        const status = await client.call('status', { taskId: task });
        assert.equal(status.task.pages.length, 0);
        const otherStatus = await client.call('status', { taskId: otherTask });
        assert.ok(otherStatus.task.pages.length > 0, 'the other task keeps its page');
        assert.equal(otherStatus.chrome.reachable, true, 'Chrome must stay alive');
      });
    } finally {
      try {
        client?.close();
      } catch {
        /* ignore */
      }
      verifier.close();
      await broker.close().catch(() => {});
      rmrf(stateDir);
    }
  },
);
