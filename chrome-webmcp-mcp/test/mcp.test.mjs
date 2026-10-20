/**
 * MCP stdio end-to-end tests for `bridge.mjs`.
 *
 * Sandbox note: this DSH Windows file sandbox denies `child_process.spawn` with
 * piped stdio (EPERM), so the usual "spawn the MCP server and talk over its
 * stdin/stdout" harness cannot run here. `bridge.mjs` exposes the injectable
 * `startStdioServer(input, output, { exitOnClose })` seam for exactly this case:
 * the server runs in a Worker thread (fresh ESM module cache, so it loads
 * lib/config.mjs with this test's environment) and the parent test drives it
 * through PassThrough streams over the Worker message port. Production still
 * uses process.stdin/process.stdout.
 *
 * Verifies: initialize, exactly 7 tools, open_page -> invoke_tool -> close with
 * taskId echoed, broker error codes in the MCP error text, and a protocol-only
 * output stream (every frame is JSON-RPC, no diagnostics).
 *
 * Run with: node --test --experimental-test-isolation=none test/mcp.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { startFakeCdp } from './fake-cdp.mjs';
import { runBroker } from '../broker.mjs';
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
const TASK_ID = 'mcp-a';
const EXPECTED_TOOLS = [
  'status',
  'list_tools',
  'invoke_tool',
  'open_page',
  'launch',
  'close',
  'close_browser',
];

let fake;
let broker;
let worker;
let client;
let ipcName;
let stateDir;
let initResult;
let targetId;

/**
 * MCP client over a Worker-hosted `startStdioServer`: frames in via port
 * messages, protocol frames out via the injected output stream.
 */
class McpWorkerClient {
  constructor(workerInstance) {
    this.worker = workerInstance;
    this.pending = new Map();
    this.nextId = 0;
    this.rawLines = [];
    this.notifications = [];
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
        // Kept in rawLines; the purity test fails on it.
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
      this.notifications.push(frame);
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

/** Parse the JSON payload a successful tool result carries as a text item. */
function toolJson(result, what) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content.find((item) => item?.type === 'text')?.text;
  if (typeof text === 'string') {
    try {
      return JSON.parse(text);
    } catch {
      /* fall through to structuredContent */
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

/** Wait for one Worker message matching `predicate`. */
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
  ipcName = await reserveIpcEndpoint('mcp');
  stateDir = uniqueStateDir('mcp-state');

  // Explicit broker: the bridge's lazy-connect path still runs (it must find a
  // listening endpoint), and teardown stays deterministic. The broker child
  // spawn path is covered by the broker idle-exit test.
  broker = await runBroker({
    ipcName,
    port: fake.port,
    stateFile: path.join(stateDir, 'broker.json'),
    logFile: path.join(stateDir, 'broker.log'),
    idleMs: 120000,
    settleMs: 400,
    invokeWaitMs: 10000,
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
        CHROME_TOOL_SETTLE_MS: '400',
        CHROME_INVOKE_WAIT_MS: '10000',
      },
    },
  });
  await waitForWorkerReady(worker);
  client = new McpWorkerClient(worker);

  initResult = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'webmcp-test', version: randomTag() },
  });
  client.notify('notifications/initialized');
});

after(async () => {
  try {
    client?.end();
  } catch {
    /* ignore */
  }
  await worker?.terminate().catch(() => {});
  if (broker) await broker.close().catch(() => {});
  await fake?.close().catch(() => {});
  rmrf(stateDir);
});

test('initialize echoes the protocol version and advertises chrome-webmcp', { timeout: TEST_TIMEOUT }, async () => {
  assert.ok(initResult, 'initialize must return a result');
  assert.equal(initResult.protocolVersion, '2025-06-18');
  assert.equal(initResult.serverInfo?.name, 'chrome-webmcp');
  assert.equal(initResult.serverInfo?.version, '2.0.0');
  assert.equal(typeof initResult.instructions, 'string');
  assert.match(initResult.instructions, /taskId/i, 'instructions must explain taskId scoping');
  assert.match(initResult.instructions, /open_page/, 'instructions must mention open_page');
});

test('tools/list exposes exactly the 7 contract tools', { timeout: TEST_TIMEOUT }, async () => {
  const result = await client.request('tools/list', {});
  assert.ok(Array.isArray(result?.tools));
  const names = result.tools.map((tool) => tool.name);
  assert.deepEqual(names.slice().sort(), EXPECTED_TOOLS.slice().sort());
  for (const tool of result.tools) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 0, `${tool.name} needs a description`);
    assert.equal(tool.inputSchema?.type, 'object', `${tool.name} needs an object inputSchema`);
  }
  const byName = Object.fromEntries(result.tools.map((tool) => [tool.name, tool]));
  assert.ok(byName.open_page.inputSchema.required?.includes('url'), 'open_page.url is required');
  assert.ok(
    byName.invoke_tool.inputSchema.required?.includes('toolName'),
    'invoke_tool.toolName is required',
  );
  assert.equal(
    byName.close_browser.inputSchema.properties.confirm.const,
    true,
    'close_browser.confirm is a const true',
  );
});

test('open_page -> invoke_tool -> close round-trip echoes taskId', { timeout: TEST_TIMEOUT }, async () => {
  const opened = await client.callTool('open_page', { url: 'https://mcp.example/page', taskId: TASK_ID });
  assert.ok(!opened.isError, `open_page failed: ${toolText(opened)}`);
  const page = toolJson(opened, 'open_page');
  assert.equal(page.taskId, TASK_ID, 'open_page must echo the normalized taskId');
  assert.ok(page.targetId);
  targetId = page.targetId;
  assert.deepEqual(page.tools.map((tool) => tool.name).sort(), ['echo', 'fail_tool', 'slow_echo']);

  const invoked = await client.callTool('invoke_tool', {
    toolName: 'echo',
    input: { hello: 'mcp' },
    targetId,
    taskId: TASK_ID,
  });
  assert.ok(!invoked.isError, `invoke_tool failed: ${toolText(invoked)}`);
  const call = toolJson(invoked, 'invoke_tool');
  assert.equal(call.taskId, TASK_ID, 'invoke_tool must echo the normalized taskId');
  assert.equal(call.targetId, targetId);
  assert.equal(call.status, 'Completed');
  assert.deepEqual(call.output.echo, { hello: 'mcp' });
  assert.ok(call.invocationId);

  const closed = await client.callTool('close', { taskId: TASK_ID });
  assert.ok(!closed.isError, `close failed: ${toolText(closed)}`);
  const closedResult = toolJson(closed, 'close');
  assert.equal(closedResult.taskId, TASK_ID, 'close must echo the normalized taskId');
  assert.deepEqual([...closedResult.closedTargetIds], [targetId]);
  assert.equal(fake.hasTarget(targetId), false, 'close must close the task page in Chrome');
});

test('broker error codes surface in the MCP error text as [CODE]', { timeout: TEST_TIMEOUT }, async () => {
  const unknownTarget = await client.callTool('invoke_tool', {
    toolName: 'echo',
    targetId: 'T-does-not-exist',
    taskId: TASK_ID,
  });
  assert.equal(unknownTarget.isError, true, 'unknown target must be an MCP tool error');
  assert.match(toolText(unknownTarget), /\[TARGET_NOT_FOUND\]/);

  const frameWithoutTarget = await client.callTool('invoke_tool', {
    toolName: 'echo',
    frameId: 'frame-x',
    taskId: TASK_ID,
  });
  assert.equal(frameWithoutTarget.isError, true);
  assert.match(toolText(frameWithoutTarget), /\[FRAME_WITHOUT_TARGET\]/);
});

test('the protocol output stream carries pure JSON-RPC frames only', { timeout: TEST_TIMEOUT }, async () => {
  // One more round-trip so a late diagnostic would have been flushed.
  await client.request('ping', {});
  await sleep(20);
  assert.ok(client.rawLines.length >= 8, `expected several protocol frames, got ${client.rawLines.length}`);
  for (const line of client.rawLines) {
    let frame;
    assert.doesNotThrow(() => {
      frame = JSON.parse(line);
    }, `protocol stream line is not JSON: ${line.slice(0, 200)}`);
    assert.equal(frame.jsonrpc, '2.0', `protocol stream frame is not JSON-RPC: ${line.slice(0, 200)}`);
    assert.ok(
      typeof frame.id !== 'undefined' || typeof frame.method === 'string',
      `protocol stream frame is neither a response nor a notification: ${line.slice(0, 200)}`,
    );
  }
  assert.ok(
    client.rawLines.every((line) => !/\[chrome-webmcp\]/.test(line)),
    'diagnostics must not be written to the protocol stream',
  );
});
