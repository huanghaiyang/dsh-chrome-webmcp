/**
 * Per-page WebMCP session registry.
 *
 * Chrome registers the WebMCP CDP domain on a page session, replays the page's
 * registered tools after `WebMCP.enable`, then reports incremental changes. The
 * registry below attaches and enables once per target, keeps the tool map up to
 * date from events, and resolves tool invocations by `invocationId` without
 * polling the CDP channel.
 */
import { INVOKE_WAIT_MS, MAX_TOOL_WAIT_MS, TOOL_SETTLE_MS } from './config.mjs';
import { CdpError } from './cdp.mjs';

const clampWait = (value, fallback) => {
  const n = Number(value);
  const chosen = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.min(Math.max(Math.floor(chosen), 50), MAX_TOOL_WAIT_MS);
};

const mapAttachError = (targetId, error) => {
  if (error instanceof CdpError) {
    if (/no target|not found|target.*closed/i.test(error.message)) {
      return new CdpError('TARGET_NOT_FOUND', `page target ${targetId} is not available`, { targetId });
    }
  }
  return error;
};

export class SessionBook {
  constructor({ cdp, log = () => {}, settleMs = TOOL_SETTLE_MS, invokeWaitMs = INVOKE_WAIT_MS }) {
    this.cdp = cdp;
    this.log = log;
    this.settleMs = settleMs;
    this.invokeWaitMs = invokeWaitMs;
    this.sessions = new Map(); // targetId -> session
    this.bySession = new Map(); // sessionId -> targetId
    this.ensuring = new Map(); // targetId -> promise
    this.waiters = new Map(); // invocationId -> waiter
    this.recent = new Map(); // invocationId -> {params, at} for result-before-ack races
    this.invocations = new Map(); // invocationId -> diagnostics
    cdp.onEvent((message) => this.#onEvent(message));
  }

  #session(targetId) {
    return this.sessions.get(targetId);
  }

  async ensure(targetId, { waitMs = this.settleMs, refresh = false } = {}) {
    const wait = clampWait(waitMs, this.settleMs);
    let session = this.sessions.get(targetId);
    if (session && !refresh && session.enabled) return session;
    if (session && !refresh && session.enabling) {
      await session.enabling;
      return session;
    }
    if (session && refresh) {
      await this.refresh(session, wait);
      return session;
    }
    const existing = this.ensuring.get(targetId);
    if (existing) return existing;
    const promise = (async () => {
      const attached = await this.cdp
        .send('Target.attachToTarget', { targetId, flatten: true }, undefined, { timeoutMs: 15000 })
        .catch((error) => {
          throw mapAttachError(targetId, error);
        });
      session = {
        targetId,
        sessionId: attached.sessionId,
        tools: new Map(),
        enabled: false,
        enabling: null,
        listeners: new Set(),
        lastEventAt: 0,
        attachedAt: Date.now(),
        refreshChain: Promise.resolve(),
        enableCount: 0,
      };
      this.sessions.set(targetId, session);
      this.bySession.set(session.sessionId, targetId);
      await this.#enable(session, wait);
      return session;
    })();
    this.ensuring.set(targetId, promise);
    try {
      return await promise;
    } finally {
      this.ensuring.delete(targetId);
    }
  }

  async #enable(session, waitMs) {
    if (session.enabling) return session.enabling;
    session.enabling = (async () => {
      const settled = this.#settle(session, waitMs);
      try {
        await this.cdp.send('WebMCP.enable', {}, session.sessionId, { timeoutMs: 15000 });
        session.enableCount += 1;
      } catch (error) {
        this.#dropSession(session);
        throw error;
      }
      await settled;
      session.enabled = true;
    })();
    try {
      await session.enabling;
    } finally {
      session.enabling = null;
    }
  }

  async refresh(session, waitMs = this.settleMs) {
    session.refreshChain = session.refreshChain
      .catch(() => {})
      .then(() => this.#enable(session, waitMs));
    return session.refreshChain;
  }

  /**
   * Resolve when Chrome stopped replaying tool changes: after a quiet window
   * once events start, after a short idle window when the page has no tools,
   * or hard at `waitMs`. Never a fixed sleep on every discovery.
   */
  #settle(session, waitMs) {
    return new Promise((resolve) => {
      let quietTimer = null;
      let hardTimer = null;
      const finish = () => {
        if (quietTimer) clearTimeout(quietTimer);
        if (hardTimer) clearTimeout(hardTimer);
        session.listeners.delete(onEvent);
        resolve();
      };
      const onEvent = () => {
        session.lastEventAt = Date.now();
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, 120);
        quietTimer.unref?.();
      };
      session.listeners.add(onEvent);
      hardTimer = setTimeout(finish, waitMs);
      hardTimer.unref?.();
      // No replay at all means the page simply has no tools: do not wait the
      // full budget on every first discovery.
      quietTimer = setTimeout(finish, Math.min(waitMs, 450));
      quietTimer.unref?.();
    });
  }

  async listTools(targetId, { waitMs, refresh = false, clientId } = {}) {
    const session = await this.ensure(targetId, { waitMs, refresh });
    return [...session.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      frameId: tool.frameId,
    }));
  }

  /**
   * Invoke one tool and resolve with its `toolResponded` payload.
   *
   * The waiter is installed before the CDP command is sent; a response that
   * arrives before the `{invocationId}` acknowledgement is parked in `recent`
   * and consumed immediately afterwards.
   */
  async invoke(targetId, { frameId, toolName, input, waitMs, clientId } = {}) {
    const wait = clampWait(waitMs, this.invokeWaitMs);
    const session = await this.ensure(targetId, { waitMs: Math.min(wait, this.settleMs) });
    const tool = session.tools.get(toolName);
    const frame = frameId || tool?.frameId;
    if (!frame) {
      throw new CdpError('TOOL_NOT_FOUND', `WebMCP tool "${toolName}" is not registered on target ${targetId}`, {
        targetId,
        toolName,
        available: [...session.tools.keys()],
      });
    }

    const startedAt = Date.now();
    let response = await this.cdp.send(
      'WebMCP.invokeTool',
      { frameId: frame, toolName, input: input ?? {} },
      session.sessionId,
      { clientId, timeoutMs: Math.min(wait, 15000) },
    );
    const invocationId = response?.invocationId;
    if (!invocationId) {
      throw new CdpError('INTERNAL', 'WebMCP.invokeTool returned no invocationId');
    }
    this.invocations.set(invocationId, { targetId, sessionId: session.sessionId, toolName, startedAt });
    const forgetTimer = setTimeout(() => this.invocations.delete(invocationId), 300000);
    forgetTimer.unref?.();

    const parked = this.recent.get(invocationId);
    if (parked) {
      this.recent.delete(invocationId);
      this.#forgetInvocation(invocationId);
      return {
        status: parked.params.status ?? 'Completed',
        output: parked.params.output ?? null,
        invocationId,
        durationMs: Date.now() - startedAt,
      };
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(invocationId);
        this.#forgetInvocation(invocationId);
        reject(
          new CdpError('TOOL_TIMEOUT', `tool "${toolName}" did not respond within ${wait} ms`, {
            targetId,
            toolName,
            invocationId,
          }),
        );
      }, wait);
      timer.unref?.();
      this.waiters.set(invocationId, {
        targetId,
        toolName,
        resolve: (params) => {
          clearTimeout(timer);
          resolve({
            status: params.status ?? 'Completed',
            output: params.output ?? null,
            invocationId,
            durationMs: Date.now() - startedAt,
          });
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  #forgetInvocation(invocationId) {
    const invocation = this.invocations.get(invocationId);
    if (!invocation) return;
    if (Date.now() - invocation.startedAt > 300000) this.invocations.delete(invocationId);
  }

  #dropSession(session) {
    if (!session) return;
    this.sessions.delete(session.targetId);
    this.bySession.delete(session.sessionId);
    this.ensuring.delete(session.targetId);
    for (const [invocationId, waiter] of this.waiters) {
      if (waiter.targetId !== session.targetId) continue;
      this.waiters.delete(invocationId);
      waiter.reject(
        new CdpError('TARGET_GONE', `page target ${session.targetId} was closed or detached`, {
          targetId: session.targetId,
        }),
      );
    }
  }

  dropTarget(targetId) {
    const session = this.sessions.get(targetId);
    this.#dropSession(session);
    if (!session) {
      for (const [invocationId, waiter] of this.waiters) {
        if (waiter.targetId !== targetId) continue;
        this.waiters.delete(invocationId);
        waiter.reject(new CdpError('TARGET_GONE', `page target ${targetId} was closed or detached`, { targetId }));
      }
    }
  }

  #onEvent(message) {
    if (message.method === '__cdpClose') {
      for (const waiter of this.waiters.values()) {
        waiter.reject(new CdpError('CHROME_DISCONNECTED', 'Chrome DevTools connection closed'));
      }
      this.waiters.clear();
      this.sessions.clear();
      this.bySession.clear();
      this.ensuring.clear();
      this.recent.clear();
      return;
    }
    if (message.method === 'Target.targetDestroyed') {
      const targetId = message.params?.targetId;
      if (targetId) this.dropTarget(targetId);
      return;
    }
    if (message.method === 'Inspector.detached') {
      const targetId = this.bySession.get(message.sessionId);
      if (targetId) this.dropTarget(targetId);
      return;
    }
    if (message.method === 'WebMCP.toolResponded') {
      const invocationId = message.params?.invocationId;
      if (!invocationId) return;
      const waiter = this.waiters.get(invocationId);
      if (waiter) {
        this.waiters.delete(invocationId);
        waiter.resolve(message.params);
      } else {
        this.recent.set(invocationId, { params: message.params, at: Date.now() });
        const timer = setTimeout(() => this.recent.delete(invocationId), 60000);
        timer.unref?.();
      }
      return;
    }
    const targetId = this.bySession.get(message.sessionId);
    if (!targetId) return;
    const session = this.sessions.get(targetId);
    if (!session) return;

    if (message.method === 'WebMCP.toolsAdded') {
      for (const tool of message.params?.tools || []) {
        if (tool?.name) session.tools.set(tool.name, tool);
      }
      session.lastEventAt = Date.now();
      for (const listener of session.listeners) listener();
      return;
    }
    if (message.method === 'WebMCP.toolsRemoved') {
      for (const tool of message.params?.tools || []) {
        if (tool?.name) session.tools.delete(tool.name);
      }
      session.lastEventAt = Date.now();
      for (const listener of session.listeners) listener();
      return;
    }
  }

  stats() {
    return {
      sessions: this.sessions.size,
      waiters: this.waiters.size,
      recent: this.recent.size,
    };
  }
}
