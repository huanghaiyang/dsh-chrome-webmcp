/**
 * Newline-delimited JSON over a local socket.
 *
 * The bridge uses this for both directions of the broker protocol:
 *   MCP client process  <->  broker process  <->  one Chrome DevTools socket
 *
 * Every frame is a single JSON object on one line. Requests carry an `id` and a
 * `method`; responses carry the same `id` plus `ok` and either `result` or an
 * `{code, message}` error. No untrusted data is parsed as code.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { MAX_LINE_BYTES } from './config.mjs';

export class IpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'IpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/**
 * Endpoints are either a local socket path (default: named pipe / Unix socket)
 * or an explicit loopback listener `tcp://127.0.0.1:<port>`. The TCP form is
 * only meant for tests and constrained environments where named pipes are not
 * available; the default endpoint never leaves the machine either way.
 */
function parseEndpoint(ipcName) {
  if (typeof ipcName === 'string' && ipcName.startsWith('tcp://')) {
    const url = new URL(ipcName);
    return { tcp: true, host: url.hostname || '127.0.0.1', port: Number(url.port) };
  }
  return { tcp: false, path: ipcName };
}

export function errorToJson(error) {
  const data = error instanceof IpcError ? error.data : error?.data;
  return {
    code: error?.code || 'INTERNAL',
    message: String(error?.message || error),
    ...(data !== undefined ? { data } : {}),
  };
}

class LineChannel {
  constructor(socket, { label = 'ipc' } = {}) {
    this.socket = socket;
    this.label = label;
    this.clientId = null;
    this.pending = new Map();
    this.nextId = 0;
    this.buffer = '';
    this.closed = false;
    this.onRequest = null;
    this.onClose = null;

    socket.setNoDelay?.(true);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (error) => {
      this.lastError = error;
    });
    socket.on('close', () => this.#onClosed());
  }

  #onData(chunk) {
    if (this.closed) return;
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_BYTES && !this.buffer.includes('\n')) {
      this.destroy(new Error(`IPC frame exceeds ${MAX_LINE_BYTES} bytes`));
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.destroy(new Error('IPC peer sent a non-JSON line'));
        return;
      }
      this.#onMessage(message);
    }
  }

  #onMessage(message) {
    if (message === null || typeof message !== 'object') return;
    if (typeof message.id !== 'undefined' && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok === true) pending.resolve(message.result ?? null);
      else {
        const error = new IpcError(
          message.error?.code || 'INTERNAL',
          message.error?.message || 'IPC request failed',
          message.error?.data,
        );
        pending.reject(error);
      }
      return;
    }
    if (typeof message.method === 'string') {
      if (!this.onRequest) {
        if (typeof message.id !== 'undefined') {
          this.send({ id: message.id, ok: false, error: { code: 'METHOD_NOT_FOUND', message: message.method } });
        }
        return;
      }
      Promise.resolve()
        .then(() => this.onRequest(message.method, message.params ?? {}, message))
        .then((result) => {
          if (typeof message.id !== 'undefined') this.send({ id: message.id, ok: true, result: result ?? null });
        })
        .catch((error) => {
          if (typeof message.id !== 'undefined') this.send({ id: message.id, ok: false, error: errorToJson(error) });
        });
    }
  }

  send(object) {
    if (this.closed) throw new IpcError('IPC_CLOSED', 'IPC connection is closed');
    this.socket.write(`${JSON.stringify(object)}\n`);
  }

  request(method, params = {}, { timeoutMs = 30000 } = {}) {
    if (this.closed) return Promise.reject(new IpcError('IPC_CLOSED', 'IPC connection is closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new IpcError('IPC_TIMEOUT', `IPC request ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  #onClosed() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new IpcError('IPC_CLOSED', `IPC connection closed while waiting for ${pending.method}`));
    }
    this.pending.clear();
    try {
      this.onClose?.();
    } catch {
      /* observer failure must not break teardown */
    }
  }

  close() {
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    this.#onClosed();
  }

  destroy(error) {
    this.lastError = error;
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    this.#onClosed();
  }
}

/**
 * Connect to an existing broker endpoint.
 * Rejects with `code === 'ENOENT'/'ECONNREFUSED'` when no broker is listening.
 */
export function connectIpc(ipcName, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const endpoint = parseEndpoint(ipcName);
    const socket = endpoint.tcp
      ? net.createConnection({ host: endpoint.host, port: endpoint.port })
      : net.createConnection(ipcName);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new IpcError('IPC_TIMEOUT', `connecting to ${ipcName} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();
    socket.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(new LineChannel(socket, { label: 'broker' }));
    });
  });
}

/** Probe whether a broker accepts connections on this endpoint. */
export async function ipcIsAlive(ipcName, { timeoutMs = 500 } = {}) {
  try {
    const channel = await connectIpc(ipcName, { timeoutMs });
    channel.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the broker's IPC endpoint. `onConnection` receives each client channel
 * with `clientId` already assigned; the caller installs `channel.onRequest`.
 */
export async function createIpcServer(ipcName, { onConnection, onError } = {}) {
  const endpoint = parseEndpoint(ipcName);
  if (!endpoint.tcp && process.platform !== 'win32' && ipcName) {
    const directory = path.dirname(ipcName);
    try {
      fs.mkdirSync(directory, { recursive: true });
    } catch {
      /* listen reports the real failure */
    }
    if (fs.existsSync(ipcName)) {
      // A live broker owns the socket; only unlink a stale one.
      if (await ipcIsAlive(ipcName, { timeoutMs: 300 })) {
        throw new IpcError('EADDRINUSE', `another broker is already listening on ${ipcName}`);
      }
      try {
        fs.unlinkSync(ipcName);
      } catch {
        /* listen reports the real failure */
      }
    }
  }

  let sequence = 0;
  const server = net.createServer((socket) => {
    const channel = new LineChannel(socket, { label: 'client' });
    channel.clientId = `c-${++sequence}`;
    try {
      onConnection?.(channel);
    } catch (error) {
      channel.destroy(error);
    }
  });
  server.on('error', (error) => onError?.(error));

  await new Promise((resolve, reject) => {
    const onListenError = (error) => reject(error);
    server.once('error', onListenError);
    const ready = () => {
      server.removeListener('error', onListenError);
      resolve();
    };
    if (endpoint.tcp) server.listen(endpoint.port, endpoint.host, ready);
    else server.listen(ipcName, ready);
  });

  return {
    ipcName,
    server,
    address: () => server.address(),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        if (!endpoint.tcp && process.platform !== 'win32') {
          try {
            fs.rmSync(ipcName, { force: true });
          } catch {
            /* best effort */
          }
        }
      }),
  };
}
