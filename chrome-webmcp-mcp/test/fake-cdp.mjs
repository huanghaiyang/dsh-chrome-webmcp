/**
 * Zero-dependency fake Chrome DevTools endpoint for the WebMCP bridge tests.
 *
 * Speaks just enough of the real protocol for `broker.mjs`:
 *
 *   HTTP  GET /json/version  -> { webSocketDebuggerUrl, Browser, Protocol-Version }
 *         GET /json/list     -> page target list (some clients probe it)
 *   WS    masked client frames -> unmasked server text frames
 *
 *   CDP   Target.getTargets / createBrowserContext / disposeBrowserContext /
 *         createTarget / closeTarget / attachToTarget / getTargetInfo /
 *         setDiscoverTargets / getBrowserContexts
 *         Browser.getVersion / Browser.close
 *         Page.getFrameTree / Page.enable
 *         WebMCP.enable (replays toolsAdded per session) / WebMCP.disable /
 *         WebMCP.invokeTool -> { invocationId } then async toolResponded
 *
 * Every page target exposes three fixture tools:
 *   echo       -> { echo: input }
 *   slow_echo  -> waits `slowMs` then { echo: input, delay }
 *   fail_tool  -> status "Error"
 *
 * Usage:
 *   import { startFakeCdp } from './fake-cdp.mjs';
 *   const fake = await startFakeCdp({ slowMs: 300 });
 *   fake.port, fake.url, fake.stats, fake.createPage(url), fake.hasTarget(id)
 *   await fake.close();
 */
import http from 'node:http';
import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONTINUATION: 0, TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 };

const asString = (value) => (typeof value === 'string' ? value : '');

function websocketAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** Encode one unmasked server->client frame (server frames are never masked). */
export function encodeFrame(payload, opcode = OP.TEXT) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 0x10000) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

/**
 * Decode complete frames from a byte buffer. Returns parsed frames + remainder.
 * Handles 7/16/64-bit lengths and client masking; fragmentation is reassembled
 * by the connection handler below.
 */
export function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      const big = buffer.readBigUInt64BE(offset + 2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('frame too large');
      length = Number(big);
      headerLength = 10;
    }
    let maskKey = null;
    if (masked) {
      if (offset + headerLength + 4 > buffer.length) break;
      maskKey = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      headerLength += 4;
    }
    const start = offset + headerLength;
    const end = start + length;
    if (end > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(start, end));
    if (maskKey) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i & 3];
    }
    frames.push({ fin, opcode, payload });
    offset = end;
  }
  return { frames, rest: buffer.subarray(offset) };
}

function toolSchema(extra = {}) {
  return { type: 'object', properties: extra, additionalProperties: true };
}

function makeTools(targetId, frameId) {
  return [
    {
      name: 'echo',
      description: `Echo the input object back (target ${targetId}).`,
      inputSchema: toolSchema({ value: { type: 'string' }, nested: { type: 'object' } }),
      frameId,
    },
    {
      name: 'slow_echo',
      description: 'Echo the input object back after the fake page delay.',
      inputSchema: toolSchema({ value: { type: 'string' } }),
      frameId,
    },
    {
      name: 'fail_tool',
      description: 'Always responds with an error status.',
      inputSchema: toolSchema(),
      frameId,
    },
  ];
}

export class FakeCdp {
  constructor({ slowMs = 0 } = {}) {
    this.slowMs = slowMs;
    this.key = crypto.randomBytes(4).toString('hex');
    this.seq = { target: 0, context: 0, session: 0, invocation: 0 };
    this.targets = new Map();
    this.contexts = new Map();
    this.sessions = new Map();
    this.connections = new Set();
    this.timers = new Set();
    this.closed = false;
    this.server = null;
    this.port = null;
    this.host = '127.0.0.1';
    this.versionRequests = 0;
    this.closeFailures = new Set();
    this.stats = {
      /** Total WebMCP.enable calls (across sessions). */
      enables: 0,
      /** sessionId -> enable count (per CDP session, i.e. "per-session enable counter"). */
      enablesBySession: Object.create(null),
      /** targetId -> aggregate enable count across sessions attached to that target. */
      enablesByTarget: Object.create(null),
      /** Total WebMCP.invokeTool commands seen. */
      invokes: 0,
      /** Tool invocations currently waiting to emit toolResponded. */
      inflight: 0,
      /** Peak concurrent tool invocations (proves channels are not serialized). */
      maxInflight: 0,
      /** Browser.close calls. */
      browserCloseCalls: 0,
      /** Unknown CDP methods (answered with {} so a broker may probe harmlessly). */
      unknownMethods: Object.create(null),
      /** Frames that were not valid JSON. */
      parseErrors: 0,
      sessionsCreated: 0,
      targetsCreated: 0,
      targetsClosed: 0,
    };
  }

  // ---------------------------------------------------------------- lifecycle

  async listen({ port = 0, host = '127.0.0.1' } = {}) {
    this.host = host;
    this.server = http.createServer((req, res) => this.#onHttp(req, res));
    this.server.on('upgrade', (req, socket, head) => this.#onUpgrade(req, socket, head));
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      this.server.once('error', onError);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', onError);
        resolve();
      });
    });
    this.port = this.server.address().port;
    this.url = `http://${this.host}:${this.port}`;
    return this;
  }

  async close() {
    if (this.closed && !this.server) return;
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const connection of this.connections) {
      try {
        connection.socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this.connections.clear();
    const server = this.server;
    this.server = null;
    if (server && server.listening) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  }

  schedule(fn, ms) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.closed) return;
      try {
        fn();
      } catch {
        /* fixture must never crash the test process */
      }
    }, Math.max(0, ms));
    timer.unref?.();
    this.timers.add(timer);
    return timer;
  }

  // ---------------------------------------------------------------- page API

  /** Create a page target directly in Chrome (i.e. not owned by the broker). */
  createPage(url = 'about:blank', { browserContextId } = {}) {
    const n = ++this.seq.target;
    const targetId = `T${n}-${this.key}`;
    const target = {
      targetId,
      type: 'page',
      url,
      title: `Fake Page ${n}`,
      browserContextId: browserContextId || undefined,
      frameId: `F${n}-${this.key}`,
      tools: makeTools(targetId, `F${n}-${this.key}`),
      createdAt: Date.now(),
    };
    this.targets.set(targetId, target);
    this.stats.targetsCreated += 1;
    this.emit('Target.targetCreated', { targetInfo: this.#targetInfo(target) });
    return targetId;
  }

  hasTarget(targetId) {
    return this.targets.has(targetId);
  }

  hasContext(browserContextId) {
    return this.contexts.has(browserContextId);
  }

  getTarget(targetId) {
    return this.targets.get(targetId);
  }

  targetIds() {
    return [...this.targets.keys()];
  }

  /** Number of live sessions attached to a target (broker should keep exactly one). */
  sessionCountFor(targetId) {
    let count = 0;
    for (const session of this.sessions.values()) if (session.targetId === targetId) count += 1;
    return count;
  }

  enableCountFor(targetId) {
    return this.stats.enablesByTarget[targetId] || 0;
  }

  setSlowMs(ms) {
    this.slowMs = ms;
  }

  /** Make `Target.closeTarget` fail for one target (ownership-retention tests). */
  setCloseFailure(targetId, enabled = true) {
    if (enabled) this.closeFailures.add(targetId);
    else this.closeFailures.delete(targetId);
  }

  // ---------------------------------------------------------------- HTTP

  #onHttp(req, res) {
    const url = asString(req.url);
    const pathname = url.split('?')[0];
    if (pathname === '/json/version') {
      this.versionRequests += 1;
      this.#json(res, 200, {
        Browser: 'FakeChrome/2.0',
        'Protocol-Version': '1.3',
        webSocketDebuggerUrl: `ws://${this.host}:${this.port}/devtools/browser/fake`,
        'User-Agent': 'FakeChrome',
        V8Version: '0.0.0',
      });
      return;
    }
    if (pathname === '/json/list' || pathname === '/json') {
      this.#json(
        res,
        200,
        [...this.targets.values()].map((target) => ({
          id: target.targetId,
          type: target.type,
          title: target.title,
          url: target.url,
          webSocketDebuggerUrl: `ws://${this.host}:${this.port}/devtools/page/${target.targetId}`,
        })),
      );
      return;
    }
    this.#json(res, 404, { error: `fake-cdp: unknown path ${pathname}` });
  }

  #json(res, status, body) {
    try {
      const text = JSON.stringify(body);
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=UTF-8',
        'Content-Length': Buffer.byteLength(text),
      });
      res.end(text);
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- WebSocket

  #onUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
      '\r\n',
    ];
    socket.write(headers.join('\r\n'));
    socket.setNoDelay?.(true);
    const connection = { socket, buffer: Buffer.alloc(0), fragment: null, closed: false };
    this.connections.add(connection);
    socket.on('data', (chunk) => this.#onSocketData(connection, chunk));
    socket.on('error', () => this.#dropConnection(connection));
    socket.on('close', () => this.#dropConnection(connection));
    if (head && head.length) this.#onSocketData(connection, head);
  }

  #dropConnection(connection) {
    if (connection.closed) return;
    connection.closed = true;
    this.connections.delete(connection);
    try {
      connection.socket.destroy();
    } catch {
      /* ignore */
    }
  }

  #onSocketData(connection, chunk) {
    if (connection.closed || this.closed) return;
    connection.buffer = Buffer.concat([connection.buffer, chunk]);
    let parsed;
    try {
      parsed = decodeFrames(connection.buffer);
    } catch {
      this.#dropConnection(connection);
      return;
    }
    connection.buffer = parsed.rest;
    for (const frame of parsed.frames) this.#onFrame(connection, frame);
  }

  #onFrame(connection, frame) {
    if (connection.closed) return;
    if (frame.opcode === OP.CLOSE) {
      try {
        connection.socket.write(encodeFrame(frame.payload, OP.CLOSE));
      } catch {
        /* ignore */
      }
      this.#dropConnection(connection);
      return;
    }
    if (frame.opcode === OP.PING) {
      try {
        connection.socket.write(encodeFrame(frame.payload, OP.PONG));
      } catch {
        /* ignore */
      }
      return;
    }
    if (frame.opcode === OP.PONG) return;

    if (frame.opcode === OP.CONTINUATION) {
      if (!connection.fragment) return;
      connection.fragment.chunks.push(frame.payload);
      if (!frame.fin) return;
      const opcode = connection.fragment.opcode;
      const payload = Buffer.concat(connection.fragment.chunks);
      connection.fragment = null;
      this.#onMessage(connection, opcode, payload);
      return;
    }
    if (frame.opcode === OP.TEXT || frame.opcode === OP.BINARY) {
      if (!frame.fin) {
        connection.fragment = { opcode: frame.opcode, chunks: [frame.payload] };
        return;
      }
      this.#onMessage(connection, frame.opcode, frame.payload);
    }
  }

  #onMessage(connection, opcode, payload) {
    let message;
    try {
      message = JSON.parse(payload.toString('utf8'));
    } catch {
      this.stats.parseErrors += 1;
      return;
    }
    if (!message || typeof message !== 'object') return;
    // CDP notifications from the client are not part of the broker contract.
    if (typeof message.id === 'undefined') return;
    Promise.resolve()
      .then(() => this.#dispatch(connection, message))
      .catch((error) => {
        this.#send(connection, {
          id: message.id,
          ...(message.sessionId ? { sessionId: message.sessionId } : {}),
          error: { code: -32000, message: String(error?.message || error) },
        });
      });
  }

  #send(connection, value) {
    if (connection.closed || this.closed) return;
    try {
      connection.socket.write(encodeFrame(JSON.stringify(value)));
    } catch {
      this.#dropConnection(connection);
    }
  }

  /** Emit a CDP event; protocol events go to every open browser connection. */
  emit(method, params = {}, sessionId) {
    if (this.closed) return;
    const frame = { method, params };
    if (sessionId) frame.sessionId = sessionId;
    const text = JSON.stringify(frame);
    for (const connection of this.connections) {
      if (connection.closed) continue;
      try {
        connection.socket.write(encodeFrame(text));
      } catch {
        this.#dropConnection(connection);
      }
    }
  }

  // ---------------------------------------------------------------- CDP

  #targetInfo(target) {
    return {
      targetId: target.targetId,
      type: target.type,
      title: target.title,
      url: target.url,
      attached: this.sessionCountFor(target.targetId) > 0,
      canAccessOpener: false,
      ...(target.browserContextId ? { browserContextId: target.browserContextId } : {}),
    };
  }

  #reply(connection, request, result) {
    this.#send(connection, {
      id: request.id,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      result,
    });
  }

  #fail(connection, request, code, message) {
    this.#send(connection, {
      id: request.id,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      error: { code, message },
    });
  }

  #targetForSession(sessionId) {
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    return session ? this.targets.get(session.targetId) : undefined;
  }

  async #dispatch(connection, request) {
    const method = request.method;
    const params = request.params && typeof request.params === 'object' ? request.params : {};
    const sessionId = request.sessionId;
    const reply = (result) => this.#reply(connection, request, result);
    const fail = (message, code = -32602) => this.#fail(connection, request, code, message);

    switch (method) {
      case 'Browser.getVersion': {
        reply({
          protocolVersion: '1.3',
          product: 'FakeChrome/2.0',
          revision: 'fake',
          userAgent: 'FakeChrome/2.0',
          jsVersion: '0.0.0',
        });
        return;
      }
      case 'Browser.close': {
        this.stats.browserCloseCalls += 1;
        reply({});
        this.schedule(() => {
          this.closed = true;
          for (const conn of this.connections) this.#dropConnection(conn);
          const server = this.server;
          this.server = null;
          if (server && server.listening) server.close(() => {});
        }, 10);
        return;
      }
      case 'Target.getTargets': {
        const targetInfos = [...this.targets.values()].map((target) => this.#targetInfo(target));
        // `targetInfos` is the real CDP shape; `pages` mirrors it for fixtures/docs.
        reply({ targetInfos, pages: targetInfos });
        return;
      }
      case 'Target.getTargetInfo': {
        const target = this.targets.get(params.targetId);
        if (!target) return fail(`No target with targetId ${params.targetId}`);
        reply({ targetInfo: this.#targetInfo(target) });
        return;
      }
      case 'Target.createTarget': {
        let browserContextId = params.browserContextId;
        if (browserContextId && !this.contexts.has(browserContextId)) {
          return fail(`No browser context with id ${browserContextId}`);
        }
        const targetId = this.createPage(params.url || 'about:blank', { browserContextId });
        reply({ targetId });
        return;
      }
      case 'Target.closeTarget': {
        const target = this.targets.get(params.targetId);
        if (!target) return fail(`No target with targetId ${params.targetId}`);
        if (this.closeFailures.has(params.targetId)) return fail(`mock close failure for ${params.targetId}`);
        this.#destroyTarget(target);
        reply({ success: true });
        return;
      }
      case 'Target.attachToTarget': {
        const target = this.targets.get(params.targetId);
        if (!target) return fail(`No target with targetId ${params.targetId}`);
        const sessionId = `S${++this.seq.session}-${this.key}`;
        this.sessions.set(sessionId, {
          sessionId,
          targetId: target.targetId,
          enableCount: 0,
          createdAt: Date.now(),
        });
        this.stats.sessionsCreated += 1;
        reply({ sessionId });
        return;
      }
      case 'Target.detachFromTarget': {
        if (params.sessionId) this.sessions.delete(params.sessionId);
        reply({});
        return;
      }
      case 'Target.createBrowserContext': {
        const browserContextId = `C${++this.seq.context}-${this.key}`;
        this.contexts.set(browserContextId, { browserContextId, createdAt: Date.now() });
        reply({ browserContextId });
        return;
      }
      case 'Target.disposeBrowserContext': {
        const browserContextId = params.browserContextId;
        if (!this.contexts.has(browserContextId)) {
          return fail(`No browser context with id ${browserContextId}`);
        }
        for (const target of [...this.targets.values()]) {
          if (target.browserContextId === browserContextId) this.#destroyTarget(target);
        }
        this.contexts.delete(browserContextId);
        reply({});
        return;
      }
      case 'Target.getBrowserContexts': {
        reply({ browserContextIds: [...this.contexts.keys()] });
        return;
      }
      case 'Target.setDiscoverTargets': {
        reply({});
        if (params.discover) {
          for (const target of this.targets.values()) {
            this.emit('Target.targetCreated', { targetInfo: this.#targetInfo(target) });
          }
        }
        return;
      }
      case 'Target.setAutoAttach':
      case 'Target.activateTarget':
      case 'Target.setAttachToFrames':
      case 'Page.enable':
      case 'Page.disable':
      case 'Runtime.enable':
      case 'Runtime.disable':
      case 'Inspector.enable':
      case 'Inspector.disable':
      case 'Target.detachFromFrame': {
        reply({});
        return;
      }
      case 'Page.getFrameTree':
      case 'Target.getFrameTree': {
        const target = this.#targetForSession(sessionId) || this.targets.get(params.targetId);
        if (!target) return fail('No target for frame tree');
        reply({
          frameTree: {
            frame: {
              id: target.frameId,
              loaderId: `L-${target.targetId}`,
              url: target.url,
              domainAndRegistry: '',
              securityOrigin: target.url,
              mimeType: 'text/html',
            },
            childFrames: [],
          },
        });
        return;
      }
      case 'WebMCP.enable': {
        const session = sessionId ? this.sessions.get(sessionId) : undefined;
        if (!session) return fail('WebMCP.enable requires an attached session');
        const target = this.targets.get(session.targetId);
        if (!target) return fail('Target for session is gone');
        reply({});
        this.stats.enables += 1;
        this.stats.enablesBySession[sessionId] = (this.stats.enablesBySession[sessionId] || 0) + 1;
        this.stats.enablesByTarget[target.targetId] =
          (this.stats.enablesByTarget[target.targetId] || 0) + 1;
        session.enableCount += 1;
        // Chrome replays one toolsAdded per registered tool after enable resolves.
        this.schedule(() => {
          for (const tool of target.tools) {
            this.emit('WebMCP.toolsAdded', { tools: [tool], tool }, sessionId);
          }
        }, 5);
        return;
      }
      case 'WebMCP.disable': {
        reply({});
        return;
      }
      case 'WebMCP.invokeTool': {
        const session = sessionId ? this.sessions.get(sessionId) : undefined;
        if (!session) return fail('WebMCP.invokeTool requires an attached session');
        const target = this.targets.get(session.targetId);
        if (!target) return fail('Target for session is gone');
        const tool = target.tools.find((entry) => entry.name === params.toolName);
        if (!tool) return fail(`Tool "${params.toolName}" is not registered on this page`);
        const invocationId = `I${++this.seq.invocation}-${this.key}`;
        this.stats.invokes += 1;
        this.stats.inflight += 1;
        this.stats.maxInflight = Math.max(this.stats.maxInflight, this.stats.inflight);
        // The command resolves immediately; the response arrives as an event later.
        reply({ invocationId });
        this.emit(
          'WebMCP.toolInvoked',
          {
            invocationId,
            toolName: tool.name,
            frameId: params.frameId || target.frameId,
            input: params.input ?? {},
            inputType: 'object',
          },
          sessionId,
        );
        const delay = tool.name === 'slow_echo' ? Math.max(0, Number(this.slowMs) || 0) : 0;
        this.schedule(() => {
          this.stats.inflight = Math.max(0, this.stats.inflight - 1);
          const { status, output } = this.#runTool(tool.name, params.input, delay);
          this.emit(
            'WebMCP.toolResponded',
            {
              invocationId,
              status,
              output,
              toolName: tool.name,
              frameId: params.frameId || target.frameId,
            },
            sessionId,
          );
        }, delay);
        return;
      }
      default: {
        // Permissive: probing an implemented-elsewhere domain must not break the broker.
        this.stats.unknownMethods[method] = (this.stats.unknownMethods[method] || 0) + 1;
        reply({});
      }
    }
  }

  #runTool(name, input, delay) {
    if (name === 'echo') return { status: 'Completed', output: { echo: input ?? {} } };
    if (name === 'slow_echo') {
      return { status: 'Completed', output: { echo: input ?? {}, delay } };
    }
    if (name === 'fail_tool') {
      return { status: 'Error', output: { error: 'fail_tool always fails' } };
    }
    return { status: 'Completed', output: {} };
  }

  #destroyTarget(target) {
    if (!this.targets.has(target.targetId)) return;
    this.targets.delete(target.targetId);
    this.stats.targetsClosed += 1;
    for (const [sessionId, session] of [...this.sessions.entries()]) {
      if (session.targetId === target.targetId) this.sessions.delete(sessionId);
    }
    this.emit('Target.targetDestroyed', { targetId: target.targetId });
  }
}

/** Start a fake CDP endpoint on an ephemeral port. */
export async function start(options = {}) {
  const fake = new FakeCdp({ slowMs: options.slowMs ?? 0 });
  await fake.listen(options);
  return fake;
}

export const startFakeCdp = start;
export default start;
