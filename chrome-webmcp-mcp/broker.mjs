/**
 * The broker owns the only Chrome DevTools connection for a given port and
 * multiplexes every MCP client process (and every task namespace) over it.
 *
 * Why a separate process: two DSH hosts (for example a web session and a CLI
 * run) would otherwise open two CDP sockets and each enable WebMCP, replay tool
 * registries, and race for the same pages. One broker gives them one channel,
 * one persistent registry, fair scheduling, and task-scoped page ownership.
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  BROKER_IDLE_MS,
  CDP_PORT,
  CHROME_LISTEN_WAIT_MS,
  DISCOVERY_CONCURRENCY,
  ENDPOINT,
  INVOKE_WAIT_MS,
  IPC_NAME,
  LOG_FILE,
  OWNERSHIP_FILE,
  STATE_FILE,
  TOOL_SETTLE_MS,
  USER_DATA_DIR,
  VERSION,
  ensureStateDir,
  findChrome,
  sleep,
} from './lib/config.mjs';
import { CdpError, ChromeCdp } from './lib/cdp.mjs';
import { IpcError, createIpcServer } from './lib/ipc.mjs';
import { SessionBook } from './lib/sessions.mjs';
import { TaskBook } from './lib/tasks.mjs';

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function format(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function createLogger(file) {
  ensureStateDir();
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    /* rotation is best effort */
  }
  let fd;
  try {
    fd = fs.openSync(file, 'a');
  } catch {
    fd = undefined;
  }
  const write = (...parts) => {
    const line = `[${new Date().toISOString()}] ${parts.map(format).join(' ')}\n`;
    if (fd !== undefined) {
      try {
        fs.writeSync(fd, line);
      } catch {
        /* ignore */
      }
    }
    if (process.env.CHROME_WEBMCP_BROKER_STDERR === '1') process.stderr.write(line);
  };
  write.close = () => {
    if (fd === undefined) return;
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    fd = undefined;
  };
  return write;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new IpcError('INVALID_PARAMS', `${name} must be a non-empty string`);
  }
  return value;
}

function writeStateFile(file, payload) {
  try {
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  } catch {
    /* best effort */
  }
}

function removeStateFile(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Start the broker. Resolves once the IPC endpoint is listening.
 * Returns `{ ipcName, port, close, server }`; `close()` is idempotent.
 */
export async function runBroker(options = {}) {
  const port = Number(options.port ?? CDP_PORT);
  const endpoint = `http://127.0.0.1:${port}`;
  let ipcName = options.ipcName ?? IPC_NAME;
  const stateFile = options.stateFile ?? STATE_FILE;
  const ownershipFile = options.ownershipFile ?? OWNERSHIP_FILE;
  const idleMs = Number(options.idleMs ?? BROKER_IDLE_MS);
  const log = createLogger(options.logFile ?? LOG_FILE);
  const startedAt = Date.now();
  const brokerId = `b-${process.pid}`;

  const cdp = new ChromeCdp({ port, endpoint, log });
  const sessions = new SessionBook({
    cdp,
    log,
    settleMs: Number(options.settleMs ?? TOOL_SETTLE_MS),
    invokeWaitMs: Number(options.invokeWaitMs ?? INVOKE_WAIT_MS),
  });
  const tasks = new TaskBook({ cdp, sessions, log, ownershipFile });

  const clients = new Map();
  let lastClientLeftAt = Date.now();
  let closed = false;
  let idleTimer = null;
  let server = null;

  const chromeFacts = async () => {
    const info = await cdp.version();
    return info
      ? {
          reachable: true,
          browser: info.Browser ?? null,
          protocolVersion: info['Protocol-Version'] ?? null,
          error: null,
        }
      : {
          reachable: false,
          browser: null,
          protocolVersion: null,
          error: `No Chrome DevTools endpoint on ${endpoint}; start Chrome with --remote-debugging-port=${port} or call launch`,
        };
  };

  const launchChrome = async ({ url, timeoutMs } = {}) => {
    const existing = await cdp.version({ cacheMs: 0 });
    if (existing) {
      return { launched: false, alreadyRunning: true, port, browser: existing.Browser ?? null };
    }
    const executable = findChrome();
    if (!executable) {
      throw new CdpError(
        'BROWSER_LAUNCH_FAILED',
        'Chrome executable not found; set CHROME_PATH or install Google Chrome',
      );
    }
    try {
      fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    } catch {
      /* spawn reports the real problem */
    }
    const targetUrl = typeof url === 'string' && url ? url : 'about:blank';
    const args = [
      `--user-data-dir=${USER_DATA_DIR}`,
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      // Verified on Chrome 155: base::Feature "enable-webmcp-testing" plus the
      // Blink runtime feature "WebMCP" are both required for document.modelContext.
      '--enable-features=enable-webmcp-testing,WebMCP',
      '--enable-blink-features=WebMCP',
      targetUrl,
    ];
    let child;
    try {
      child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    } catch (error) {
      throw new CdpError('BROWSER_LAUNCH_FAILED', `could not start Chrome: ${error.message}`);
    }
    const deadline = Date.now() + Number(timeoutMs ?? CHROME_LISTEN_WAIT_MS);
    while (Date.now() < deadline) {
      const info = await cdp.version({ cacheMs: 0 });
      if (info) {
        return {
          launched: true,
          alreadyRunning: false,
          pid: child.pid ?? null,
          port,
          userDataDir: USER_DATA_DIR,
          browser: info.Browser ?? null,
        };
      }
      await sleep(250);
    }
    throw new CdpError(
      'BROWSER_LAUNCH_FAILED',
      `Chrome did not open the DevTools port ${port} within ${timeoutMs ?? CHROME_LISTEN_WAIT_MS} ms (pid ${child.pid})`,
    );
  };

  const listTools = async (client, params) => {
    const taskId = tasks.normalize(params.taskId);
    const candidates = await tasks.candidates(taskId, { targetId: params.targetId, url: params.url });
    const waitMs = params.waitMs;
    const refresh = params.refresh === true;
    const pages = await mapLimit(candidates, DISCOVERY_CONCURRENCY, async (page) => {
      const facts = tasks.pageFacts(page);
      try {
        const tools = await sessions.listTools(page.targetId, {
          waitMs,
          refresh,
          clientId: client.name,
        });
        return { ...facts, tools };
      } catch (error) {
        log('[broker] list_tools page failed', page.targetId, error?.code || '', error?.message || String(error));
        return { ...facts, tools: [], error: error?.code || 'INTERNAL' };
      }
    });
    return {
      taskId,
      candidates: candidates.length,
      pages,
      skipped: pages.filter((page) => page.error).length,
    };
  };

  const invokeTool = async (client, params) => {
    const taskId = tasks.normalize(params.taskId);
    const toolName = requireString(params.toolName, 'toolName');
    if (params.frameId !== undefined && !params.targetId) {
      throw new IpcError('FRAME_WITHOUT_TARGET', 'frameId requires targetId; pass both');
    }
    const candidates = await tasks.candidates(taskId, { targetId: params.targetId, url: params.url });
    if (!candidates.length) {
      throw new CdpError('TOOL_NOT_FOUND', `WebMCP tool "${toolName}" is not available to task "${taskId}"`, {
        toolName,
        taskId,
        candidates: 0,
      });
    }
    // An explicit frameId + targetId is already the complete addressing
    // information; skip the registry scan and invoke directly.
    if (params.frameId && params.targetId) {
      const page = candidates[0];
      const direct = await sessions.invoke(page.targetId, {
        frameId: params.frameId,
        toolName,
        input: params.input,
        waitMs: params.waitMs,
        clientId: client.name,
      });
      return {
        taskId,
        toolName,
        targetId: page.targetId,
        frameId: params.frameId,
        status: direct.status,
        output: direct.output,
        invocationId: direct.invocationId,
        durationMs: direct.durationMs,
        ambiguous: false,
      };
    }
    const matches = [];
    for (const page of candidates) {
      try {
        const tools = await sessions.listTools(page.targetId, {
          waitMs: Math.min(Number(params.waitMs) || sessions.invokeWaitMs, sessions.settleMs),
          clientId: client.name,
        });
        const tool = tools.find((entry) => entry.name === toolName);
        if (tool) matches.push({ page, tool });
      } catch (error) {
        log('[broker] invoke scan failed', page.targetId, error?.code || '', error?.message || String(error));
      }
    }
    if (!matches.length) {
      throw new CdpError('TOOL_NOT_FOUND', `WebMCP tool "${toolName}" not found on ${candidates.length} page(s)`, {
        toolName,
        taskId,
        candidates: candidates.length,
      });
    }
    const chosen = matches[0];
    const result = await sessions.invoke(chosen.page.targetId, {
      frameId: params.frameId || chosen.tool.frameId,
      toolName,
      input: params.input,
      waitMs: params.waitMs,
      clientId: client.name,
    });
    return {
      taskId,
      toolName,
      targetId: chosen.page.targetId,
      frameId: params.frameId || chosen.tool.frameId,
      status: result.status,
      output: result.output,
      invocationId: result.invocationId,
      durationMs: result.durationMs,
      ambiguous: matches.length > 1,
    };
  };

  const dispatch = async (client, method, params = {}) => {
    if (!client.handshaken && method !== 'hello' && method !== 'ping') {
      throw new IpcError('INVALID_PARAMS', 'send hello before any other request');
    }
    switch (method) {
      case 'hello': {
        const clientId = typeof params.clientId === 'string' && params.clientId ? params.clientId.slice(0, 128) : client.id;
        client.name = clientId;
        client.handshaken = true;
        log('[broker] client hello', clientId, `pid=${params.pid ?? '?'}`, `version=${params.version ?? '?'}`);
        return {
          brokerId,
          version: VERSION,
          pid: process.pid,
          ipc: ipcName,
          port,
          startedAt: new Date(startedAt).toISOString(),
          chrome: await chromeFacts(),
        };
      }
      case 'ping':
        return { pong: true, uptimeMs: Date.now() - startedAt };
      case 'status': {
        const status = await tasks.status({ taskId: params.taskId, detail: params.detail });
        return {
          ...status,
          chrome: await chromeFacts(),
          broker: {
            pid: process.pid,
            brokerId,
            version: VERSION,
            uptimeMs: Date.now() - startedAt,
            clients: clients.size,
            sessions: sessions.stats(),
          },
          port,
          ipc: ipcName,
        };
      }
      case 'list_tools':
        return await listTools(client, params);
      case 'invoke_tool':
        return await invokeTool(client, params);
      case 'open_page': {
        const url = requireString(params.url, 'url');
        return await tasks.openPage({
          taskId: params.taskId,
          url,
          isolated: params.isolated === true,
          waitMs: params.waitMs,
          clientId: client.name,
        });
      }
      case 'close_task':
        return await tasks.closeTask({ taskId: params.taskId });
      case 'close_browser':
        if (params.confirm !== true) {
          throw new IpcError('CONFIRM_REQUIRED', 'close_browser requires confirm: true');
        }
        return await tasks.closeBrowser();
      case 'launch':
        return await launchChrome({ url: params.url, timeoutMs: params.timeoutMs });
      case 'shutdown':
        setTimeout(() => void close(), 100).unref?.();
        return { stopping: true };
      default:
        throw new IpcError('METHOD_NOT_FOUND', `unknown broker method: ${method}`);
    }
  };

  server = await createIpcServer(ipcName, {
    onConnection(channel) {
      const client = {
        id: channel.clientId,
        name: channel.clientId,
        channel,
        handshaken: false,
        connectedAt: Date.now(),
      };
      clients.set(client.id, client);
      log('[broker] client connected', client.id, `clients=${clients.size}`);
      channel.onRequest = (method, params) => dispatch(client, method, params);
      channel.onClose = () => {
        clients.delete(client.id);
        if (clients.size === 0) lastClientLeftAt = Date.now();
        log('[broker] client disconnected', client.id, `clients=${clients.size}`);
      };
    },
    onError(error) {
      log('[broker] ipc server error', error?.message || String(error));
    },
  });

  // A test/constrained-endpoint caller may ask for port 0; report the port the
  // OS actually assigned so clients can connect.
  if (ipcName.startsWith('tcp://')) {
    const address = server.address();
    if (address && typeof address === 'object') ipcName = `tcp://${address.address}:${address.port}`;
  }

  writeStateFile(stateFile, {
    pid: process.pid,
    ipc: ipcName,
    port,
    startedAt: new Date(startedAt).toISOString(),
    version: VERSION,
  });
  log('[broker] listening', ipcName, `port=${port}`, `pid=${process.pid}`);
  const close = async () => {
    if (closed) return;
    closed = true;
    if (idleTimer) clearInterval(idleTimer);
    try {
      tasks.persist();
    } catch {
      /* ownership persistence is best effort */
    }
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    try {
      await cdp.close();
    } catch {
      /* ignore */
    }
    removeStateFile(stateFile);
    log('[broker] stopped');
    log.close();
  };

  idleTimer = setInterval(() => {
    if (clients.size > 0) return;
    if (Date.now() - lastClientLeftAt < idleMs) return;
    void close();
  }, Math.max(250, Math.min(Math.floor(idleMs / 2), 30000)));
  idleTimer.unref?.();

  if (options.handleSignals !== false) {
    const stop = (signal) => {
      log('[broker] signal', signal);
      void close().finally(() => process.exit(0));
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
    process.on('unhandledRejection', (error) => {
      log('[broker] unhandled rejection', error?.stack || error?.message || String(error));
    });
    process.on('uncaughtException', (error) => {
      log('[broker] uncaught exception', error?.stack || error?.message || String(error));
      try {
        removeStateFile(stateFile);
      } catch {
        /* ignore */
      }
      try {
        tasks.persist();
      } catch {
        /* ownership persistence is best effort */
      }
      try {
        log.close();
      } catch {
        /* ignore */
      }
      process.exit(1);
    });
  }

  return {
    brokerId,
    ipcName,
    port,
    server,
    sessions,
    tasks,
    stats: () => ({ clients: clients.size, sessions: sessions.stats(), uptimeMs: Date.now() - startedAt }),
    close,
  };
}

export { TASK_ID };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await runBroker();
}
