/**
 * Optional real-Chrome smoke test. Skipped unless CHROME_E2E=1.
 *
 * Requires a Chrome already running with remote debugging on CHROME_CDP_PORT
 * (default 9333) and the WebMCP flags enabled. It opens the fixture page
 * `test/fixtures/webmcp-test.html`, which registers add_numbers / get_page_title,
 * and checks a real page-side tool invocation. No Chrome is launched here.
 *
 * The broker runs in-process (the sandbox denies piped stdio spawns; an
 * in-process broker needs no pipes at all).
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
const FIXTURE = path.join(PKG_DIR, 'test', 'fixtures', 'webmcp-test.html');

test(
  'real Chrome: fixture page registers add_numbers and returns 42',
  { skip: ENABLED ? false : 'set CHROME_E2E=1 with Chrome on CHROME_CDP_PORT to run', timeout: 90000 },
  async (t) => {
    const port = Number(process.env.CHROME_CDP_PORT || 9333);
    let reachable = false;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      reachable = response.ok;
    } catch {
      reachable = false;
    }
    if (!reachable) {
      t.skip(`no Chrome DevTools endpoint on 127.0.0.1:${port}`);
      return;
    }

    const ipcName = await reserveIpcEndpoint('live');
    const stateDir = uniqueStateDir('live-state');
    const broker = await runBroker({
      ipcName,
      port,
      stateFile: path.join(stateDir, 'broker.json'),
      logFile: path.join(stateDir, 'broker.log'),
      idleMs: 30000,
      handleSignals: false,
    });

    let client;
    try {
      await waitForIpc(ipcName, { timeoutMs: 15000 });
      client = await connectClient(ipcName, { taskId: 'live-e2e' });

      const opened = await client.call('open_page', {
        taskId: 'live-e2e',
        url: pathToFileURL(FIXTURE).href,
        waitMs: 8000,
      });
      const toolNames = (opened.tools || []).map((tool) => tool.name);
      assert.ok(toolNames.includes('add_numbers'), `missing add_numbers in [${toolNames}]`);
      assert.ok(toolNames.includes('get_page_title'), `missing get_page_title in [${toolNames}]`);

      const invoked = await client.call(
        'invoke_tool',
        {
          taskId: 'live-e2e',
          toolName: 'add_numbers',
          input: { a: 20, b: 22 },
          targetId: opened.targetId,
          waitMs: 20000,
        },
        { timeoutMs: 30000 },
      );
      assert.equal(invoked.status, 'Completed');
      assert.equal(invoked.output?.sum, 42);

      const refreshed = await client.call('list_tools', {
        taskId: 'live-e2e',
        waitMs: 4000,
        refresh: true,
      });
      assert.ok(refreshed.pages.some((page) => page.targetId === opened.targetId));

      const closed = await client.call('close_task', { taskId: 'live-e2e' });
      assert.deepEqual([...closed.closedTargetIds], [opened.targetId]);
    } finally {
      try {
        client?.close();
      } catch {
        /* ignore */
      }
      await broker.close().catch(() => {});
      rmrf(stateDir);
    }
  },
);
