#!/usr/bin/env node
/**
 * Chrome WebMCP bridge - MCP stdio client (v2).
 *
 * One process per MCP host. This single entry point has two modes:
 *
 *   node bridge.mjs            MCP stdio server. Newline-delimited JSON-RPC 2.0
 *                              on stdin/stdout; every tool call becomes exactly
 *                              one request to the local broker over lib/ipc.mjs.
 *   node bridge.mjs --broker   Broker process (owns Chrome/CDP). Imports
 *                              ./broker.mjs and awaits runBroker().
 *
 * The broker is shared per Chrome DevTools port. It is connected lazily and
 * spawned detached (stdio ignored) on the first call that finds nothing
 * listening on the IPC endpoint. A lost connection fails the in-flight call;
 * the next call reconnects. Mutating calls are never retried behind the model.
 *
 * stdout carries protocol frames only; every diagnostic goes to stderr.
 * Zero dependencies, Node >= 22.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import {
  BRIDGE_ENTRY,
  BROKER_START_WAIT_MS,
  IPC_NAME,
  LOG_FILE,
  SERVER_NAME,
  VERSION,
  sleep,
} from './lib/config.mjs';
import { connectIpc, IpcError } from './lib/ipc.mjs';

const log = (...args) => console.error('[chrome-webmcp]', ...args);

const isBrokerMode = process.argv.includes('--broker');
const isMain =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

/** One MCP client process = one broker client. Identifies this process in hello. */
const CLIENT_ID = `mcp-${process.pid}-${randomBytes(2).toString('hex')}`;

/** Default task namespace (contract section 3). */
const DEFAULT_TASK_ID = 'default';

/** Non-wait broker methods allow 45 s (contract section 6). */
const BASE_REQUEST_TIMEOUT_MS = 45000;
/** Extra headroom over a caller's waitMs for broker/IPC overhead. */
const WAIT_HEADROOM_MS = 15000;
/** A hello round trip is cheap; a stuck handshake means a broken broker. */
const HELLO_TIMEOUT_MS = 10000;
/** Initial connect attempt; when this fails the broker is spawned and retried. */
const CONNECT_TIMEOUT_MS = 2000;
/** Pause between broker start attempts. */
const BROKER_CONNECT_RETRY_MS = 200;

// ---------------------------------------------------------------------------
// Broker connection (lazy, single-flight, reconnecting on the next call)
// ---------------------------------------------------------------------------

/** @type {import('./lib/ipc.mjs').LineChannel | null} */
let channel = null;
/** Single-flight guard so concurrent tool calls share one connect + hello. */
let connecting = null;

function attachChannel(connected) {
  connected.onClose = () => {
    if (channel === connected) channel = null;
    log('broker connection closed; the next tool call will reconnect');
  };
  channel = connected;
  return connected;
}

/** Connect to the broker endpoint and perform the one-per-connection hello. */
async function connectAndHandshake() {
  const connected = await connectIpc(IPC_NAME, { timeoutMs: CONNECT_TIMEOUT_MS });
  try {
    const hello = await connected.request(
      'hello',
      { clientId: CLIENT_ID, pid: process.pid, version: VERSION, taskId: DEFAULT_TASK_ID },
      { timeoutMs: HELLO_TIMEOUT_MS },
    );
    attachChannel(connected);
    log(`connected to broker ${hello?.brokerId ?? '?'} on ${IPC_NAME}`);
    return connected;
  } catch (error) {
    try {
      connected.close();
    } catch {
      /* already gone */
    }
    throw error;
  }
}

/** Spawn `node bridge.mjs --broker` detached; its stdout/stderr are not ours. */
function spawnBrokerProcess() {
  try {
    const child = spawn(process.execPath, [BRIDGE_ENTRY, '--broker'], {
      stdio: 'ignore',
      windowsHide: true,
      detached: true,
      env: process.env,
    });
    child.on('error', (error) => log('failed to spawn broker:', error?.message || error));
    child.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        log(`spawned broker exited early (code ${code}${signal ? `, ${signal}` : ''})`);
      }
    });
    child.unref();
    log(`nothing listening on ${IPC_NAME}; spawned broker pid ${child.pid ?? '?'}`);
    return child;
  } catch (error) {
    log('failed to spawn broker:', error?.message || error);
    return null;
  }
}

/**
 * Establish a broker channel: connect, or spawn the broker and retry until
 * BROKER_START_WAIT_MS expires. The spawn only happens before any request is
 * sent, so this loop can never replay a mutating operation.
 */
async function establishBroker() {
  let lastError;
  try {
    return await connectAndHandshake();
  } catch (error) {
    lastError = error;
  }

  spawnBrokerProcess();
  const deadline = Date.now() + BROKER_START_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(BROKER_CONNECT_RETRY_MS);
    try {
      return await connectAndHandshake();
    } catch (error) {
      lastError = error;
    }
  }

  const detail = lastError?.message || lastError?.code || 'no response';
  throw new IpcError(
    'BROKER_UNAVAILABLE',
    `broker did not become reachable on ${IPC_NAME} within ${BROKER_START_WAIT_MS} ms ` +
      `(last error: ${detail}). Check ${LOG_FILE}.`,
  );
}

/** Return the live broker channel, connecting once and sharing the attempt. */
function ensureBroker() {
  if (channel && !channel.closed) return Promise.resolve(channel);
  channel = null;
  if (!connecting) {
    connecting = establishBroker().finally(() => {
      connecting = null;
    });
  }
  return connecting;
}

/** One broker IPC request. Never retried: a mutation must not run twice. */
async function brokerRequest(method, params, timeoutMs) {
  const connected = await ensureBroker();
  if (connected.closed) {
    channel = null;
    throw new IpcError(
      'IPC_CLOSED',
      'broker connection closed before the request was sent; call again to reconnect',
    );
  }
  return connected.request(method, params, { timeoutMs });
}

/** Normalize anything thrown into an IpcError the MCP layer can format. */
function toBridgeError(error) {
  if (error instanceof IpcError) return error;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'INTERNAL';
  return new IpcError(code, error?.message ? String(error.message) : String(error));
}

/**
 * MCP error text: `Error [CODE]: message`, plus the broker's `data.message`
 * when that carries extra page-facing detail.
 */
function formatBrokerError(error) {
  const code = error?.code || 'INTERNAL';
  const message = error?.message || String(error);
  let text = `Error [${code}]: ${message}`;
  const detail = error?.data;
  if (detail && typeof detail === 'object' && typeof detail.message === 'string') {
    if (!message.includes(detail.message)) text += `\n${detail.message}`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Tool definitions (contract section 6). Exactly seven, one IPC request each.
// ---------------------------------------------------------------------------

const TASK_ID_PARAM = {
  type: 'string',
  description:
    'Task namespace: letters, digits, "." "_" "-", 1-64 chars, default "default". ' +
    'Use a distinct taskId per concurrent task and reuse the taskId returned by open_page ' +
    'so that its pages stay addressable.',
};

const TARGET_ID_PARAM = {
  type: 'string',
  description:
    'Exact page targetId from status, list_tools, or open_page. ' +
    'Omit to consider every page this task can use.',
};

const URL_FILTER_PARAM = {
  type: 'string',
  description: 'Only consider pages whose URL contains this substring. Ignored when targetId is set.',
};

const TOOLS = [
  {
    name: 'status',
    method: 'status',
    paramNames: ['taskId', 'detail'],
    description:
      'Read-only snapshot of the bridge for one task: Chrome reachability and version, ' +
      'broker process facts, and the pages this task owns. Never attaches to a page or ' +
      'enables WebMCP.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: TASK_ID_PARAM,
        detail: {
          type: 'string',
          enum: ['summary', 'full'],
          description:
            '"summary" (default) reports only this task. "full" adds other tasks as ' +
            '{id, pages, lastUsedAt} and never their URLs.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_tools',
    method: 'list_tools',
    paramNames: ['taskId', 'targetId', 'url', 'waitMs', 'refresh'],
    description:
      'List the WebMCP tools registered by pages this task can use: its own pages plus ' +
      'unowned pages. Pages owned by other tasks are never candidates.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: TASK_ID_PARAM,
        targetId: TARGET_ID_PARAM,
        url: URL_FILTER_PARAM,
        waitMs: {
          type: 'number',
          description:
            'First-discovery settle window in ms (default CHROME_TOOL_SETTLE_MS = 1200; ' +
            'pages already discovered answer from cache). The request timeout is waitMs + 15000.',
        },
        refresh: {
          type: 'boolean',
          description:
            'true re-enables WebMCP on the pages and waits for a fresh tools replay; ' +
            'default false returns the cached registry.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'invoke_tool',
    method: 'invoke_tool',
    paramNames: ['taskId', 'toolName', 'input', 'targetId', 'url', 'frameId', 'waitMs'],
    description:
      'Invoke a WebMCP tool and return its result. Searches this task\u2019s owned pages ' +
      '(most recently used first), then unowned pages; sets ambiguous when more than one ' +
      'candidate registers the tool.',
    inputSchema: {
      type: 'object',
      properties: {
        toolName: {
          type: 'string',
          description: 'Registered tool name exactly as reported by list_tools.',
        },
        input: {
          type: 'object',
          additionalProperties: true,
          description: 'Arguments object matching the tool inputSchema. Default {}.',
        },
        taskId: TASK_ID_PARAM,
        targetId: TARGET_ID_PARAM,
        url: URL_FILTER_PARAM,
        frameId: {
          type: 'string',
          description:
            'Frame id from list_tools. Requires targetId; without one the call fails with ' +
            'FRAME_WITHOUT_TARGET.',
        },
        waitMs: {
          type: 'number',
          description:
            'How long to wait for the tool response in ms (default CHROME_INVOKE_WAIT_MS = ' +
            '20000, cap 120000). The request timeout is waitMs + 15000.',
        },
      },
      required: ['toolName'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_page',
    method: 'open_page',
    paramNames: ['taskId', 'url', 'isolated', 'waitMs'],
    description:
      'Create a new page owned by this task and return its targetId plus the tools it ' +
      'registers. Reuse the returned taskId/targetId for list_tools and invoke_tool.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to open in a new page owned by this task.',
        },
        taskId: TASK_ID_PARAM,
        isolated: {
          type: 'boolean',
          description:
            'true opens the page in a task-exclusive isolated browser context (separate ' +
            'cookies/storage); default false uses the shared default context.',
        },
        waitMs: {
          type: 'number',
          description:
            'Bounds page load plus first tool discovery in ms (default 2500). ' +
            'The request timeout is waitMs + 15000.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'launch',
    method: 'launch',
    paramNames: ['url', 'timeoutMs'],
    description:
      'Start Chrome with remote debugging and the WebMCP features enabled when nothing is ' +
      'listening on the DevTools port. Never closes pages or tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Initial URL to open (default about:blank).',
        },
        timeoutMs: {
          type: 'number',
          description:
            'How long to wait for the DevTools port in ms (default CHROME_LISTEN_WAIT_MS = ' +
            '25000). The request timeout is timeoutMs + 15000.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'close',
    method: 'close_task',
    paramNames: ['taskId'],
    description:
      'Close only the pages owned by this task and dispose its isolated browser context. ' +
      'Never closes unowned pages, other tasks\u2019 pages, or Chrome.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          ...TASK_ID_PARAM,
          description:
            'Task namespace to close, default "default". Only pages opened by this task ' +
            'through open_page are closed; unowned pages and other tasks are untouched.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'close_browser',
    method: 'close_browser',
    paramNames: ['confirm'],
    description:
      'Shut down the Chrome instance reachable on the DevTools port. Only call this after ' +
      'an explicit user request: it closes every page, including other tasks\u2019 pages, ' +
      'and it is not a detach.',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          const: true,
          description:
            'Must be true. Anything else is refused with CONFIRM_REQUIRED, so a ' +
            'whole-browser shutdown has to be deliberate.',
        },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** Broker methods that normalize and echo a taskId. */
const TASK_SCOPED_METHODS = new Set(['status', 'list_tools', 'invoke_tool', 'open_page', 'close_task']);

/** Methods whose caller budget is a `waitMs`-style field. */
const WAIT_METHODS = new Set(['list_tools', 'invoke_tool', 'open_page']);

const INSTRUCTIONS =
  'Chrome WebMCP bridge over the DevTools Protocol. Pass a distinct taskId per concurrent ' +
  'task (default "default"): it is the page-ownership namespace. Reuse the taskId and ' +
  'targetId returned by open_page for later list_tools and invoke_tool calls. close is ' +
  'task-scoped: it closes only that task\u2019s owned pages, never other tasks\u2019 pages ' +
  'and never Chrome. close_browser shuts Chrome down for everyone, so call it only on an ' +
  'explicit user request. Use status to check Chrome, launch if it is not running, ' +
  'list_tools to see registered page tools, and invoke_tool to call one.';

function toolDefinitions() {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/** Copy only declared, defined parameters; unknown host fields are ignored. */
function pickParams(args, names) {
  const params = {};
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(args, name) && args[name] !== undefined) {
      params[name] = args[name];
    }
  }
  return params;
}

function buildBrokerParams(tool, args) {
  const params = pickParams(args, tool.paramNames);
  if (TASK_SCOPED_METHODS.has(tool.method)) {
    if (params.taskId === undefined || params.taskId === null || params.taskId === '') {
      params.taskId = DEFAULT_TASK_ID;
    }
  }
  return params;
}

/** contract: waitMs + 15000 for wait methods, otherwise 45 s. */
function requestTimeoutMs(method, args) {
  const raw = method === 'launch' ? args.timeoutMs : WAIT_METHODS.has(method) ? args.waitMs : undefined;
  const waited = Number(raw);
  if (Number.isFinite(waited) && waited >= 0) return Math.floor(waited) + WAIT_HEADROOM_MS;
  return BASE_REQUEST_TIMEOUT_MS;
}

/** Map one MCP tool call to exactly one broker IPC request. */
async function callTool(name, args = {}) {
  const tool = TOOL_MAP.get(name);
  if (!tool) throw new IpcError('METHOD_NOT_FOUND', `unknown tool: ${name}`);
  const params = buildBrokerParams(tool, args);
  const timeoutMs = requestTimeoutMs(tool.method, args);
  try {
    return await brokerRequest(tool.method, params, timeoutMs);
  } catch (error) {
    const bridgeError = toBridgeError(error);
    log(`${name} failed [${bridgeError.code}]: ${bridgeError.message}`);
    throw bridgeError;
  }
}

// ---------------------------------------------------------------------------
// MCP stdio server (newline-delimited JSON-RPC 2.0)
// ---------------------------------------------------------------------------

/**
 * Stream used for MCP protocol frames. startStdioServer replaces it when a
 * caller injects an output stream (hermetic tests); production keeps
 * process.stdout, so stdout carries protocol frames only.
 */
let frameOutput = process.stdout;

const writeFrame = (frame) => {
  try {
    frameOutput.write(`${JSON.stringify(frame)}\n`);
  } catch (error) {
    log('failed to write an MCP frame:', error?.message || error);
  }
};

const reply = (id, result) => writeFrame({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message, data) =>
  writeFrame({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });

function jsonText(value) {
  try {
    const text = JSON.stringify(value, null, 2);
    return typeof text === 'string' ? text : String(value);
  } catch {
    return String(value);
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    log('ignoring a non-object JSON-RPC frame');
    return;
  }
  const { id, method, params } = message;
  const hasId = typeof id !== 'undefined' && id !== null;

  if (typeof method !== 'string' || !method) {
    if (hasId) replyError(id, -32600, 'Invalid Request: method must be a string');
    return;
  }

  // JSON-RPC notifications (e.g. notifications/initialized) never get a reply.
  if (!hasId) return;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      reply(id, {
        protocolVersion: typeof requested === 'string' && requested ? requested : '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: VERSION },
        instructions: INSTRUCTIONS,
      });
      return;
    }
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: toolDefinitions() });
      return;
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (typeof name !== 'string' || !name) {
        replyError(id, -32602, 'Invalid params: tools/call needs a tool name');
        return;
      }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        replyError(id, -32602, 'Invalid params: tools/call arguments must be an object');
        return;
      }
      if (!TOOL_MAP.has(name)) {
        replyError(id, -32602, `Invalid params: unknown tool "${name}"`);
        return;
      }
      try {
        const result = await callTool(name, args);
        reply(id, { content: [{ type: 'text', text: jsonText(result) }] });
      } catch (error) {
        reply(id, {
          content: [{ type: 'text', text: formatBrokerError(error) }],
          isError: true,
        });
      }
      return;
    }
    default:
      replyError(id, -32601, `Method not found: ${method}`);
  }
}

let shuttingDown = false;

/** Close the broker channel and exit. Idempotent. */
function shutdown(exitCode = 0, reason = 'shutting down') {
  if (shuttingDown) return;
  shuttingDown = true;
  log(reason);
  const current = channel;
  channel = null;
  try {
    current?.close();
  } catch {
    /* best effort */
  }
  process.exit(exitCode);
}

/**
 * Serve MCP over a line input and a frame output until stdin closes or a signal
 * arrives. Production calls this with the defaults; tests inject PassThrough
 * streams and `exitOnClose: false` to run hermetically.
 *
 * Only protocol frames touch `output`; diagnostics use stderr. With the
 * default `exitOnClose: true`, nothing keeps the event loop alive while idle
 * beyond stdin itself, and closing stdin or SIGINT/SIGTERM exits cleanly.
 *
 * @param {NodeJS.ReadableStream} [input] line-delimited JSON-RPC source
 * @param {NodeJS.WritableStream} [output] protocol-only frame sink
 * @param {{exitOnClose?: boolean}} [options]
 */
function startStdioServer(input = process.stdin, output = process.stdout, { exitOnClose = true } = {}) {
  frameOutput = output;

  /** @type {Set<Promise<void>>} */
  const inflight = new Set();
  let stdinClosed = false;

  const exitWhenIdle = () => {
    if (!exitOnClose || !stdinClosed || shuttingDown || inflight.size > 0) return;
    shutdown(0, 'stdin closed; exiting');
  };

  const track = (promise) => {
    const tracked = promise.finally(() => {
      inflight.delete(tracked);
      exitWhenIdle();
    });
    inflight.add(tracked);
    return tracked;
  };

  const rl = createInterface({ input, crlfDelay: Infinity });

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      replyError(null, -32700, 'Parse error: stdin line is not JSON');
      return;
    }
    track(
      Promise.resolve()
        .then(() => handleMessage(message))
        .catch((error) => {
          log('unhandled request error:', error?.stack || error?.message || error);
          const id = message && typeof message === 'object' ? message.id : undefined;
          if (typeof id !== 'undefined' && id !== null) {
            replyError(id, -32603, error?.message || String(error));
          }
        }),
    );
  });

  rl.on('close', () => {
    stdinClosed = true;
    exitWhenIdle();
    if (!exitOnClose) log('stdin closed (injected server; leaving the process alive)');
  });

  if (exitOnClose) {
    process.once('SIGINT', () => shutdown(0, 'received SIGINT'));
    process.once('SIGTERM', () => shutdown(0, 'received SIGTERM'));

    process.stdout.on('error', (error) => {
      if (error?.code === 'EPIPE') shutdown(0, 'stdout closed by the MCP host');
      else log('stdout error:', error?.message || error);
    });
  }

  installSafetyHandlers();
  log(`ready: ${TOOLS.length} tools, broker ${IPC_NAME} (lazy)`);
  return rl;
}

/** Never let a stray rejection crash the protocol stream (installed once). */
let safetyHandlersInstalled = false;
function installSafetyHandlers() {
  if (safetyHandlersInstalled) return;
  safetyHandlersInstalled = true;
  process.on('unhandledRejection', (error) => {
    log('unhandled rejection:', error?.stack || error?.message || error);
  });
}

export { TOOLS, callTool, toolDefinitions, startStdioServer };
export const config = { ipc: IPC_NAME, bridgeEntry: BRIDGE_ENTRY, version: VERSION };

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function runBrokerMode() {
  const { runBroker } = await import('./broker.mjs');
  if (typeof runBroker !== 'function') {
    throw new Error('broker.mjs does not export runBroker()');
  }
  await runBroker();
}

if (isBrokerMode) {
  runBrokerMode().catch((error) => {
    log('broker mode failed:', error?.stack || error?.message || error);
    process.exitCode = 1;
  });
} else if (isMain) {
  startStdioServer();
}
