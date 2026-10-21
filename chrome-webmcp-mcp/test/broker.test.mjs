/**
 * Broker contract tests: task isolation, concurrency, caching, errors, idle exit.
 *
 * The broker runs in-process against a fake CDP endpoint on an ephemeral port,
 * with a free loopback TCP IPC endpoint (named pipes are unavailable in the DSH
 * Windows file sandbox) and a unique state directory. The idle-exit test spawns
 * a real `node bridge.mjs --broker` child with `stdio: 'ignore'` (pipe stdio is
 * also blocked in this sandbox) and observes its state file / exit.
 *
 * Run with: node --test --experimental-test-isolation=none test/broker.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startFakeCdp } from './fake-cdp.mjs';
import { runBroker } from '../broker.mjs';
import {
  BRIDGE_ENTRY,
  connectClient,
  exists,
  killChild,
  readIfExists,
  reserveIpcEndpoint,
  rmrf,
  sleep,
  spawnNode,
  uniqueStateDir,
  waitFor,
  waitForIpc,
} from './helpers.mjs';

/** Long enough that the in-process broker never idles out during the suite. */
const IN_PROCESS_IDLE_MS = 120000;
/** Real child-broker idle exit, exercised by the last test. */
const CHILD_IDLE_MS = 1500;
const TEST_TIMEOUT = 30000;

let fake;
let broker;
let ipcName;
let stateDir;
let stateFile;
let logFile;
let ownershipFile;
let clientA;
let clientB;
/** Page target opened and owned by task "a". */
let targetA;
/** Page target opened and owned by task "b" in an isolated browser context. */
let targetB;
let contextB;
/** Page target that existed before the broker started (unowned, shared read-only). */
let unownedTargetId;
/** Fresh task-"a" page used by the caching / error tests. */
let freshTargetA;

async function invoke(client, taskId, params = {}) {
  return client.call('invoke_tool', { taskId, waitMs: 8000, ...params });
}

before(async () => {
  fake = await startFakeCdp({ slowMs: 0 });
  // A page created by "the user" before the broker runs: shared, unowned.
  unownedTargetId = fake.createPage('https://unowned.example/before-broker');

  ipcName = await reserveIpcEndpoint('broker');
  stateDir = uniqueStateDir('broker-state');
  stateFile = path.join(stateDir, 'broker.json');
  logFile = path.join(stateDir, 'broker.log');
  ownershipFile = path.join(stateDir, 'ownership.json');

  broker = await runBroker({
    ipcName,
    port: fake.port,
    stateFile,
    logFile,
    ownershipFile,
    idleMs: IN_PROCESS_IDLE_MS,
    settleMs: 400,
    invokeWaitMs: 10000,
    handleSignals: false,
  });
  await waitForIpc(ipcName, { timeoutMs: 10000 });

  // The broker writes its state file once listening; it is removed on exit.
  await waitFor(() => exists(stateFile), {
    timeoutMs: 5000,
    what: `broker state file ${stateFile}`,
  });

  clientA = await connectClient(ipcName, { taskId: 'a' });
  clientB = await connectClient(ipcName, { taskId: 'b' });
});

after(async () => {
  for (const client of [clientA, clientB]) {
    try {
      client?.close();
    } catch {
      /* ignore */
    }
  }
  if (broker) await broker.close().catch(() => {});
  await fake?.close().catch(() => {});
  rmrf(stateDir);
});

test('hello reports broker and Chrome facts', { timeout: TEST_TIMEOUT }, async () => {
  const hello = clientA.brokerInfo;
  assert.ok(hello, 'hello must return a result');
  assert.equal(typeof hello.brokerId, 'string');
  assert.equal(hello.version, '2.0.0');
  assert.equal(typeof hello.pid, 'number');
  assert.equal(hello.ipc, ipcName);
  assert.equal(hello.port, fake.port);
  assert.ok(hello.startedAt);
  assert.equal(typeof hello.chrome?.reachable, 'boolean');
});

test('open_page creates task-owned pages (b isolated) and list_tools isolates tasks', { timeout: TEST_TIMEOUT }, async () => {
  const openedA = await clientA.call('open_page', {
    taskId: 'a',
    url: 'https://a.example/one',
    waitMs: 8000,
  });
  assert.equal(openedA.taskId, 'a');
  assert.equal(openedA.url, 'https://a.example/one');
  assert.ok(openedA.targetId, 'open_page must return a targetId');
  targetA = openedA.targetId;
  assert.ok(Array.isArray(openedA.tools), 'open_page must return discovered tools');
  assert.deepEqual(
    openedA.tools.map((tool) => tool.name).sort(),
    ['echo', 'fail_tool', 'slow_echo'],
    'open_page must replay every registered tool',
  );
  assert.equal(fake.sessionCountFor(targetA), 1, 'one CDP session per page target');

  const openedB = await clientB.call('open_page', {
    taskId: 'b',
    url: 'https://b.example/two',
    isolated: true,
    waitMs: 8000,
  });
  assert.equal(openedB.taskId, 'b');
  targetB = openedB.targetId;
  assert.equal(openedB.isolated, true, 'isolated:true must use a browser context');
  contextB = fake.getTarget(targetB)?.browserContextId;
  assert.ok(contextB, 'isolated page must live in a created browser context');
  assert.ok(fake.hasContext(contextB));
  assert.equal(
    fake.getTarget(targetA)?.browserContextId,
    undefined,
    'non-isolated page must use the default browser context',
  );

  const listA = await clientA.call('list_tools', { taskId: 'a', waitMs: 4000 });
  assert.equal(listA.taskId, 'a');
  const idsA = listA.pages.map((page) => page.targetId).sort();
  assert.ok(idsA.includes(targetA), 'task a must see its own page');
  assert.ok(idsA.includes(unownedTargetId), 'task a must see unowned pages');
  assert.ok(!idsA.includes(targetB), "task a must never see task b's page");
  assert.equal(listA.candidates, 2);
  const unowned = listA.pages.find((page) => page.targetId === unownedTargetId);
  assert.equal(unowned.ownedBy, null, 'unowned pages report ownedBy:null');

  const listB = await clientB.call('list_tools', { taskId: 'b', waitMs: 4000 });
  const idsB = listB.pages.map((page) => page.targetId).sort();
  assert.ok(idsB.includes(targetB));
  assert.ok(idsB.includes(unownedTargetId));
  assert.ok(!idsB.includes(targetA), "task b must never see task a's page");
  assert.equal(listB.candidates, 2);
});

test('status is read-only and never leaks other tasks\' page URLs', { timeout: TEST_TIMEOUT }, async () => {
  const sessionsBefore = fake.stats.sessionsCreated;
  let status;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    status = await clientA.call('status', { taskId: 'a', detail: 'full' });
    if (status?.chrome?.reachable) break;
    await sleep(100);
  }
  assert.equal(status.chrome.reachable, true, 'broker must probe fake Chrome');
  assert.equal(status.port, fake.port);
  assert.equal(status.task.id, 'a');
  assert.ok(
    status.task.pages.some((page) => page.targetId === targetA),
    "status lists the calling task's pages",
  );
  assert.ok(
    !JSON.stringify(status).includes('b.example'),
    "status must not leak another task's page URL",
  );
  const otherB = (status.otherTasks || []).find((task) => task.id === 'b');
  assert.ok(otherB, 'status must report other tasks as aggregates');
  assert.equal(otherB.pages, 1);
  assert.equal(fake.stats.sessionsCreated, sessionsBefore, 'status must not attach sessions');
});

test('invoking another task\'s targetId fails TARGET_OTHER_TASK', { timeout: TEST_TIMEOUT }, async () => {
  let error;
  try {
    await clientB.call('invoke_tool', {
      taskId: 'b',
      toolName: 'echo',
      input: { from: 'b' },
      targetId: targetA,
      waitMs: 4000,
    });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, "task b must not be able to invoke task a's target");
  assert.equal(error.code, 'TARGET_OTHER_TASK');
  assert.ok(error.message);
});

test('concurrent slow_echo calls from two clients run in parallel', { timeout: TEST_TIMEOUT }, async () => {
  fake.setSlowMs(300);
  try {
    const startedAt = Date.now();
    const [resultA, resultB] = await Promise.all([
      invoke(clientA, 'a', { toolName: 'slow_echo', input: { value: 'a' }, targetId: targetA }),
      invoke(clientB, 'b', { toolName: 'slow_echo', input: { value: 'b' }, targetId: targetB }),
    ]);
    const elapsed = Date.now() - startedAt;

    assert.equal(resultA.taskId, 'a');
    assert.equal(resultB.taskId, 'b');
    assert.equal(resultA.targetId, targetA);
    assert.equal(resultB.targetId, targetB);
    assert.equal(resultA.status, 'Completed');
    assert.equal(resultB.status, 'Completed');
    assert.deepEqual(resultA.output.echo, { value: 'a' }, 'each client gets its own output');
    assert.deepEqual(resultB.output.echo, { value: 'b' }, 'each client gets its own output');
    assert.equal(resultA.output.delay, 300);
    assert.notEqual(resultA.invocationId, resultB.invocationId);
    assert.ok(
      elapsed < 500,
      `two 300 ms invocations must overlap (wall ${elapsed} ms; channel is serialized or blocked)`,
    );
    assert.ok(
      fake.stats.maxInflight >= 2,
      `fake must observe both tool calls in flight (maxInflight=${fake.stats.maxInflight})`,
    );
  } finally {
    fake.setSlowMs(0);
  }
});

test('close_task(a) closes only a\'s pages and keeps b + unowned pages alive', { timeout: TEST_TIMEOUT }, async () => {
  const closed = await clientA.call('close_task', { taskId: 'a' });
  assert.equal(closed.taskId, 'a');
  assert.deepEqual([...closed.closedTargetIds].sort(), [targetA]);
  assert.equal(fake.hasTarget(targetA), false, "task a's page must be closed in Chrome");
  assert.equal(fake.hasTarget(targetB), true, "task b's page must survive");
  assert.equal(fake.hasTarget(unownedTargetId), true, 'unowned page must survive');
  assert.equal(fake.hasContext(contextB), true, "task b's isolated context must survive");

  const stillB = await invoke(clientB, 'b', {
    toolName: 'echo',
    input: { alive: true },
    targetId: targetB,
  });
  assert.deepEqual(stillB.output.echo, { alive: true }, "task b's page must remain invokable");

  const listAfter = await clientA.call('list_tools', { taskId: 'a', waitMs: 4000 });
  const remaining = listAfter.pages.map((page) => page.targetId);
  assert.deepEqual(remaining.sort(), [unownedTargetId], 'task a only sees unowned pages now');
});

test('cached list_tools does not re-enable WebMCP; refresh:true does', { timeout: TEST_TIMEOUT }, async () => {
  const opened = await clientA.call('open_page', {
    taskId: 'a',
    url: 'https://a.example/cache',
    waitMs: 8000,
  });
  freshTargetA = opened.targetId;
  assert.equal(fake.enableCountFor(freshTargetA), 1, 'open_page discovery enables once');

  const first = await clientA.call('list_tools', { taskId: 'a', waitMs: 4000 });
  const second = await clientA.call('list_tools', { taskId: 'a', waitMs: 4000 });
  assert.equal(fake.enableCountFor(freshTargetA), 1, 'cached list_tools must not re-enable');
  const namesOf = (list) =>
    list.pages.find((page) => page.targetId === freshTargetA)?.tools.map((tool) => tool.name).sort();
  assert.deepEqual(namesOf(first), ['echo', 'fail_tool', 'slow_echo']);
  assert.deepEqual(namesOf(second), ['echo', 'fail_tool', 'slow_echo']);

  const refreshed = await clientA.call('list_tools', {
    taskId: 'a',
    waitMs: 4000,
    refresh: true,
  });
  assert.equal(fake.enableCountFor(freshTargetA), 2, 'refresh:true must re-enable once');
  assert.equal(
    refreshed.pages.find((page) => page.targetId === freshTargetA)?.tools.length,
    3,
    'refreshed registry keeps every tool',
  );
});

test('TOOL_NOT_FOUND and FRAME_WITHOUT_TARGET error codes', { timeout: TEST_TIMEOUT }, async () => {
  // No targetId: every candidate (a's page + the unowned page) is scanned.
  let notFound;
  try {
    await invoke(clientA, 'a', { toolName: 'does_not_exist' });
  } catch (caught) {
    notFound = caught;
  }
  assert.ok(notFound, 'unknown tool must fail');
  assert.equal(notFound.code, 'TOOL_NOT_FOUND');
  assert.equal(notFound.data?.toolName, 'does_not_exist');
  assert.equal(notFound.data?.candidates, 2, 'both candidate pages must be reported');

  // An explicit targetId narrows the candidate set to that page.
  let notFoundScoped;
  try {
    await invoke(clientA, 'a', { toolName: 'does_not_exist', targetId: freshTargetA });
  } catch (caught) {
    notFoundScoped = caught;
  }
  assert.ok(notFoundScoped, 'unknown tool on a scoped target must fail');
  assert.equal(notFoundScoped.code, 'TOOL_NOT_FOUND');
  assert.equal(notFoundScoped.data?.candidates, 1);

  let frameWithoutTarget;
  try {
    await invoke(clientA, 'a', { toolName: 'echo', frameId: 'frame-x' });
  } catch (caught) {
    frameWithoutTarget = caught;
  }
  assert.ok(frameWithoutTarget, 'frameId without targetId must fail');
  assert.equal(frameWithoutTarget.code, 'FRAME_WITHOUT_TARGET');

  let unknownTarget;
  try {
    await invoke(clientA, 'a', { toolName: 'echo', targetId: 'T-does-not-exist' });
  } catch (caught) {
    unknownTarget = caught;
  }
  assert.ok(unknownTarget, 'unknown targetId must fail');
  assert.equal(unknownTarget.code, 'TARGET_NOT_FOUND');
});

test('invalid params and CONFIRM_REQUIRED are answered without dropping the connection', { timeout: TEST_TIMEOUT }, async () => {
  let invalid;
  try {
    await clientA.call('invoke_tool', { taskId: 'a' });
  } catch (caught) {
    invalid = caught;
  }
  assert.ok(invalid, 'invoke_tool without toolName must fail');
  assert.equal(invalid.code, 'INVALID_PARAMS');

  const browserCloseCallsBefore = fake.stats.browserCloseCalls;
  let confirmRequired;
  try {
    await clientA.call('close_browser', { confirm: false });
  } catch (caught) {
    confirmRequired = caught;
  }
  assert.ok(confirmRequired, 'close_browser without confirm:true must fail');
  assert.equal(confirmRequired.code, 'CONFIRM_REQUIRED');
  assert.equal(fake.stats.browserCloseCalls, browserCloseCallsBefore, 'Chrome must not be closed');

  // Both errors were answered on the same connection; it must still work.
  const pong = await clientA.call('ping', {});
  assert.equal(pong.pong, true);
  assert.equal(typeof pong.uptimeMs, 'number');
});

test('close_task keeps ownership when Chrome refuses to close a page', { timeout: TEST_TIMEOUT }, async () => {
  fake.setCloseFailure(freshTargetA, true);
  let failed;
  try {
    failed = await clientA.call('close_task', { taskId: 'a' });
  } finally {
    fake.setCloseFailure(freshTargetA, false);
  }
  assert.deepEqual(failed.stillOpen, [freshTargetA], 'the unclosed page must be reported');
  assert.deepEqual(failed.closedTargetIds, [], 'no target was actually closed');
  assert.equal(fake.hasTarget(freshTargetA), true, 'the page must still exist');
  assert.equal(failed.disposedContext, false, 'a context must not be disposed while a page survives');

  const list = await clientA.call('list_tools', { taskId: 'a', waitMs: 4000 });
  assert.ok(
    list.pages.some((page) => page.targetId === freshTargetA),
    'ownership must be retained after a failed close',
  );

  const retried = await clientA.call('close_task', { taskId: 'a' });
  assert.deepEqual(retried.closedTargetIds, [freshTargetA]);
  assert.deepEqual(retried.stillOpen, []);
  assert.equal(fake.hasTarget(freshTargetA), false, 'a retried close must succeed');
});

test('status still answers when Chrome is unreachable', { timeout: TEST_TIMEOUT }, async () => {
  const downFake = await startFakeCdp({ slowMs: 0 });
  const downIpc = await reserveIpcEndpoint('status-down');
  const downDir = uniqueStateDir('status-down');
  const downBroker = await runBroker({
    ipcName: downIpc,
    port: downFake.port,
    stateFile: path.join(downDir, 'broker.json'),
    logFile: path.join(downDir, 'broker.log'),
    ownershipFile: path.join(downDir, 'ownership.json'),
    idleMs: IN_PROCESS_IDLE_MS,
    settleMs: 400,
    handleSignals: false,
  });
  try {
    const downClient = await connectClient(downIpc, { taskId: 'down' });
    try {
      await downFake.close();
      const status = await downClient.call('status', { taskId: 'down' }, { timeoutMs: 10000 });
      assert.equal(status.chrome.reachable, false, 'status must report the missing Chrome');
      assert.equal(status.task.id, 'down');
      assert.equal(status.pageIndexError, 'CHROME_UNREACHABLE', 'the page index failure must be reported');
    } finally {
      downClient.close();
    }
  } finally {
    await downBroker.close().catch(() => {});
    rmrf(downDir);
  }
});

test('ownership survives a broker restart and keeps task isolation', { timeout: TEST_TIMEOUT }, async () => {
  const restartFake = await startFakeCdp({ slowMs: 0 });
  const restartIpc = await reserveIpcEndpoint('restart');
  const restartDir = uniqueStateDir('restart');
  const restartState = {
    ipcName: restartIpc,
    port: restartFake.port,
    stateFile: path.join(restartDir, 'broker.json'),
    logFile: path.join(restartDir, 'broker.log'),
    ownershipFile: path.join(restartDir, 'ownership.json'),
    idleMs: IN_PROCESS_IDLE_MS,
    settleMs: 400,
    handleSignals: false,
  };
  const first = await runBroker(restartState);
  let firstClient;
  let secondClient;
  let second;
  let pageA;
  let pageB;
  try {
    firstClient = await connectClient(restartIpc, { taskId: 'persist-a' });
    pageA = (await firstClient.call('open_page', { taskId: 'persist-a', url: 'https://persist.example/a', waitMs: 4000 })).targetId;
    pageB = (await firstClient.call('open_page', { taskId: 'persist-b', url: 'https://persist.example/b', waitMs: 4000 })).targetId;
    assert.ok(exists(restartState.ownershipFile), 'ownership file must be written');
    firstClient.close();
    firstClient = undefined;
    await first.close();

    second = await runBroker(restartState);
    secondClient = await connectClient(restartIpc, { taskId: 'persist-a' });
    const list = await secondClient.call('list_tools', { taskId: 'persist-a', waitMs: 4000 });
    const ids = list.pages.map((page) => page.targetId);
    assert.ok(ids.includes(pageA), 'restored task must see its own page');
    assert.ok(!ids.includes(pageB), "restored task must not see another task's page");

    const closed = await secondClient.call('close_task', { taskId: 'persist-a' });
    assert.deepEqual(closed.closedTargetIds, [pageA]);
    assert.equal(restartFake.hasTarget(pageA), false);
    assert.equal(restartFake.hasTarget(pageB), true, "another task's page must survive");
  } finally {
    firstClient?.close();
    secondClient?.close();
    await first.close().catch(() => {});
    await second?.close().catch(() => {});
    await restartFake.close().catch(() => {});
    rmrf(restartDir);
  }
});

test('real broker child idle-exits, removes the state file, and leaves Chrome running', { timeout: 60000 }, async () => {
  const childIpc = await reserveIpcEndpoint('broker-idle');
  const childStateDir = uniqueStateDir('broker-idle-state');
  const childStateFile = path.join(childStateDir, 'broker.json');
  const childLogFile = path.join(childStateDir, 'broker.log');
  // Pipes are blocked in this sandbox; the broker logs to its state dir instead.
  const child = spawnNode([BRIDGE_ENTRY, '--broker'], {
    env: {
      CHROME_CDP_PORT: String(fake.port),
      CHROME_WEBMCP_IPC: childIpc,
      CHROME_WEBMCP_STATE_DIR: childStateDir,
      CHROME_WEBMCP_BROKER_IDLE_MS: String(CHILD_IDLE_MS),
    },
    stdio: 'ignore',
  });

  try {
    await waitForIpc(childIpc, { timeoutMs: 20000, child: child.child });
    await waitFor(() => exists(childStateFile), {
      timeoutMs: 5000,
      what: `child broker state file ${childStateFile}`,
    });

    const idleClient = await connectClient(childIpc, { taskId: 'idle' });
    const pong = await idleClient.call('ping', {});
    assert.equal(pong.pong, true);
    idleClient.close();

    const deadline = Date.now() + 20000;
    let stateGone = false;
    let exited = false;
    while (Date.now() < deadline) {
      if (!exists(childStateFile)) stateGone = true;
      if (child.child.exitCode !== null) exited = true;
      if (stateGone && exited) break;
      await sleep(100);
    }
    assert.ok(
      stateGone,
      `state file ${childStateFile} must be removed on idle exit; broker log:\n${readIfExists(childLogFile)}`,
    );
    assert.ok(
      exited,
      `broker must exit after ${CHILD_IDLE_MS} ms without clients; log:\n${readIfExists(childLogFile)}`,
    );
    assert.equal(child.child.exitCode, 0, 'idle exit is clean (code 0)');

    const response = await fetch(`${fake.url}/json/version`);
    assert.equal(response.status, 200, 'fake Chrome must survive broker exit');
    const version = await response.json();
    assert.match(version.Browser, /^FakeChrome\//);
    assert.equal(fake.hasTarget(targetB), true, "fake Chrome still owns task b's page");
    assert.equal(fake.hasTarget(unownedTargetId), true);
  } finally {
    await killChild(child.child).catch(() => {});
    rmrf(childStateDir);
  }
});
