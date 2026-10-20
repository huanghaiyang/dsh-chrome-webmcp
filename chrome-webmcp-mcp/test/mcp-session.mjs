/**
 * Worker-thread host for the hermetic MCP stdio test.
 *
 * A Worker gets its own ESM module cache, so it can import bridge.mjs with a
 * fresh lib/config.mjs after this file applies the test environment (unique
 * loopback IPC endpoint, fake CDP port, temp state dir). No child-process pipe
 * stdio is involved, which matters in the DSH Windows file sandbox where
 * `spawn(..., { stdio: 'pipe' })` is denied.
 *
 * Protocol with the parent test:
 *   parent -> worker: { type: 'frame', data: '<one JSON-RPC line>' } | { type: 'end' }
 *   worker -> parent: { type: 'ready' } | { type: 'out', chunk } | { type: 'error', message }
 */
import { parentPort, workerData } from 'node:worker_threads';

if (!parentPort) {
  // Imported by the test runner as an ordinary file: nothing to run.
} else {
  const main = async () => {
    const { PassThrough } = await import('node:stream');
    // Apply the test environment before importing the bridge: lib/config.mjs
    // snapshots these values at module evaluation time.
    Object.assign(process.env, workerData.env ?? {});
    const { startStdioServer } = await import(workerData.bridgeUrl);

    const input = new PassThrough();
    const output = new PassThrough({ encoding: 'utf8' });
    output.on('data', (chunk) => parentPort.postMessage({ type: 'out', chunk }));
    output.on('error', (error) =>
      parentPort.postMessage({ type: 'error', message: error?.message || String(error) }),
    );

    startStdioServer(input, output, { exitOnClose: false });

    parentPort.on('message', (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'frame') input.write(`${message.data}\n`);
      else if (message.type === 'end') input.end();
    });

    parentPort.postMessage({ type: 'ready' });
  };

  main().catch((error) => {
    parentPort.postMessage({ type: 'error', message: error?.stack || error?.message || String(error) });
  });
}
