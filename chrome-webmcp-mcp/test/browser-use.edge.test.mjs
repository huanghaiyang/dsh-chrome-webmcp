/**
 * Edge-case tests for the five browser-use MCP tools:
 * snapshot / click / type_text / press_key / navigate.
 *
 * Layering (what each test can actually prove):
 * - Unit tests at the bottom of this file call the real builders exported by
 *   lib/page-scripts.mjs (`clampMaxElements`, `snapshotExpression`, `clickExpression`).
 *   That is the only place where the injected script's literal text is inspected.
 * - End-to-end tests run the real bridge (worker-thread stdio host, see
 *   test/mcp-session.mjs), the real broker in-process, and the fake CDP endpoint
 *   (test/fake-cdp.mjs). They therefore cover bridge param forwarding ->
 *   broker validation -> lib/pages.mjs -> CDP traffic -> error text mapping.
 *
 * Fidelity limits of the hermetic fake (read this before trusting an assertion):
 * - `Runtime.evaluate` returns canned `browserUse.*` values; the page scripts are
 *   never executed. So "the page rejected this index" is simulated with
 *   `fake.configurePage(targetId, { clickResult: {...} })` — the test pins the
 *   mapping of a page-side `reason` to a tool error code, not the page-side check.
 * - The fake's `Page.navigate` clears session execution contexts but does not
 *   reset its `browserUse` bookkeeping. A real navigation destroys the isolated
 *   world, so real pages restart indices at 0 (docs/IPC.md "Snapshot semantics").
 *   Index restart across a real navigation is therefore NOT asserted here.
 *
 * Sandbox note: this DSH Windows file sandbox denies `child_process.spawn` with
 * piped stdio (EPERM), which is why the suite must run with
 * `node --test --experimental-test-isolation=none`, and why the bridge runs in a
 * Worker thread driven through PassThrough streams instead of a child process.
 * The fake CDP server and the broker IPC endpoint use their own ephemeral ports
 * and a temp state dir: no test here touches a real Chrome (e.g. port 9333).
 *
 * Run with:
 *   node --test --experimental-test-isolation=none test/browser-use.edge.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { startFakeCdp } from './fake-cdp.mjs';
import { runBroker } from '../broker.mjs';
import { clampMaxElements, clickExpression, snapshotExpression } from '../lib/page-scripts.mjs';
import {
  BRIDGE_ENTRY,
  randomTag,
  reserveIpcEndpoint,
  rmrf,
  sleep,
  uniqueStateDir,
  waitForIpc,
} from './helpers.mjs';

const TEST_TIMEOUT = 30000;
const TASK_A = 'edge-a';
const TASK_B = 'edge-b';
/** select-all modifier mask + key text, mirroring lib/pages.mjs typeText. */
const SELECT_ALL_MODIFIER = process.platform === 'darwin' ? 4 : 2;

const URL_A = 'https://edge.example/a';
const URL_B = 'https://edge.example/b';

let fake;
let broker;
let worker;
let client;
let stateDir;
/** Page owned by TASK_A: the main action target. */
let targetA;
/** Page owned by TASK_B: used for cross-task isolation checks. */
let targetB;

// ---------------------------------------------------------------------------
// MCP client over a Worker-hosted `startStdioServer`.
// Same harness as test/mcp.test.mjs (copied: mcp.test.mjs is a test file and
// importing it would register its tests again).
// ---------------------------------------------------------------------------

class McpWorkerClient {
  constructor(workerInstance) {
    this.worker = workerInstance;
    this.pending = new Map();
    this.nextId = 0;
    this.rawLines = [];
    this.buffer = '';
    this.worker.on('message', (message) => this.#onWorkerMessage(message));
    this.worker.on('error', (error) => this.#rejectAll(error));
    this.worker.on('exit', (code) => {
      if (code !== 0) this.#rejectAll(new Error(`bridge worker exited with code ${code}`));
    });
  }

  #rejectAll(error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }

  #onWorkerMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'error') {
      this.#rejectAll(new Error(message.message));
      return;
    }
    if (message.type !== 'out') return;
    this.buffer += message.chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      this.rawLines.push(line);
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (frame && typeof frame.id !== 'undefined' && !frame.method) {
        const entry = this.pending.get(frame.id);
        if (!entry) continue;
        this.pending.delete(frame.id);
        clearTimeout(entry.timer);
        if (frame.error) {
          const error = new Error(frame.error.message || 'MCP error');
          error.rpcError = frame.error;
          error.code = frame.error.code;
          entry.reject(error);
        } else {
          entry.resolve(frame.result);
        }
        continue;
      }
    }
  }

  #write(message) {
    this.worker.postMessage({ type: 'frame', data: JSON.stringify(message) });
  }

  request(method, params = {}, { timeoutMs = 25000 } = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params = {}) {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  callTool(name, args = {}) {
    return this.request('tools/call', { name, arguments: args });
  }

  end() {
    try {
      this.worker.postMessage({ type: 'end' });
    } catch {
      /* already terminated */
    }
  }
}

/** JSON payload carried by a tool result. */
function toolJson(result, what) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content.find((item) => item?.type === 'text')?.text;
  if (typeof text === 'string') {
    try {
      return JSON.parse(text);
    } catch {
      /* fall through */
    }
  }
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  assert.fail(`${what}: tool result has no JSON payload: ${JSON.stringify(result)}`);
}

/** Text carried by a tool result (success or error). */
function toolText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

/** `[CODE]` prefix of an MCP tool error, or undefined. */
function toolErrorCode(result) {
  return toolText(result).match(/^Error \[([A-Z0-9_]+)\]/m)?.[1];
}

/**
 * Assert one tool call failed with an expected broker error code.
 * Returns the full error text so callers can assert on the hint as well.
 */
async function expectToolError(toolName, args, { code, match } = {}) {
  const result = await client.callTool(toolName, args);
  assert.equal(
    result.isError,
    true,
    `${toolName} ${JSON.stringify(args)} must be a tool error, got: ${toolText(result)}`,
  );
  const text = toolText(result);
  assert.equal(
    toolErrorCode(result),
    code,
    `${toolName} expected error [${code}], got: ${text}`,
  );
  if (match) assert.match(text, match, `${toolName} error text should match ${match}: ${text}`);
  return text;
}

/** Snapshot helper that fails loudly on a tool error. */
async function snapshotPage(taskId, targetId, extra = {}) {
  const result = await client.callTool('snapshot', { taskId, targetId, ...extra });
  assert.ok(!result.isError, `snapshot failed: ${toolText(result)}`);
  return toolJson(result, 'snapshot');
}

// ---------------------------------------------------------------------------
// Fake-CDP inspection helpers (the fake keeps its sessions public).
// ---------------------------------------------------------------------------

/** Live CDP sessions attached to one target (WebMCP session + browser-use session). */
function fakeSessionIds(targetId) {
  return [...fake.sessions.values()]
    .filter((session) => session.targetId === targetId)
    .map((session) => session.sessionId);
}

/**
 * Simulate an unannounced reload: the execution contexts of every session on the
 * target are destroyed while the broker's cached contextId stays stale. This is
 * the exact CDP-visible symptom of `Page.reload` / a user navigation, without
 * going through the broker (which would invalidate its own cache first).
 */
function destroyTargetWorlds(targetId) {
  let cleared = 0;
  for (const session of fake.sessions.values()) {
    if (session.targetId !== targetId) continue;
    session.contexts.clear();
    cleared += 1;
  }
  assert.ok(cleared > 0, `expected at least one CDP session attached to ${targetId}`);
}

/** Mouse / key events recorded for one target since `from`. */
function mouseEventsSince(from, targetId) {
  return fake.stats.input.mouse.slice(from).filter((event) => event.targetId === targetId);
}
function keyEventsSince(from, targetId) {
  return fake.stats.input.keys.slice(from).filter((event) => event.targetId === targetId);
}
function textEventsSince(from, targetId) {
  return fake.stats.input.text.slice(from).filter((event) => event.targetId === targetId);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function waitForWorkerReady(workerInstance, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('bridge worker did not become ready'));
    }, timeoutMs);
    timer.unref?.();
    const onMessage = (message) => {
      if (message?.type === 'ready') {
        cleanup();
        resolve();
      } else if (message?.type === 'error') {
        cleanup();
        reject(new Error(message.message));
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`bridge worker exited with code ${code} before ready`));
    };
    function cleanup() {
      clearTimeout(timer);
      workerInstance.off('message', onMessage);
      workerInstance.off('error', onError);
      workerInstance.off('exit', onExit);
    }
    workerInstance.on('message', onMessage);
    workerInstance.on('error', onError);
    workerInstance.on('exit', onExit);
  });
}

before(async () => {
  fake = await startFakeCdp({ slowMs: 0 });
  const ipcName = await reserveIpcEndpoint('edge');
  stateDir = uniqueStateDir('edge-state');

  // Explicit broker: the bridge only has to find a listening IPC endpoint, and
  // teardown stays deterministic. actionSettleMs 0 keeps the suite fast.
  broker = await runBroker({
    ipcName,
    port: fake.port,
    stateFile: path.join(stateDir, 'broker.json'),
    logFile: path.join(stateDir, 'broker.log'),
    ownershipFile: path.join(stateDir, 'ownership.json'),
    idleMs: 120000,
    settleMs: 200,
    invokeWaitMs: 8000,
    actionSettleMs: 0,
    navigateWaitMs: 3000,
    handleSignals: false,
  });
  await waitForIpc(ipcName, { timeoutMs: 10000 });

  worker = new Worker(new URL('./mcp-session.mjs', import.meta.url), {
    workerData: {
      bridgeUrl: pathToFileURL(BRIDGE_ENTRY).href,
      env: {
        CHROME_CDP_PORT: String(fake.port),
        CHROME_WEBMCP_IPC: ipcName,
        CHROME_WEBMCP_STATE_DIR: stateDir,
        CHROME_WEBMCP_BROKER_IDLE_MS: '120000',
        CHROME_WEBMCP_START_WAIT_MS: '15000',
        CHROME_TOOL_SETTLE_MS: '200',
        CHROME_INVOKE_WAIT_MS: '8000',
        CHROME_ACTION_SETTLE_MS: '0',
      },
    },
  });
  await waitForWorkerReady(worker);
  client = new McpWorkerClient(worker);

  const init = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'edge-test', version: randomTag() },
  });
  assert.equal(init.serverInfo?.name, 'chrome-webmcp', 'fixture talks to the real bridge');
  client.notify('notifications/initialized');

  const openedA = await client.callTool('open_page', { url: URL_A, taskId: TASK_A });
  assert.ok(!openedA.isError, `open_page(${TASK_A}) failed: ${toolText(openedA)}`);
  targetA = toolJson(openedA, 'open_page').targetId;

  const openedB = await client.callTool('open_page', { url: URL_B, taskId: TASK_B });
  assert.ok(!openedB.isError, `open_page(${TASK_B}) failed: ${toolText(openedB)}`);
  targetB = toolJson(openedB, 'open_page').targetId;
});

after(async () => {
  try {
    client?.end();
  } catch {
    /* ignore */
  }
  // Give the bridge a beat to flush frames before the worker is torn down.
  await sleep(20);
  await worker?.terminate().catch(() => {});
  if (broker) await broker.close().catch(() => {});
  await fake?.close().catch(() => {});
  rmrf(stateDir);
});

// ---------------------------------------------------------------------------
// Unit level: the injected-script builders (real product output).
// ---------------------------------------------------------------------------

test('snapshot expression clamps maxElements to the documented 1..2000 window', () => {
  // Contract: docs/IPC.md "maxElements defaults to 200 and is capped at 2000";
  // invalid values fall back to the default instead of failing the tool call.
  assert.equal(clampMaxElements(undefined), 200, 'missing maxElements uses the default');
  assert.equal(clampMaxElements(0), 200, '0 falls back to the default');
  assert.equal(clampMaxElements(-5), 200, 'negative falls back to the default');
  assert.equal(clampMaxElements(Number.NaN), 200, 'NaN falls back to the default');
  assert.equal(clampMaxElements('nope'), 200, 'non-numeric falls back to the default');
  assert.equal(clampMaxElements(1), 1);
  assert.equal(clampMaxElements(1.9), 1, 'fractions are floored');
  assert.equal(clampMaxElements('50'), 50, 'numeric strings are accepted');
  assert.equal(clampMaxElements(2000), 2000, 'the documented cap is inclusive');
  assert.equal(clampMaxElements(5000), 2000, 'values above the cap are clamped');

  for (const [value, limit] of [
    [undefined, 200],
    [0, 200],
    [5000, 2000],
    [37, 37],
  ]) {
    assert.ok(
      snapshotExpression({ maxElements: value }).includes(`var LIMIT = ${limit};`),
      `snapshotExpression(maxElements=${String(value)}) must inject LIMIT ${limit}`,
    );
  }
  assert.ok(
    snapshotExpression().includes('var LIMIT = 200;'),
    'the zero-argument call keeps the 200 default',
  );
});

test('snapshot/click expressions keep the stale-index contract', () => {
  const snapshotExpr = snapshotExpression({ maxElements: 10 });
  // A snapshot installs a *fresh* ref table and hands out the next monotone indices.
  assert.match(snapshotExpr, /var refs = new Map\(\);/, 'each snapshot starts a new ref table');
  assert.match(snapshotExpr, /state\.refs = refs;/, 'the new ref table replaces the old one');
  assert.match(snapshotExpr, /var index = state\.nextIndex;/, 'indices come from nextIndex');
  assert.match(snapshotExpr, /state\.nextIndex \+= 1;/, 'nextIndex only moves forward');

  // A click on an index the latest snapshot never produced reports REF_NOT_FOUND:
  // once when no snapshot exists, once when the index is missing from the table.
  const clickExpr = clickExpression({ index: 7 });
  assert.match(clickExpr, /var INDEX = 7;/, 'the requested index is embedded as a literal');
  assert.equal(
    (clickExpr.match(/reason: 'REF_NOT_FOUND'/g) || []).length,
    2,
    'both "no snapshot yet" and "index not in the latest snapshot" are REF_NOT_FOUND',
  );
});

test('click expression rejects indices outside the int32 window', () => {
  // This is where an oversized (but integer) index dies today: clickExpression
  // throws a RangeError, which is what the E2E test below observes as a code leak.
  assert.throws(() => clickExpression({ index: -1 }), RangeError);
  assert.throws(() => clickExpression({ index: 1.5 }), RangeError);
  assert.throws(() => clickExpression({ index: 2 ** 31 }), RangeError, 'INT32_MAX + 1');
  assert.doesNotThrow(() => clickExpression({ index: 2 ** 31 - 1 }), 'INT32_MAX is addressable');
});

// ---------------------------------------------------------------------------
// snapshot: index monotonicity across snapshots
// ---------------------------------------------------------------------------

test('repeated snapshots advance snapshotId and never reuse element indices', async () => {
  // NOTE: the numbering itself is produced by the fake page's contract
  // (test/fake-cdp.mjs increments nextIndex by 2 per snapshot). What this test
  // proves on the product side: the broker forwards snapshotId/text/elements
  // unchanged and the loop that agents rely on (snapshot -> index -> snapshot)
  // stays monotone as presented to the model.
  const first = await snapshotPage(TASK_A, targetA);
  const second = await snapshotPage(TASK_A, targetA);

  assert.equal(second.snapshotId, first.snapshotId + 1, 'snapshotId advances by exactly one');
  assert.equal(first.elements, 2);
  assert.equal(second.elements, 2);
  assert.equal(first.truncated, false);
  assert.equal(second.taskId, TASK_A);
  assert.equal(second.targetId, targetA);
  assert.equal(second.url, fake.getTarget(targetA).url);

  const indicesOf = (snapshot) => [...snapshot.snapshot.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  const firstIndices = indicesOf(first);
  const secondIndices = indicesOf(second);
  assert.equal(firstIndices.length, first.elements);
  assert.equal(secondIndices.length, second.elements);
  assert.equal(
    new Set(firstIndices).size,
    firstIndices.length,
    'a single snapshot never repeats an index',
  );
  assert.deepEqual(
    firstIndices.filter((index) => secondIndices.includes(index)),
    [],
    'no index is handed out twice across snapshots',
  );
  assert.ok(
    Math.max(...firstIndices) < Math.min(...secondIndices),
    'indices increase monotonically across snapshots',
  );
  assert.equal(
    Math.min(...secondIndices),
    Math.max(...firstIndices) + 1,
    'a new snapshot continues from nextIndex without gaps',
  );
});

// ---------------------------------------------------------------------------
// click: stale index mapping + index validation
// ---------------------------------------------------------------------------

test('click on an index missing from the latest snapshot surfaces REF_NOT_FOUND', async () => {
  // The page-side check itself lives in the injected script and is not executed
  // by the hermetic fake; this pins the mapping lib/pages.mjs actionError applies.
  await snapshotPage(TASK_A, targetA);
  fake.configurePage(targetA, {
    clickResult: {
      ok: false,
      reason: 'REF_NOT_FOUND',
      detail: 'index 0 is not part of the latest snapshot',
    },
  });
  try {
    await expectToolError(
      'click',
      { taskId: TASK_A, targetId: targetA, index: 0 },
      { code: 'REF_NOT_FOUND', match: /take a new snapshot/ },
    );
    // An index that is in range but was never returned by any snapshot behaves the same.
    await expectToolError(
      'click',
      { taskId: TASK_A, targetId: targetA, index: 999 },
      { code: 'REF_NOT_FOUND', match: /index 0 is not part of the latest snapshot/ },
    );
  } finally {
    fake.configurePage(targetA, { clickResult: null });
  }
});

test('click rejects malformed indices before sending any CDP input', async () => {
  const mouseBefore = fake.stats.input.mouse.length;
  for (const index of [-1, 1.5, 'abc', 2.5]) {
    await expectToolError(
      'click',
      { taskId: TASK_A, targetId: targetA, index },
      { code: 'INVALID_PARAMS', match: /index must be a non-negative integer from snapshot/ },
    );
  }
  // Missing index entirely (the MCP schema marks it required; the bridge forwards,
  // the broker validates).
  await expectToolError('click', { taskId: TASK_A, targetId: targetA }, {
    code: 'INVALID_PARAMS',
    match: /index must be a non-negative integer from snapshot/,
  });
  assert.equal(
    fake.stats.input.mouse.length,
    mouseBefore,
    'an invalid index must be rejected before any Input.dispatchMouseEvent',
  );

  // Numeric strings are intentionally accepted (broker.mjs requireIndex comment).
  const from = fake.stats.input.mouse.length;
  const asString = await client.callTool('click', {
    taskId: TASK_A,
    targetId: targetA,
    index: '0',
  });
  assert.ok(!asString.isError, `index "0" must be accepted: ${toolText(asString)}`);
  assert.equal(toolJson(asString, 'click').index, 0);
  assert.ok(mouseEventsSince(from, targetA).length > 0);
});

test('click rejects non-numeric index types instead of coercing them', async () => {
  // Number(null)===0, Number('')===0, Number(false)===0, Number([])===0 and
  // Number(true)===1, but the MCP schema declares `index` as an integer. The
  // current validate path is `requireIndex` (broker.mjs) with `Number(value)`, so
  // these types are silently accepted: `null`/`""`/`false`/`[]` click element 0
  // and `true` clicks element 1. That is the "wrong element" class of failure the
  // index contract exists to prevent, so every one of them must be INVALID_PARAMS.
  const mouseBefore = fake.stats.input.mouse.length;
  const observed = [];
  for (const index of [null, '', false, [], true]) {
    const result = await client.callTool('click', { taskId: TASK_A, targetId: targetA, index });
    observed.push({
      index: JSON.stringify(index),
      isError: result.isError === true,
      code: toolErrorCode(result) ?? `SUCCESS(index=${toolJson(result, 'click').index})`,
    });
  }
  assert.deepEqual(
    observed.map((entry) => entry.code),
    ['INVALID_PARAMS', 'INVALID_PARAMS', 'INVALID_PARAMS', 'INVALID_PARAMS', 'INVALID_PARAMS'],
    `non-integer indices must be rejected with INVALID_PARAMS, observed: ${JSON.stringify(observed)}`,
  );
  assert.equal(
    fake.stats.input.mouse.length,
    mouseBefore,
    'a coercible non-integer must not cause a click on a different element',
  );
});

test('an index above INT32_MAX reports INVALID_PARAMS, not INTERNAL', async () => {
  // 2^31 is an integer >= 0, so broker.mjs requireIndex accepts it. The
  // RangeError raised by clickExpression/typeExpression (lib/page-scripts.mjs)
  // then escapes unwrapped all the way to errorToJson, which labels it INTERNAL.
  const mouseBefore = fake.stats.input.mouse.length;
  const textBefore = fake.stats.input.text.length;
  const observed = [];
  for (const [toolName, args] of [
    ['click', { index: 2 ** 31 }],
    ['type_text', { index: 2 ** 31, text: 'x' }],
  ]) {
    const result = await client.callTool(toolName, { taskId: TASK_A, targetId: targetA, ...args });
    observed.push({
      tool: toolName,
      isError: result.isError === true,
      code: toolErrorCode(result) ?? 'SUCCESS',
      text: toolText(result).split('\n')[0],
    });
  }
  assert.deepEqual(
    observed.map((entry) => entry.code),
    ['INVALID_PARAMS', 'INVALID_PARAMS'],
    `an unaddressable index must be a parameter error, observed: ${JSON.stringify(observed)}`,
  );
  assert.equal(fake.stats.input.mouse.length, mouseBefore);
  assert.equal(fake.stats.input.text.length, textBefore);
});

test('click passes button and clickCount through to CDP and clamps them', async () => {
  // right button, double click -> two press/release pairs with rising clickCount.
  let from = fake.stats.input.mouse.length;
  const double = toolJson(
    await client.callTool('click', {
      taskId: TASK_A,
      targetId: targetA,
      index: 0,
      button: 'right',
      clickCount: 2,
    }),
    'click right x2',
  );
  assert.equal(double.button, 'right');
  assert.equal(double.clickCount, 2);

  const events = mouseEventsSince(from, targetA);
  assert.deepEqual(
    events.map((event) => event.type),
    ['mouseMoved', 'mousePressed', 'mouseReleased', 'mousePressed', 'mouseReleased'],
    'one move, then one press/release pair per clickCount',
  );
  const presses = events.filter((event) => event.type === 'mousePressed');
  const releases = events.filter((event) => event.type === 'mouseReleased');
  assert.deepEqual(presses.map((event) => event.clickCount), [1, 2]);
  assert.ok(
    presses.every((event) => event.button === 'right' && event.buttons === 2),
    'right button uses the 2 bit in the pressed buttons mask',
  );
  assert.deepEqual(releases.map((event) => event.clickCount), [1, 2]);
  assert.ok(
    releases.every((event) => event.button === 'right' && event.buttons === 0),
    'releases carry buttons: 0',
  );
  assert.equal(events[0].button, 'none', 'the hover move carries no button');

  // Unknown button falls back to left; clickCount 9 clamps to the documented 3.
  from = fake.stats.input.mouse.length;
  const clamped = toolJson(
    await client.callTool('click', {
      taskId: TASK_A,
      targetId: targetA,
      index: 0,
      button: 'bogus',
      clickCount: 9,
    }),
    'click bogus x9',
  );
  assert.equal(clamped.button, 'left', 'an unknown button degrades to left');
  assert.equal(clamped.clickCount, 3, 'clickCount is capped at 3');
  const clampedPresses = mouseEventsSince(from, targetA).filter((e) => e.type === 'mousePressed');
  assert.deepEqual(clampedPresses.map((event) => event.clickCount), [1, 2, 3]);
  assert.ok(clampedPresses.every((event) => event.button === 'left' && event.buttons === 1));

  // clickCount 0 clamps up to 1; middle button uses the 4 bit.
  from = fake.stats.input.mouse.length;
  const middle = toolJson(
    await client.callTool('click', {
      taskId: TASK_A,
      targetId: targetA,
      index: 0,
      button: 'middle',
      clickCount: 0,
    }),
    'click middle x0',
  );
  assert.equal(middle.clickCount, 1, 'clickCount is floored at 1');
  const middlePresses = mouseEventsSince(from, targetA).filter((e) => e.type === 'mousePressed');
  assert.equal(middlePresses.length, 1);
  assert.equal(middlePresses[0].buttons, 4, 'middle button uses the 4 bit');
});

// ---------------------------------------------------------------------------
// type_text: append path, select branches, not-editable
// ---------------------------------------------------------------------------

test('type_text clear:false appends without select-all; the default clears first', async () => {
  const keysBefore = fake.stats.input.keys.length;
  const textBefore = fake.stats.input.text.length;

  const appended = toolJson(
    await client.callTool('type_text', {
      taskId: TASK_A,
      targetId: targetA,
      index: 1,
      text: 'tail',
      clear: false,
    }),
    'type_text clear:false',
  );
  assert.equal(appended.mode, 'typed');
  assert.equal(appended.cleared, false);
  assert.equal(appended.text, 'tail');
  assert.deepEqual(
    textEventsSince(textBefore, targetA).map((event) => event.text),
    ['tail'],
  );
  assert.equal(
    keyEventsSince(keysBefore, targetA).length,
    0,
    'clear:false must not send the select-all combination',
  );

  // Default clear=true: select-all first, then insertText replaces the selection.
  const defaultKeysFrom = fake.stats.input.keys.length;
  const defaultTextFrom = fake.stats.input.text.length;
  const replaced = toolJson(
    await client.callTool('type_text', {
      taskId: TASK_A,
      targetId: targetA,
      index: 1,
      text: 'fresh',
    }),
    'type_text default clear',
  );
  assert.equal(replaced.cleared, true);
  assert.deepEqual(
    textEventsSince(defaultTextFrom, targetA).map((event) => event.text),
    ['fresh'],
  );
  const clearKeys = keyEventsSince(defaultKeysFrom, targetA);
  assert.deepEqual(
    clearKeys.map((event) => event.type),
    ['rawKeyDown', 'keyUp'],
    'the select-all combination sends no char event',
  );
  assert.ok(
    clearKeys.every((event) => event.modifiers === SELECT_ALL_MODIFIER),
    `select-all must carry the platform modifier mask (${SELECT_ALL_MODIFIER})`,
  );
  assert.equal(clearKeys[0].key, 'a');
  assert.equal(clearKeys[0].code, 'KeyA');
});

test('type_text on a <select> with an unknown option fails OPTION_NOT_FOUND', async () => {
  const textBefore = fake.stats.input.text.length;
  fake.configurePage(targetA, {
    typeResult: {
      ok: false,
      reason: 'OPTION_NOT_FOUND',
      options: ['Basic', 'Pro'],
      detail: 'no option matches "Enterprise"',
    },
  });
  try {
    const text = await expectToolError(
      'type_text',
      { taskId: TASK_A, targetId: targetA, index: 2, text: 'Enterprise' },
      { code: 'OPTION_NOT_FOUND', match: /no option in the select matches the requested text/ },
    );
    assert.match(text, /no option matches "Enterprise"/, 'the page-side detail is forwarded');
    assert.equal(
      fake.stats.input.text.length,
      textBefore,
      'a failed select must not insert any text',
    );
  } finally {
    fake.configurePage(targetA, { typeResult: null });
  }
});

test('type_text on a read-only field fails NOT_EDITABLE', async () => {
  fake.configurePage(targetA, {
    typeResult: { ok: false, reason: 'NOT_EDITABLE', detail: 'the field is read-only' },
  });
  try {
    await expectToolError(
      'type_text',
      { taskId: TASK_A, targetId: targetA, index: 1, text: 'nope' },
      { code: 'NOT_EDITABLE', match: /does not accept text input/ },
    );
  } finally {
    fake.configurePage(targetA, { typeResult: null });
  }
});

// ---------------------------------------------------------------------------
// press_key: combinations, unknown keys
// ---------------------------------------------------------------------------

test('press_key sends combinations and rejects unknown keys with INVALID_PARAMS', async () => {
  const keysBefore = fake.stats.input.keys.length;
  const combo = toolJson(
    await client.callTool('press_key', {
      taskId: TASK_A,
      targetId: targetA,
      key: 'Control+A',
    }),
    'press_key Control+A',
  );
  assert.equal(combo.action, 'press_key');
  assert.deepEqual(combo.modifiers, ['Control']);

  const comboEvents = keyEventsSince(keysBefore, targetA);
  assert.deepEqual(
    comboEvents.map((event) => event.type),
    ['rawKeyDown', 'keyUp'],
    'a modified combination produces no char event',
  );
  assert.ok(comboEvents.every((event) => event.modifiers === 2), 'Control is modifier bit 2');
  assert.equal(comboEvents[0].key, 'a');
  assert.equal(comboEvents[0].code, 'KeyA');
  assert.equal(comboEvents[0].windowsVirtualKeyCode, 65);

  // Shift+Tab: named key with a modifier, still no char event.
  const shiftFrom = fake.stats.input.keys.length;
  const shifted = toolJson(
    await client.callTool('press_key', { taskId: TASK_A, targetId: targetA, key: 'Shift+Tab' }),
    'press_key Shift+Tab',
  );
  assert.deepEqual(shifted.modifiers, ['Shift']);
  const shiftEvents = keyEventsSince(shiftFrom, targetA);
  assert.deepEqual(shiftEvents.map((event) => event.type), ['rawKeyDown', 'keyUp']);
  assert.equal(shiftEvents[0].key, 'Tab');
  assert.equal(shiftEvents[0].code, 'Tab');
  assert.equal(shiftEvents[0].modifiers, 8, 'Shift is modifier bit 8');

  // Unknown keys: the product documents INVALID_PARAMS (there is no INVALID_KEY).
  const rejectedFrom = fake.stats.input.keys.length;
  for (const key of ['F1', 'Hyper+A', 'Control+', 'Alt+Hyper+A']) {
    await expectToolError(
      'press_key',
      { taskId: TASK_A, targetId: targetA, key },
      { code: 'INVALID_PARAMS', match: /unsupported key/ },
    );
  }
  await expectToolError('press_key', { taskId: TASK_A, targetId: targetA, key: '' }, {
    code: 'INVALID_PARAMS',
    match: /key must be a non-empty string/,
  });
  assert.equal(
    fake.stats.input.keys.length,
    rejectedFrom,
    'rejected key names must not reach Input.dispatchKeyEvent',
  );
});

// ---------------------------------------------------------------------------
// navigate: URL validation, about:blank, timeout, post-navigation behaviour
// ---------------------------------------------------------------------------

test('navigate rejects unsupported URL schemes and accepts about:blank', async () => {
  const navigationsBefore = fake.stats.navigations;
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'not-a-url']) {
    await expectToolError('navigate', { taskId: TASK_A, targetId: targetA, url }, {
      code: 'INVALID_PARAMS',
      match: /url must be an http\(s\), file, or about URL/,
    });
  }
  await expectToolError('navigate', { taskId: TASK_A, targetId: targetA, url: '' }, {
    code: 'INVALID_PARAMS',
    match: /url must be a non-empty string/,
  });
  await expectToolError('navigate', { taskId: TASK_A, targetId: targetA }, {
    code: 'INVALID_PARAMS',
    match: /url must be a non-empty string/,
  });
  assert.equal(
    fake.stats.navigations,
    navigationsBefore,
    'rejected URLs must not reach Page.navigate',
  );

  const blank = toolJson(
    await client.callTool('navigate', {
      taskId: TASK_A,
      targetId: targetA,
      url: 'about:blank',
    }),
    'navigate about:blank',
  );
  assert.equal(blank.action, 'navigate');
  assert.equal(blank.requestedUrl, 'about:blank');
  assert.equal(blank.url, 'about:blank');
  assert.equal(blank.loaded, true);
  assert.equal(fake.getTarget(targetA).url, 'about:blank', 'Chrome really navigated');

  // A tool-driven navigation invalidates the isolated world; the next action must
  // rebuild it transparently (no PAGE_CONTEXT_LOST for a known navigation).
  const snap = await snapshotPage(TASK_A, targetA);
  assert.equal(snap.url, 'about:blank');
  const clicked = await client.callTool('click', { taskId: TASK_A, targetId: targetA, index: 0 });
  assert.ok(!clicked.isError, `click after navigate failed: ${toolText(clicked)}`);
});

test('navigate reports NAVIGATION_TIMEOUT when the document never completes', async () => {
  fake.configurePage(targetA, { readyState: 'loading' });
  try {
    await expectToolError(
      'navigate',
      { taskId: TASK_A, targetId: targetA, url: 'https://edge.example/never-loads', waitMs: 250 },
      { code: 'NAVIGATION_TIMEOUT', match: /did not finish loading within 250 ms/ },
    );
  } finally {
    fake.configurePage(targetA, { readyState: 'complete' });
  }
  // The failed navigation still left the target on the requested URL.
  assert.equal(fake.getTarget(targetA).url, 'https://edge.example/never-loads');
  const back = await client.callTool('navigate', { taskId: TASK_A, targetId: targetA, url: URL_A });
  assert.ok(!back.isError, `navigate back failed: ${toolText(back)}`);
});

// ---------------------------------------------------------------------------
// No page available: NO_PAGE does not exist; the product uses TARGET_NOT_FOUND.
// ---------------------------------------------------------------------------

test('every browser-use tool fails TARGET_NOT_FOUND for a task with no pages', async () => {
  // "edge-empty" owns nothing. Every fake page was created through open_page, so
  // it is task-owned and cannot leak in as an unowned candidate.
  const argsByTool = {
    snapshot: {},
    click: { index: 0 },
    type_text: { index: 0, text: 'x' },
    press_key: { key: 'Enter' },
    navigate: { url: 'https://edge.example/empty' },
  };
  for (const [toolName, args] of Object.entries(argsByTool)) {
    // There is no NO_PAGE code in the product: pageFor() raises TARGET_NOT_FOUND.
    await expectToolError(
      toolName,
      { taskId: 'edge-empty', ...args },
      { code: 'TARGET_NOT_FOUND', match: /has no page to act on; call open_page or list_tools first/ },
    );
  }
  // An explicit but unknown targetId is a different flavour of TARGET_NOT_FOUND.
  await expectToolError('snapshot', { taskId: TASK_A, targetId: 'T-does-not-exist' }, {
    code: 'TARGET_NOT_FOUND',
    match: /does not exist/,
  });
  // A url filter that matches nothing leaves no candidate either.
  await expectToolError('snapshot', { taskId: TASK_A, url: 'no-such-url-fragment-xyz' }, {
    code: 'TARGET_NOT_FOUND',
  });
});

test('snapshot without targetId picks the most recently opened page of the task', async () => {
  const taskId = 'edge-pick';
  const opened1 = await client.callTool('open_page', {
    url: 'https://edge.example/pick-1',
    taskId,
  });
  assert.ok(!opened1.isError, `open_page failed: ${toolText(opened1)}`);
  const pick1 = toolJson(opened1, 'open_page').targetId;
  const opened2 = await client.callTool('open_page', {
    url: 'https://edge.example/pick-2',
    taskId,
  });
  assert.ok(!opened2.isError, `open_page failed: ${toolText(opened2)}`);
  const pick2 = toolJson(opened2, 'open_page').targetId;

  try {
    const newest = await snapshotPage(taskId, undefined);
    assert.equal(newest.targetId, pick2, 'the newest owned page wins when targetId is omitted');
    assert.equal(newest.url, 'https://edge.example/pick-2');

    const filtered = await snapshotPage(taskId, undefined, { url: 'pick-1' });
    assert.equal(filtered.targetId, pick1, 'the url filter selects among owned pages');

    const filteredNewest = await snapshotPage(taskId, undefined, { url: 'pick-' });
    assert.equal(filteredNewest.targetId, pick2, 'url filters keep newest-first order');

    // Snapshot has no `ambiguous` flag; invoke_tool is the only tool that reports
    // ambiguity. Documenting that absence here keeps the contract explicit.
    assert.equal('ambiguous' in newest, false, 'snapshot does not report ambiguity');
  } finally {
    const closed = await client.callTool('close', { taskId });
    assert.ok(!closed.isError, `close(${taskId}) failed: ${toolText(closed)}`);
    assert.deepEqual(
      [...toolJson(closed, 'close').closedTargetIds].sort(),
      [pick1, pick2].sort(),
    );
  }
});

test('task isolation: every browser-use tool rejects another task\'s page', async () => {
  const navigationsBefore = fake.stats.navigations;
  const mouseBefore = fake.stats.input.mouse.length;
  const keysBefore = fake.stats.input.keys.length;
  const cases = [
    ['snapshot', { taskId: TASK_B, targetId: targetA }],
    ['click', { taskId: TASK_B, targetId: targetA, index: 0 }],
    ['type_text', { taskId: TASK_B, targetId: targetA, index: 1, text: 'stolen' }],
    ['press_key', { taskId: TASK_B, targetId: targetA, key: 'Enter' }],
    ['navigate', { taskId: TASK_B, targetId: targetA, url: 'https://edge.example/stolen' }],
  ];
  for (const [toolName, args] of cases) {
    await expectToolError(toolName, args, {
      code: 'TARGET_OTHER_TASK',
      match: new RegExp(`belongs to task "${TASK_A}"`),
    });
  }
  assert.equal(fake.stats.navigations, navigationsBefore, 'no cross-task navigation reached CDP');
  assert.equal(fake.stats.input.mouse.length, mouseBefore, 'no cross-task click reached CDP');
  assert.equal(fake.stats.input.keys.length, keysBefore, 'no cross-task key reached CDP');
  // The owning task can still act on the same page afterwards.
  const stillMine = await snapshotPage(TASK_A, targetA);
  assert.equal(stillMine.targetId, targetA);
  assert.ok(targetB, 'fixture sanity: the other task owns its own page');
});

// ---------------------------------------------------------------------------
// PAGE_CONTEXT_LOST: an unannounced navigation destroys the isolated world.
// ---------------------------------------------------------------------------

test('an unannounced navigation surfaces PAGE_CONTEXT_LOST, then recovers', async () => {
  const before = await snapshotPage(TASK_A, targetA);
  assert.ok(fakeSessionIds(targetA).length >= 1, 'fixture sanity: a CDP session is attached');

  // The page reloads behind the broker's back: contexts are gone, cached id stale.
  destroyTargetWorlds(targetA);
  await expectToolError(
    'click',
    { taskId: TASK_A, targetId: targetA, index: 0 },
    { code: 'PAGE_CONTEXT_LOST', match: /take a new snapshot/ },
  );

  // The next action re-attaches and rebuilds the isolated world.
  const mouseFrom = fake.stats.input.mouse.length;
  const recovered = await client.callTool('click', {
    taskId: TASK_A,
    targetId: targetA,
    index: 0,
  });
  assert.ok(!recovered.isError, `click after context loss failed: ${toolText(recovered)}`);
  assert.ok(mouseEventsSince(mouseFrom, targetA).length > 0, 'the retry really clicked');

  // snapshot uses retry:true, so it self-heals once instead of failing.
  const afterRecovery = await snapshotPage(TASK_A, targetA);
  assert.equal(afterRecovery.snapshotId, before.snapshotId + 1);

  destroyTargetWorlds(targetA);
  const healed = await snapshotPage(TASK_A, targetA);
  assert.equal(
    healed.snapshotId,
    afterRecovery.snapshotId + 1,
    'snapshot rebuilds the world and succeeds without surfacing PAGE_CONTEXT_LOST',
  );
});

// ---------------------------------------------------------------------------
// maxElements through the whole stack: clamped, never a tool error.
// ---------------------------------------------------------------------------

test('snapshot tolerates out-of-schema maxElements by clamping, not rejecting', async () => {
  // The MCP schema says integer 1..2000, but the bridge forwards arguments
  // verbatim and the page script clamps (lib/page-scripts.mjs clampMaxElements).
  // Asserting the tolerated values documents that contract; the exact clamps are
  // asserted in the unit test above.
  for (const maxElements of [0, 5000, 'many']) {
    const result = await client.callTool('snapshot', {
      taskId: TASK_A,
      targetId: targetA,
      maxElements,
    });
    assert.ok(
      !result.isError,
      `snapshot maxElements=${String(maxElements)} must clamp, not fail: ${toolText(result)}`,
    );
    const snap = toolJson(result, 'snapshot');
    assert.equal(snap.elements, 2);
    assert.equal(snap.truncated, false);
  }
});

// ---------------------------------------------------------------------------
// Protocol-level parameter handling for the new tools.
// ---------------------------------------------------------------------------

test('missing required arguments are tool errors and unknown arguments are dropped', async () => {
  await expectToolError('type_text', { taskId: TASK_A, targetId: targetA, index: 0 }, {
    code: 'INVALID_PARAMS',
    match: /text must be a string/,
  });
  await expectToolError('click', { taskId: TASK_A, targetId: targetA }, {
    code: 'INVALID_PARAMS',
    match: /index must be a non-negative integer/,
  });

  // additionalProperties:false is not enforced by the bridge: unknown fields are
  // filtered out by pickParams instead of rejecting the call.
  const withNoise = await client.callTool('snapshot', {
    taskId: TASK_A,
    targetId: targetA,
    injected: 'ignored',
    maxElementsTypo: 5,
  });
  assert.ok(!withNoise.isError, `unknown arguments must not fail the call: ${toolText(withNoise)}`);

  // The protocol stream is still healthy after all of the above.
  const pong = await client.request('ping', {});
  assert.deepEqual(pong, {});
});
