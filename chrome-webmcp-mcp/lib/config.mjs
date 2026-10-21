/**
 * Shared configuration and small utilities for the Chrome WebMCP bridge.
 *
 * Everything is environment driven so the bundle patch can stay free of
 * machine-specific absolute paths: the patch starts `bridge.mjs` with the
 * running Node executable and lets both the MCP client and the broker resolve
 * the same defaults here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_NAME = 'chrome-webmcp';
export const VERSION = '2.0.0';

const positiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/** DevTools port of the browser the bridge talks to. */
export const CDP_PORT = positiveInt(process.env.CHROME_CDP_PORT, 9333);
export const ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;

const LOCAL_BASE = process.env.LOCALAPPDATA || os.tmpdir();

/**
 * Per-port defaults: two Chrome debug ports must never share a state directory,
 * a broker log, an ownership file, or a Chrome `--user-data-dir` (Chrome reuses
 * the first instance for the same profile, so the second port never opens).
 * Port 9333 keeps the historical directory names for compatibility.
 */
export function defaultStateDir(port = CDP_PORT) {
  const base = path.join(LOCAL_BASE, 'dsh-chrome-webmcp');
  return port === 9333 ? base : `${base}-${port}`;
}

export function defaultUserDataDir(port = CDP_PORT) {
  const base = path.join(LOCAL_BASE, 'dsh-webmcp-chrome');
  return port === 9333 ? base : `${base}-${port}`;
}

/** Local IPC endpoint shared by every bridge process for this port. */
export const IPC_NAME = process.env.CHROME_WEBMCP_IPC || defaultIpcName(CDP_PORT);

/** Bridge-owned state (logs, broker metadata, task ownership). Never inside the repo. */
export const STATE_DIR = process.env.CHROME_WEBMCP_STATE_DIR || defaultStateDir(CDP_PORT);
export const LOG_FILE = path.join(STATE_DIR, 'broker.log');
export const STATE_FILE = path.join(STATE_DIR, 'broker.json');
/** Survives broker restarts so task page ownership is not lost. */
export const OWNERSHIP_FILE = path.join(STATE_DIR, 'ownership.json');

/** Isolated Chrome profile used by `launch` when it has to start a browser. */
export const USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR || defaultUserDataDir(CDP_PORT);

export const CHROME_LISTEN_WAIT_MS = positiveInt(process.env.CHROME_LISTEN_WAIT_MS, 25000);
/** Quiet window used to decide that a page finished replaying its tools. */
export const TOOL_SETTLE_MS = positiveInt(process.env.CHROME_TOOL_SETTLE_MS, 1200);
export const INVOKE_WAIT_MS = positiveInt(process.env.CHROME_INVOKE_WAIT_MS, 20000);

/** Broker exits after this long with no connected clients; Chrome keeps running. */
export const BROKER_IDLE_MS = positiveInt(process.env.CHROME_WEBMCP_BROKER_IDLE_MS, 600000);
export const BROKER_START_WAIT_MS = positiveInt(process.env.CHROME_WEBMCP_START_WAIT_MS, 12000);

export const MAX_INFLIGHT = positiveInt(process.env.CHROME_WEBMCP_MAX_INFLIGHT, 32);
export const CLIENT_MAX_INFLIGHT = positiveInt(process.env.CHROME_WEBMCP_CLIENT_MAX_INFLIGHT, 8);
export const CDP_TIMEOUT_MS = positiveInt(process.env.CHROME_CDP_TIMEOUT_MS, 30000);
export const DISCOVERY_CONCURRENCY = positiveInt(process.env.CHROME_WEBMCP_DISCOVERY_CONCURRENCY, 4);

/** Hard cap for a single newline-delimited IPC frame. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;
export const MAX_TOOL_WAIT_MS = 120000;

export function defaultIpcName(port = CDP_PORT) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\dsh-chrome-webmcp-${port}`;
  return path.join(os.tmpdir(), `dsh-chrome-webmcp-${port}.sock`);
}

export function ensureStateDir() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch {
    /* diagnostics only; the bridge keeps working without a state directory */
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function chromeCandidates() {
  return [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
}

export function findChrome() {
  for (const candidate of chromeCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

/** Path of the bridge module, resolved from this file (works when linked/copied). */
export const BRIDGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const BRIDGE_ENTRY = path.join(BRIDGE_DIR, 'bridge.mjs');

export function describeConfig() {
  return {
    version: VERSION,
    port: CDP_PORT,
    endpoint: ENDPOINT,
    ipc: IPC_NAME,
    stateDir: STATE_DIR,
    ownershipFile: OWNERSHIP_FILE,
    userDataDir: USER_DATA_DIR,
  };
}
