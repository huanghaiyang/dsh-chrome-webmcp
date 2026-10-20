/**
 * One Chrome DevTools Protocol connection shared by every client of the broker.
 *
 * Responsibilities:
 *  - connect lazily to ws://127.0.0.1:<port>/devtools/browser/<id> and reconnect
 *    after a drop;
 *  - multiplex CDP commands by id with a fair, bounded in-flight scheduler so a
 *    single task cannot monopolize the channel;
 *  - fan out protocol events to the session registry.
 */
import { CDP_TIMEOUT_MS, CLIENT_MAX_INFLIGHT, MAX_INFLIGHT } from './config.mjs';

export class CdpError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'CdpError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/**
 * Bounded FIFO scheduler with a per-client in-flight cap.
 *
 * A client that enqueues a burst keeps at most `perClient` commands in flight,
 * so entries from other clients behind it still reach the browser instead of
 * waiting for the whole burst. That is the fairness property the bridge needs:
 * one task never owns the channel.
 */
class FairScheduler {
  constructor({ max = MAX_INFLIGHT, perClient = CLIENT_MAX_INFLIGHT } = {}) {
    this.max = max;
    this.perClient = perClient;
    this.active = 0;
    this.clientActive = new Map();
    this.queue = [];
    this.pumping = false;
  }

  enqueue(clientId) {
    const entry = {
      clientId: clientId || '__internal__',
      cancelled: false,
      granted: false,
      resolve: null,
      promise: null,
    };
    entry.promise = new Promise((resolve) => {
      entry.resolve = resolve;
    });
    this.queue.push(entry);
    this.#pump();
    return {
      promise: entry.promise,
      get cancelled() {
        return entry.cancelled;
      },
      cancel: () => {
        entry.cancelled = true;
        if (entry.granted && entry.release) entry.release();
      },
    };
  }

  #pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      // Cancelled entries that were never granted no longer matter.
      if (this.queue.some((entry) => entry.cancelled)) {
        this.queue = this.queue.filter((entry) => !entry.cancelled);
      }
      while (this.active < this.max) {
        let index = -1;
        for (let i = 0; i < this.queue.length; i += 1) {
          const entry = this.queue[i];
          if ((this.clientActive.get(entry.clientId) || 0) < this.perClient) {
            index = i;
            break;
          }
        }
        if (index === -1) break;
        const [entry] = this.queue.splice(index, 1);
        entry.granted = true;
        this.active += 1;
        this.clientActive.set(entry.clientId, (this.clientActive.get(entry.clientId) || 0) + 1);
        entry.release = () => {
          if (!entry.granted) return;
          entry.granted = false;
          this.active -= 1;
          const next = (this.clientActive.get(entry.clientId) || 1) - 1;
          if (next <= 0) this.clientActive.delete(entry.clientId);
          else this.clientActive.set(entry.clientId, next);
          this.#pump();
        };
        entry.resolve(entry.release);
      }
    } finally {
      this.pumping = false;
    }
  }
}

export class ChromeCdp {
  constructor({ port, endpoint, log = () => {} } = {}) {
    this.port = port;
    this.endpoint = endpoint;
    this.log = log;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.ws = null;
    this.connecting = null;
    this.closed = false;
    this.versionCache = null;
    this.versionCachedAt = 0;
    this.scheduler = new FairScheduler();
    this.connectedAt = 0;
  }

  /** Probe /json/version with a short cache; returns null when Chrome is down. */
  async version({ timeoutMs = 2000, cacheMs = 2000 } = {}) {
    const now = Date.now();
    if (this.versionCache && now - this.versionCachedAt < cacheMs) return this.versionCache;
    try {
      const response = await fetch(`${this.endpoint}/json/version`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (!body?.webSocketDebuggerUrl) throw new Error('DevTools endpoint returned no webSocketDebuggerUrl');
      this.versionCache = body;
      this.versionCachedAt = now;
      return body;
    } catch (error) {
      this.versionCache = null;
      this.versionCachedAt = now - cacheMs + 500; // retry soon, but not per command
      return null;
    }
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async ensure() {
    if (this.ws && this.ws.readyState === 1 && !this.closed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.#connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async #connect() {
    this.closed = false;
    const version = await this.version({ cacheMs: 0 });
    if (!version) {
      throw new CdpError(
        'CHROME_UNREACHABLE',
        `No Chrome DevTools endpoint on ${this.endpoint}; start Chrome with --remote-debugging-port=${this.port} or call launch`,
      );
    }
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        reject(new CdpError('CDP_TIMEOUT', `connecting to ${version.webSocketDebuggerUrl} timed out`));
      }, 8000);
      timer.unref?.();
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new CdpError('CHROME_UNREACHABLE', `WebSocket connect failed: ${version.webSocketDebuggerUrl}`));
        },
        { once: true },
      );
    });

    this.ws = socket;
    this.connectedAt = Date.now();
    socket.addEventListener('message', (event) => this.#onMessage(event));
    socket.addEventListener('close', () => this.#onClose());
    socket.addEventListener('error', (error) => this.log('[cdp] socket error', error?.message || String(error)));

    // Maintain target lifecycle events when the protocol supports discovery.
    // Failures are harmless (older builds, fakes without the domain). Use the
    // raw send here: ensure() is still pending on this connect promise.
    this.#rawSend('Target.setDiscoverTargets', { discover: true }, undefined, 5000).catch(() => {});
  }

  async send(method, params = {}, sessionId, { clientId, timeoutMs = CDP_TIMEOUT_MS } = {}) {
    await this.ensure();
    const ticket = this.scheduler.enqueue(clientId);
    let timedOut = false;
    let rejectTimeout;
    const timeout = new Promise((_, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      ticket.cancel();
      rejectTimeout(new CdpError('CDP_TIMEOUT', `CDP ${method} waited more than ${timeoutMs} ms for a channel slot`));
    }, timeoutMs);
    timer.unref?.();
    let release;
    try {
      release = await Promise.race([ticket.promise, timeout]);
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
    clearTimeout(timer);
    if (timedOut || ticket.cancelled) {
      release();
      throw new CdpError('CDP_TIMEOUT', `CDP ${method} was cancelled after ${timeoutMs} ms`);
    }
    try {
      return await this.#rawSend(method, params, sessionId, timeoutMs);
    } finally {
      release();
    }
  }

  #rawSend(method, params, sessionId, timeoutMs) {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new CdpError('CHROME_DISCONNECTED', 'CDP connection is not open'));
    }
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new CdpError('CDP_TIMEOUT', `CDP ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new CdpError('CHROME_DISCONNECTED', `failed to send CDP ${method}: ${error.message}`));
      }
    });
  }

  #onMessage(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
    } catch {
      return;
    }
    if (typeof message.id !== 'undefined' && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new CdpError(
            message.error.code === -32000 ? 'CDP_ERROR' : 'CDP_ERROR',
            `${message.error.message}${message.error.data ? ` :: ${message.error.data}` : ''}`,
            message.error,
          ),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message.method === 'string') {
      for (const listener of this.listeners) {
        try {
          listener(message);
        } catch (error) {
          this.log('[cdp] event listener failed', error?.message || String(error));
        }
      }
    }
  }

  #onClose() {
    this.closed = true;
    this.ws = null;
    this.versionCache = null;
    for (const pending of this.pending.values()) {
      pending.reject(new CdpError('CHROME_DISCONNECTED', 'CDP connection closed'));
    }
    this.pending.clear();
    for (const listener of this.listeners) {
      try {
        listener({ method: '__cdpClose', params: {} });
      } catch {
        /* ignore */
      }
    }
  }

  async close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
