#!/usr/bin/env node
/**
 * Chrome WebMCP 桥接器 - MCP stdio 客户端（v2）。
 *
 * 每个 MCP host（如 Trae/DSH 宿主）对应一个本进程。这个唯一入口承担两种角色：
 *
 *   node bridge.mjs            MCP stdio 服务端。在 stdin/stdout 上收发以换行分隔的
 *                              JSON-RPC 2.0 帧；每个工具调用都恰好转换为一个发往本地
 *                              broker 的请求（经由 lib/ipc.mjs）。
 *   node bridge.mjs --broker   Broker 进程（独占 Chrome/CDP 连接）。动态导入
 *                              ./broker.mjs 并 await runBroker()。
 *
 * broker 按 Chrome DevTools 端口共享（同一端口只有一个 broker 进程）。它采用懒连接：
 * 首次调用若发现 IPC 端点上没有监听者，就以 detached 方式拉起 broker（stdio 忽略）。
 * 连接一旦丢失，只让当前进行中的调用失败；下一次调用会重新连接。
 * 变更类（mutating）调用绝不在模型不知情的情况下自动重试，避免同一操作执行两次。
 *
 * 架构位置：MCP host ←stdio JSON-RPC→ bridge.mjs ←IPC→ broker.mjs ←CDP WebSocket→ Chrome。
 *
 * 不变量：stdout 只承载协议帧；所有诊断日志一律写入 stderr（见 log()）。
 * 零第三方依赖，要求 Node >= 22。
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

/**
 * 客户端标识：一个 MCP 客户端进程 = 一个 broker 客户端。
 * 在 hello 握手时上报给 broker，broker 端用于日志与连接计数。
 */
const CLIENT_ID = `mcp-${process.pid}-${randomBytes(2).toString('hex')}`;

/** 默认任务命名空间（契约第 3 节）。未显式传 taskId 时使用。 */
const DEFAULT_TASK_ID = 'default';

/** 非等待类 broker 方法的请求超时 45 s（契约第 6 节）。 */
const BASE_REQUEST_TIMEOUT_MS = 45000;
/** 在调用方给出的 waitMs 之上额外留出的余量，用于覆盖 broker/IPC 开销。 */
const WAIT_HEADROOM_MS = 15000;
/** hello 往返本身很廉价；握手卡住只能说明 broker 已损坏，因此 10 s 就放弃。 */
const HELLO_TIMEOUT_MS = 10000;
/** 首次连接尝试的超时；失败后会拉起 broker 并重试。 */
const CONNECT_TIMEOUT_MS = 2000;
/** broker 启动期间两次连接尝试之间的间隔。 */
const BROKER_CONNECT_RETRY_MS = 200;

// ---------------------------------------------------------------------------
// Broker 连接（懒连接、单飞、下次调用时重连）
// ---------------------------------------------------------------------------

/** @type {import('./lib/ipc.mjs').LineChannel | null} */
let channel = null;
/** 单飞（single-flight）保护：并发的工具调用共享同一次 connect + hello。 */
let connecting = null;

/**
 * 把已握手的通道登记为当前通道，并挂上断线回调。
 * 回调里只有「当前通道仍是自己」时才清空全局引用，避免旧的连接把新连接清掉。
 *
 * @param {import('./lib/ipc.mjs').LineChannel} connected 已完成 hello 的 IPC 通道
 * @returns {import('./lib/ipc.mjs').LineChannel} 同一个通道，便于链式返回
 */
function attachChannel(connected) {
  connected.onClose = () => {
    if (channel === connected) channel = null;
    log('broker connection closed; the next tool call will reconnect');
  };
  channel = connected;
  return connected;
}

/**
 * 连接 broker IPC 端点，并执行「每个连接一次」的 hello 握手。
 *
 * 握手失败必须关闭通道再抛出，否则会留下一条半初始化连接，
 * 下次调用可能复用到未握手的通道。
 *
 * @returns {Promise<import('./lib/ipc.mjs').LineChannel>} 已完成握手的通道
 * @throws {IpcError} 连接失败（如 ENOENT/ECONNREFUSED）或 hello 超时
 */
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
      /* 通道已经断开了，关闭本身失败也无所谓 */
    }
    throw error;
  }
}

/**
 * 以 detached 方式拉起 `node bridge.mjs --broker`；它的 stdout/stderr 不归本进程所有
 * （stdio: 'ignore'），因此不会污染 MCP 协议帧。unref() 让父进程退出时不等待它。
 *
 * @returns {import('node:child_process').ChildProcess | null} 子进程；同步 spawn 失败时返回 null
 */
function spawnBrokerProcess() {
  try {
    const child = spawn(process.execPath, [BRIDGE_ENTRY, '--broker'], {
      stdio: 'ignore',
      windowsHide: true,
      detached: true,
      env: process.env,
    });
    // spawn 的错误是异步的：这里只记录，真正的失败由后续连接重试体现。
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
 * 建立到 broker 的通道：先直接连接；失败则拉起 broker 并在 BROKER_START_WAIT_MS
 * 到期前反复重试。
 *
 * 关键约束：spawn 只发生在发送任何请求之前，所以这个循环永远不会「重放」一个
 * 变更类操作——最坏情况是调用失败，由模型决定是否重试。
 *
 * @returns {Promise<import('./lib/ipc.mjs').LineChannel>} 已完成握手的通道
 * @throws {IpcError} 错误码 BROKER_UNAVAILABLE：等待窗口内 broker 始终不可达
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

  // 把最后一次失败原因拼进错误信息，便于用户直接看日志定位。
  const detail = lastError?.message || lastError?.code || 'no response';
  throw new IpcError(
    'BROKER_UNAVAILABLE',
    `broker did not become reachable on ${IPC_NAME} within ${BROKER_START_WAIT_MS} ms ` +
      `(last error: ${detail}). Check ${LOG_FILE}.`,
  );
}

/**
 * 返回可用的 broker 通道；不存在时只发起一次连接，并让并发调用共享该次尝试。
 *
 * 单飞的时序：connecting 在 finally 中清空，因此连接完成后（无论成败）下一次调用
 * 都能重新发起；并发期间的调用则都挂到同一个 Promise 上。
 *
 * @returns {Promise<import('./lib/ipc.mjs').LineChannel>} 通道
 */
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

/**
 * 发送单个 broker IPC 请求。绝不自动重试：变更操作不能被执行两次。
 *
 * 在「取到通道」与「真正发送」之间连接可能已经断开；此时主动抛 IPC_CLOSED，
 * 让调用方明确地再调一次（而不是悄悄重放）。
 *
 * @param {string} method broker 方法名
 * @param {object} params 方法参数
 * @param {number} timeoutMs 单次请求超时
 * @returns {Promise<any>} broker 的返回值
 * @throws {IpcError} IPC_CLOSED（发送前连接已断）或底层 IPC 错误
 */
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

/**
 * 把任意异常归一化成 IpcError，供 MCP 层统一格式化。
 * 缺少字符串 code 时归为 INTERNAL。
 *
 * @param {unknown} error 原始异常
 * @returns {IpcError} 归一化后的错误
 */
function toBridgeError(error) {
  if (error instanceof IpcError) return error;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'INTERNAL';
  return new IpcError(code, error?.message ? String(error.message) : String(error));
}

/**
 * 生成 MCP 错误文本：`Error [CODE]: message`；若 broker 的 data.message 携带了
 * 额外的页面侧细节（例如页面自身的错误说明），且尚未包含在 message 中，则追加一行。
 *
 * @param {any} error 归一化后的错误
 * @returns {string} 用于 tools/call 错误内容块的文本
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
// 工具定义（契约第 6 节）。每次工具调用对应一个 IPC 请求。
// 注意：以下 description / JSON Schema 字符串是暴露给模型的协议内容，保持原样。
// ---------------------------------------------------------------------------

/** 复用的 taskId 参数 Schema：任务命名空间，决定页面归属。 */
const TASK_ID_PARAM = {
  type: 'string',
  description:
    'Task namespace: letters, digits, "." "_" "-", 1-64 chars, default "default". ' +
    'Use a distinct taskId per concurrent task and reuse the taskId returned by open_page ' +
    'so that its pages stay addressable.',
};

/** 复用的 targetId 参数 Schema：精确指定某个 page target；省略时考虑全部可用页面。 */
const TARGET_ID_PARAM = {
  type: 'string',
  description:
    'Exact page targetId from status, list_tools, or open_page. ' +
    'Omit to consider every page this task can use.',
};

/** 复用的 url 过滤参数 Schema：按 URL 子串筛选候选页面；设置 targetId 时被忽略。 */
const URL_FILTER_PARAM = {
  type: 'string',
  description: 'Only consider pages whose URL contains this substring. Ignored when targetId is set.',
};

/** 复用的 index 参数 Schema：引用于最近一次 snapshot 的元素编号。 */
const INDEX_PARAM = {
  type: 'integer',
  minimum: 0,
  description:
    'Element index from the latest snapshot, for example 12 from ' +
    '"[12]<button>Submit</button>". An index from an older snapshot fails reliably.',
};

/** 复用的动作后等待参数 Schema：点击/输入后等待页面稳定的毫秒数。 */
const ACTION_WAIT_PARAM = {
  type: 'number',
  description:
    'Milliseconds to wait after the action before reading the page URL/title ' +
    '(default CHROME_ACTION_SETTLE_MS = 300, cap 120000). Does not wait for a new snapshot.',
};

/**
 * 全部 12 个 MCP 工具的完整定义（含内部字段 method / paramNames）。
 * name 是 MCP 层暴露的名字；method 是对应的 broker IPC 方法；paramNames 决定
 * 从 MCP 参数里挑选哪些字段转发（未知字段会被丢弃）。
 * 对外只返回 name / description / inputSchema（见 toolDefinitions()）。
 *
 * @type {ReadonlyArray<{name: string, method: string, paramNames: string[], description: string, inputSchema: object}>}
 */
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
      '(most recently opened first), then unowned pages; sets ambiguous when more than one ' +
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
    name: 'snapshot',
    method: 'snapshot',
    paramNames: ['taskId', 'targetId', 'url', 'maxElements'],
    description:
      'Perceive the page: return visible interactive elements (buttons, links, fields, ARIA ' +
      'widgets, shadow DOM) as a compact numbered list such as ' +
      '"[12]<button type=\\"submit\\">Sign in</button>". This is the perception step of the ' +
      'browser-use loop; pass an index to click or type_text. Indices belong to the latest ' +
      'snapshot only and become invalid after another snapshot or a page navigation. The ' +
      'snapshot runs in an isolated world and does not modify the page.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: TASK_ID_PARAM,
        targetId: TARGET_ID_PARAM,
        url: URL_FILTER_PARAM,
        maxElements: {
          type: 'integer',
          minimum: 1,
          maximum: 2000,
          description:
            'Maximum number of elements to serialize (default CHROME_SNAPSHOT_MAX_ELEMENTS = ' +
            '200, hard cap 2000). Lower it on very large pages to save tokens.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'click',
    method: 'click',
    paramNames: ['taskId', 'targetId', 'url', 'index', 'button', 'clickCount', 'waitMs'],
    description:
      'Act: click an element by its index from the latest snapshot. Scrolls it into view and ' +
      'sends real mouse events, so hover menus, links, and framework handlers behave normally. ' +
      'Call snapshot again afterwards to observe the result.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: TASK_ID_PARAM,
        targetId: TARGET_ID_PARAM,
        url: URL_FILTER_PARAM,
        index: INDEX_PARAM,
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button; default "left".',
        },
        clickCount: {
          type: 'integer',
          minimum: 1,
          maximum: 3,
          description: 'Clicks to send at the same point (2 for a double click); default 1.',
        },
        waitMs: ACTION_WAIT_PARAM,
      },
      required: ['index'],
      additionalProperties: false,
    },
  },
  {
    name: 'type_text',
    method: 'type_text',
    paramNames: ['taskId', 'targetId', 'url', 'index', 'text', 'clear', 'submit', 'waitMs'],
    description:
      'Act: focus a text field by snapshot index and insert text with real input events. ' +
      'Existing content is replaced by default; set clear:false to append at the caret. On a ' +
      '<select>, chooses the option whose value or label matches text. Set submit:true to ' +
      'press Enter afterwards. Call snapshot again to observe the result.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: TASK_ID_PARAM,
        targetId: TARGET_ID_PARAM,
        url: URL_FILTER_PARAM,
        index: INDEX_PARAM,
        text: {
          type: 'string',
          description: 'Text to insert. For a select, the option value or visible label.',
        },
        clear: {
          type: 'boolean',
          description: 'true (default) selects the field content first so the new text replaces it.',
        },
        submit: {
          type: 'boolean',
          description: 'true presses Enter after inserting the text; default false.',
        },
        waitMs: ACTION_WAIT_PARAM,
      },
      required: ['index', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'press_key',
    method: 'press_key',
    paramNames: ['taskId', 'targetId', 'url', 'key', 'waitMs'],
    description:
      'Act: send one key or key combination to the focused element or page. Supports Enter, ' +
      'Tab, Escape, Backspace, Delete, Space, arrows, Home/End, PageUp/PageDown, single ' +
      'letters/digits, and combinations such as Control+A or Shift+Tab.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: TASK_ID_PARAM,
        targetId: TARGET_ID_PARAM,
        url: URL_FILTER_PARAM,
        key: {
          type: 'string',
          description: 'Key name or combination, for example "Enter", "Tab", "ArrowDown", "Control+A".',
        },
        waitMs: ACTION_WAIT_PARAM,
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'navigate',
    method: 'navigate',
    paramNames: ['taskId', 'targetId', 'url', 'waitMs'],
    description:
      'Act: navigate the existing page (same tab) to a URL and wait until ' +
      'document.readyState is "complete". Take a new snapshot afterwards. Use open_page when ' +
      'you need a new tab instead of reusing the current one.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Destination http(s), file, or about URL.',
        },
        taskId: TASK_ID_PARAM,
        targetId: TARGET_ID_PARAM,
        waitMs: {
          type: 'number',
          description:
            'Maximum load wait in ms (default CHROME_NAVIGATE_WAIT_MS = 10000, cap 120000). ' +
            'The request timeout is waitMs + 15000.',
        },
      },
      required: ['url'],
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

/** 工具名 → 工具定义的索引，用于 O(1) 的 tools/call 校验与查表。 */
const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** broker 方法中会归一化并回显 taskId 的那一批（缺省时填 "default"）。 */
const TASK_SCOPED_METHODS = new Set([
  'status',
  'list_tools',
  'invoke_tool',
  'snapshot',
  'click',
  'type_text',
  'press_key',
  'navigate',
  'open_page',
  'close_task',
]);

/** 调用方预算以 `waitMs` 风格字段表达的方法；这些方法的超时 = waitMs + 余量。 */
const WAIT_METHODS = new Set([
  'list_tools',
  'invoke_tool',
  'open_page',
  'click',
  'type_text',
  'press_key',
  'navigate',
]);

/**
 * 随 initialize 响应下发给模型的全局使用说明（协议内容字符串，勿改）。
 * 核心约定：taskId 为页面归属命名空间；close 仅关闭本任务页面；close_browser 需用户明确要求。
 */
const INSTRUCTIONS =
  'Chrome WebMCP bridge over the DevTools Protocol. Pass a distinct taskId per concurrent ' +
  'task (default "default"): it is the page-ownership namespace. Reuse the taskId and ' +
  'targetId returned by open_page for later list_tools and invoke_tool calls. close is ' +
  'task-scoped: it closes only that task\u2019s owned pages, never other tasks\u2019 pages ' +
  'and never Chrome. close_browser shuts Chrome down for everyone, so call it only on an ' +
  'explicit user request. Use status to check Chrome, launch if it is not running, ' +
  'list_tools to see registered page tools, and invoke_tool to call one. ' +
  'For pages without a usable WebMCP tool, run the browser-use loop: call snapshot to ' +
  'perceive the page as numbered interactive elements, then click, type_text, press_key, or ' +
  'navigate to act, then snapshot again. Snapshot indices refer only to the latest snapshot; ' +
  'after any action or navigation, take a new snapshot before using indices again. Prefer ' +
  'WebMCP tools when a page exposes the operation you need.';

/**
 * 生成 tools/list 的返回内容：只暴露 MCP 需要的三个字段，
 * 隐藏内部的 method / paramNames。
 *
 * @returns {Array<{name: string, description: string, inputSchema: object}>} 工具列表
 */
function toolDefinitions() {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/**
 * 只拷贝已声明且已定义（非 undefined）的参数；host 传入的未知字段一律忽略，
 * 避免把模型臆造的参数透传给 broker。
 *
 * @param {object} args MCP 工具调用参数
 * @param {string[]} names 允许透传的参数名
 * @returns {object} 过滤后的参数对象
 */
function pickParams(args, names) {
  const params = {};
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(args, name) && args[name] !== undefined) {
      params[name] = args[name];
    }
  }
  return params;
}

/**
 * 由 MCP 参数构造 broker 参数；对任务作用域方法补上默认 taskId。
 * 注意：undefined / null / 空串都视为「未指定」。
 *
 * @param {{name: string, method: string, paramNames: string[]}} tool 工具定义
 * @param {object} args MCP 工具调用参数
 * @returns {object} broker 请求参数
 */
function buildBrokerParams(tool, args) {
  const params = pickParams(args, tool.paramNames);
  if (TASK_SCOPED_METHODS.has(tool.method)) {
    if (params.taskId === undefined || params.taskId === null || params.taskId === '') {
      params.taskId = DEFAULT_TASK_ID;
    }
  }
  return params;
}

/**
 * 契约规定的请求超时：等待类方法为 waitMs + 15000，其余为 45 s。
 * launch 使用 timeoutMs 作为其等待预算，语义与 waitMs 相同。
 *
 * @param {string} method broker 方法名
 * @param {object} args MCP 工具调用参数
 * @returns {number} 毫秒超时
 */
function requestTimeoutMs(method, args) {
  const raw = method === 'launch' ? args.timeoutMs : WAIT_METHODS.has(method) ? args.waitMs : undefined;
  const waited = Number(raw);
  if (Number.isFinite(waited) && waited >= 0) return Math.floor(waited) + WAIT_HEADROOM_MS;
  return BASE_REQUEST_TIMEOUT_MS;
}

/**
 * 把一个 MCP 工具调用映射为恰好一个 broker IPC 请求。
 *
 * @param {string} name MCP 工具名
 * @param {object} [args] 工具参数
 * @returns {Promise<any>} broker 返回的结果对象
 * @throws {IpcError} METHOD_NOT_FOUND（未知工具）或 broker 转发的业务错误
 */
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
// MCP stdio 服务端（换行分隔的 JSON-RPC 2.0）
// ---------------------------------------------------------------------------

/**
 * 承载 MCP 协议帧的输出流。startStdioServer 在调用方注入输出流时会替换它
 * （用于隔离式测试）；生产环境保持 process.stdout，因此 stdout 只承载协议帧。
 */
let frameOutput = process.stdout;

/** 写出一个协议帧（每帧一行）；写入失败只能记录，不能反向破坏协议流。 */
const writeFrame = (frame) => {
  try {
    frameOutput.write(`${JSON.stringify(frame)}\n`);
  } catch (error) {
    log('failed to write an MCP frame:', error?.message || error);
  }
};

/** 写出成功响应帧。 */
const reply = (id, result) => writeFrame({ jsonrpc: '2.0', id, result });
/** 写出错误响应帧；data 为 undefined 时省略该字段，避免出现 `"data": undefined`。 */
const replyError = (id, code, message, data) =>
  writeFrame({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });

/**
 * 把工具结果序列化成 MCP 文本内容（缩进 2 空格，便于模型阅读）。
 * 遇到循环引用等无法序列化的情况时降级为 String(value)，而不是抛错。
 *
 * @param {any} value 任意工具返回值
 * @returns {string} 可放入 content[].text 的字符串
 */
function jsonText(value) {
  try {
    const text = JSON.stringify(value, null, 2);
    return typeof text === 'string' ? text : String(value);
  } catch {
    return String(value);
  }
}

/**
 * 处理一条已解析的 JSON-RPC 消息。
 *
 * 分派规则：只支持 initialize / ping / tools/list / tools/call，其余方法返回 -32601。
 * 通知（无 id）一律不回复，即使方法未知；这样 initialize 后的 initialized 通知
 * 不会触发任何错误帧。
 *
 * tools/call 的失败走「协议内错误内容」（isError: true）而不是 JSON-RPC error，
 * 让模型能看到错误文本并自行决定后续动作；参数/未知工具这类调用方错误则在
 * 进 broker 之前就以 -32602 拒绝。
 *
 * @param {any} message 解析后的 JSON-RPC 消息
 * @returns {Promise<void>}
 */
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

  // JSON-RPC 通知（例如 notifications/initialized）永远不回复。
  if (!hasId) return;

  switch (method) {
    case 'initialize': {
      // 回显客户端请求的协议版本；缺失或非法时退回到 2024-11-05。
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
        // 业务失败以内容块形式返回，模型可读取错误码与提示后决定是否修正重试。
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

/**
 * 关闭 broker 通道并退出进程。幂等：重复调用（如信号与 stdin 关闭同时发生）只生效一次。
 *
 * @param {number} [exitCode=0] 进程退出码
 * @param {string} [reason='shutting down'] 记录到 stderr 的退出原因
 */
function shutdown(exitCode = 0, reason = 'shutting down') {
  if (shuttingDown) return;
  shuttingDown = true;
  log(reason);
  const current = channel;
  channel = null;
  try {
    current?.close();
  } catch {
    /* 尽力而为：关闭失败不影响退出 */
  }
  process.exit(exitCode);
}

/**
 * 在「行输入 + 帧输出」之上提供 MCP 服务，直到 stdin 关闭或收到信号。
 * 生产环境用默认参数调用；测试会注入 PassThrough 流并传 `exitOnClose: false`
 * 以隔离运行。
 *
 * 不变量：只有协议帧会写入 `output`，诊断信息一律走 stderr。
 * 默认 `exitOnClose: true` 时，空闲状态下除 stdin 外没有任何句柄维持事件循环，
 * 关闭 stdin 或收到 SIGINT/SIGTERM 都能干净退出。
 *
 * @param {NodeJS.ReadableStream} [input] 换行分隔的 JSON-RPC 输入源
 * @param {NodeJS.WritableStream} [output] 只输出协议帧的目标流
 * @param {{exitOnClose?: boolean}} [options] exitOnClose=false 时关闭 stdin 不退出（测试用）
 * @returns {import('node:readline').Interface} readline 接口，便于测试与观察生命周期
 */
function startStdioServer(input = process.stdin, output = process.stdout, { exitOnClose = true } = {}) {
  frameOutput = output;

  /** @type {Set<Promise<void>>} */
  const inflight = new Set();
  let stdinClosed = false;

  /**
   * 只有在「需要随关闭退出 + stdin 已关闭 + 未在退出 + 无在途请求」时才退出，
   * 确保已经读取的请求仍能写完响应帧，不会截断最后一个工具调用的结果。
   */
  const exitWhenIdle = () => {
    if (!exitOnClose || !stdinClosed || shuttingDown || inflight.size > 0) return;
    shutdown(0, 'stdin closed; exiting');
  };

  /** 跟踪在途请求，完成后从集合中移除并重新评估是否可以退出。 */
  const track = (promise) => {
    const tracked = promise.finally(() => {
      inflight.delete(tracked);
      exitWhenIdle();
    });
    inflight.add(tracked);
    return tracked;
  };

  // crlfDelay: Infinity 让 Windows 的 \r\n 也按单行切分。
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
    // 用 Promise.resolve() 包一层，保证 handler 内同步抛错也能被 catch 捕获。
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

    // MCP host 断开管道时 stdout 会产生 EPIPE：视为宿主已退出，正常收尾。
    process.stdout.on('error', (error) => {
      if (error?.code === 'EPIPE') shutdown(0, 'stdout closed by the MCP host');
      else log('stdout error:', error?.message || error);
    });
  }

  installSafetyHandlers();
  log(`ready: ${TOOLS.length} tools, broker ${IPC_NAME} (lazy)`);
  return rl;
}

/** 绝不让游离的 rejection 打垮协议流（只安装一次）。 */
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
// 入口
// ---------------------------------------------------------------------------

/**
 * --broker 模式：动态导入 broker 模块并运行 broker 主循环。
 * 采用动态导入是为了让普通 MCP 模式不加载 broker 及其 CDP 依赖。
 *
 * @returns {Promise<void>}
 * @throws {Error} broker.mjs 未导出 runBroker 时
 */
async function runBrokerMode() {
  const { runBroker } = await import('./broker.mjs');
  if (typeof runBroker !== 'function') {
    throw new Error('broker.mjs does not export runBroker()');
  }
  await runBroker();
}

if (isBrokerMode) {
  // broker 模式由父 bridge 进程 detached 拉起；失败只设置退出码，交给日志排查。
  runBrokerMode().catch((error) => {
    log('broker mode failed:', error?.stack || error?.message || error);
    process.exitCode = 1;
  });
} else if (isMain) {
  // 被 MCP host 作为子进程启动（或直接 node bridge.mjs 运行）时进入 stdio 服务模式。
  startStdioServer();
}
