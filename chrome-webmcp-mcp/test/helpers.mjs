/**
 * Shared, dependency-free helpers for the hermetic bridge tests.
 *
 * Everything is namespaced per test file: a free loopback TCP endpoint for the
 * broker IPC, a unique state directory under test/tmp/test-dev, and ephemeral
 * CDP ports. No test touches a user's real broker, Chrome profile, or the
 * client-dev scratch directory.
 *
 * Sandbox note: the DSH Windows file sandbox blocks named pipes and
 * `child_process.spawn(..., { stdio: 'pipe' })`. Tests therefore use
 * `tcp://127.0.0.1:<port>` IPC endpoints (lib/ipc.mjs supports them) and either
 * run the broker in-process or spawn with `stdio: 'ignore'`.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectIpc } from '../lib/ipc.mjs';

export const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const TEST_DIR = path.join(PKG_DIR, 'test');
export const BRIDGE_ENTRY = path.join(PKG_DIR, 'bridge.mjs');
export const SCRATCH_ROOT = path.join(TEST_DIR, 'tmp', 'test-dev');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const randomTag = () => crypto.randomBytes(4).toString('hex');

/**
 * Reserve a free loopback TCP port and return it as a `tcp://` IPC endpoint.
 * The probe listener is closed before the endpoint is returned, so the broker
 * can bind it. This is the sandbox-safe replacement for a named pipe.
 */
export function reserveIpcEndpoint(label = 'test', host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, host, () => {
      server.removeListener('error', onError);
      const { port } = server.address();
      server.close(() => resolve(`tcp://${host}:${port}`));
    });
  });
}

/** Unique, empty state directory under test/tmp/test-dev. */
export function uniqueStateDir(label = 'state') {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(SCRATCH_ROOT, `${label}-${process.pid}-`));
}

/**
 * Spawn a Node process.
 * `stdio: 'pipe'` (default) captures output for diagnostics; use `stdio:
 * 'ignore'` when the sandbox blocks pipes (broker child processes).
 */
export function spawnNode(args, { env = {}, cwd = PKG_DIR, stdio = 'pipe' } = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: stdio === 'ignore' ? 'ignore' : ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const state = { child, stdout: '', stderr: '' };
  if (stdio !== 'ignore') {
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      state.stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      state.stderr += chunk;
    });
  }
  return state;
}

/** Resolve once the child exits (or the timeout elapses). */
export function waitForExit(child, timeoutMs = 8000) {
  if (!child || child.exitCode !== null) return Promise.resolve(child?.exitCode ?? null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    const onExit = (code) => {
      clearTimeout(timer);
      resolve(code);
    };
    child.once('exit', onExit);
  });
}

/** Kill a child process, ignoring "already gone". */
export async function killChild(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  const code = await waitForExit(child, timeoutMs);
  if (code === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    await waitForExit(child, 3000);
  }
}

/** Poll until something accepts connections on the broker IPC endpoint. */
export async function waitForIpc(ipcName, { timeoutMs = 20000, child, stderr = () => '' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(
        `broker exited early (code ${child.exitCode}) before serving ${ipcName}\nstderr:\n${stderr()}`,
      );
    }
    try {
      const channel = await connectIpc(ipcName, { timeoutMs: 400 });
      channel.close();
      return;
    } catch (error) {
      lastError = error;
      await sleep(50);
    }
  }
  throw new Error(
    `broker IPC ${ipcName} not ready after ${timeoutMs} ms (last error: ${lastError?.code || lastError?.message})\nstderr:\n${stderr()}`,
  );
}

/** Wait until the IPC endpoint stops accepting connections (broker is gone). */
export async function waitForIpcGone(ipcName, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const channel = await connectIpc(ipcName, { timeoutMs: 300 });
      channel.close();
    } catch {
      return true;
    }
    await sleep(100);
  }
  return false;
}

/** Wait until `predicate()` is truthy, polling every `intervalMs`. */
export async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 50, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

/**
 * Connect a broker client and perform the mandatory `hello` handshake.
 * Returns the IPC channel with `call()` baked in.
 */
export async function connectClient(ipcName, { taskId = 'default', version = '2.0.0' } = {}) {
  const channel = await connectIpc(ipcName, { timeoutMs: 5000 });
  channel.taskId = taskId;
  channel.clientId = `test-${taskId}-${process.pid}-${randomTag()}`;
  const hello = await channel.request(
    'hello',
    { clientId: channel.clientId, pid: process.pid, version, taskId },
    { timeoutMs: 10000 },
  );
  channel.brokerInfo = hello;
  channel.call = (method, params = {}, options = {}) =>
    channel.request(method, params, { timeoutMs: options.timeoutMs ?? 30000 });
  return channel;
}

/** Send `shutdown` (best effort) and close the channel. */
export async function shutdownClient(channel) {
  if (!channel) return;
  try {
    await channel.request('shutdown', {}, { timeoutMs: 2000 });
  } catch {
    /* already gone / unsupported */
  }
  try {
    channel.close();
  } catch {
    /* ignore */
  }
}

export function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Read-only existence check used by assertions. */
export function exists(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

/** Read a file as text, returning '' when absent (diagnostics only). */
export function readIfExists(target) {
  try {
    return fs.readFileSync(target, 'utf8');
  } catch {
    return '';
  }
}

export { os };
