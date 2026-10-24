/**
 * Chrome WebMCP 桥接器的共享配置与小工具函数。
 *
 * 职责：
 *  - 把端口、IPC 端点、状态目录、各类超时/并发上限等运行参数集中在一处，
 *    并全部交由环境变量驱动；
 *  - 由 `process.platform` 与端口号推导出默认路径（命名管道 / Unix socket /
 *    Chrome 用户数据目录），避免在仓库里写入与具体机器相关的绝对路径；
 *  - 提供跨模块依赖为零的小工具：正整数解析、Chrome 可执行文件探测、休眠。
 *
 * 使用方：`bridge.mjs`（MCP 客户端侧）、`broker.mjs`（后台代理进程）、
 * `lib/ipc.mjs`、`lib/cdp.mjs`、`lib/sessions.mjs`，以及安装/启动脚本
 * `install.mjs`。MCP 客户端与 broker 各自独立启动，二者只能通过本文件
 * 推导出相同的默认值，否则会连不上同一个端点。
 *
 * 关键不变量：
 *  - 所有数值配置都经过 `positiveInt` 归一化：非法（NaN、0、负数）输入一律
 *    回退到默认值，因此下游可以假定拿到的是正整数。
 *  - 状态目录、日志、所有权文件、Chrome profile 都必须按 CDP 端口隔离；
 *    端口 9333 保留历史目录名以兼容旧安装。
 *  - 本模块只读环境变量，不做任何 I/O 副作用（`ensureStateDir` 除外，且它
 *    失败时静默降级）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** MCP 服务对外暴露的名称，写入 MCP 握手与日志。 */
export const SERVER_NAME = 'chrome-webmcp';
/** 桥接器版本号，同时用于 `describeConfig()` 与 MCP server info。 */
export const VERSION = '2.0.0';

/**
 * 把环境变量字符串解析成正整数。
 *
 * 环境变量天然是字符串，且可能为空串、小数或负数；这里统一向下取整，
 * 非法值直接回退到调用方给定的默认值，避免把 `NaN` 传播到 setTimeout
 * 或并发计数里。
 *
 * @param {string|number|undefined} value 原始值（通常来自 process.env）。
 * @param {number} fallback 解析失败时使用的默认值。
 * @returns {number} 大于 0 的整数。
 */
const positiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/** 桥接器所连接浏览器的 DevTools 端口。 */
export const CDP_PORT = positiveInt(process.env.CHROME_CDP_PORT, 9333);
/** DevTools HTTP 端点基地址；CDP WebSocket 地址由 `/json/version` 推导。 */
export const ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;

/** 本地数据根目录：优先使用 Windows 的 LOCALAPPDATA，否则退到系统临时目录。 */
const LOCAL_BASE = process.env.LOCALAPPDATA || os.tmpdir();

/**
 * 按端口推导 broker 状态目录（日志、broker.json、ownership.json 都放这里）。
 *
 * 两个 Chrome 调试端口绝不能共用同一个状态目录：否则 ownership 文件会互相
 * 覆盖，日志也会交错。Chrome 对同一份 `--user-data-dir` 会复用第一个实例，
 * 第二个端口实际不会打开，所以 profile 目录同样需要按端口隔离（见
 * `defaultUserDataDir`）。
 *
 * 端口 9333 沿用历史目录名（不带端口后缀），保证老用户的现有状态不被丢弃。
 *
 * @param {number} [port=CDP_PORT] CDP 端口号。
 * @returns {string} 绝对目录路径。
 */
export function defaultStateDir(port = CDP_PORT) {
  const base = path.join(LOCAL_BASE, 'dsh-chrome-webmcp');
  return port === 9333 ? base : `${base}-${port}`;
}

/**
 * 按端口推导 `launch` 使用的独立 Chrome 用户数据目录。
 *
 * 每个调试端口必须有自己的 profile，否则第二次启动会被已有 Chrome 实例
 * 接管，新端口永远不会监听。
 *
 * @param {number} [port=CDP_PORT] CDP 端口号。
 * @returns {string} 绝对目录路径。
 */
export function defaultUserDataDir(port = CDP_PORT) {
  const base = path.join(LOCAL_BASE, 'dsh-webmcp-chrome');
  return port === 9333 ? base : `${base}-${port}`;
}

/** 本端口所有 bridge 进程共享的本地 IPC 端点。 */
export const IPC_NAME = process.env.CHROME_WEBMCP_IPC || defaultIpcName(CDP_PORT);

/** 桥接器自己的状态（日志、broker 元数据、任务归属）。绝不放在仓库目录内。 */
export const STATE_DIR = process.env.CHROME_WEBMCP_STATE_DIR || defaultStateDir(CDP_PORT);
/** broker 日志文件，用于排障；也可被外部工具 tail。 */
export const LOG_FILE = path.join(STATE_DIR, 'broker.log');
/** broker 运行时元数据（端口、pid 等），供探测与诊断使用。 */
export const STATE_FILE = path.join(STATE_DIR, 'broker.json');
/** 任务与 page target 的归属关系，跨 broker 重启保留，避免任务丢失。 */
export const OWNERSHIP_FILE = path.join(STATE_DIR, 'ownership.json');

/** `launch` 需要自行拉起浏览器时使用的隔离 Chrome profile 目录。 */
export const USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR || defaultUserDataDir(CDP_PORT);

/** 启动/复用 Chrome 后等待 DevTools 端口开始监听的最长时间。 */
export const CHROME_LISTEN_WAIT_MS = positiveInt(process.env.CHROME_LISTEN_WAIT_MS, 25000);
/** 用于判断页面“已回放完工具”的静默窗口时长。 */
export const TOOL_SETTLE_MS = positiveInt(process.env.CHROME_TOOL_SETTLE_MS, 1200);
/** 调用一次 WebMCP 工具后等待 `toolResponded` 事件的默认上限。 */
export const INVOKE_WAIT_MS = positiveInt(process.env.CHROME_INVOKE_WAIT_MS, 20000);
/** 单次 browser-use 快照的默认元素预算（MCP 工具入参可覆盖）。 */
export const SNAPSHOT_MAX_ELEMENTS = positiveInt(process.env.CHROME_SNAPSHOT_MAX_ELEMENTS, 200);
/** click/type/press 之后的等待时长，让页面先反应再读取事实。 */
export const ACTION_SETTLE_MS = positiveInt(process.env.CHROME_ACTION_SETTLE_MS, 300);
/** browser-use navigate 的默认加载等待（MCP 工具入参可覆盖）。 */
export const NAVIGATE_WAIT_MS = positiveInt(process.env.CHROME_NAVIGATE_WAIT_MS, 10000);

/** broker 在没有客户端连接时，空闲这么久后退出；Chrome 本身保持运行。 */
export const BROKER_IDLE_MS = positiveInt(process.env.CHROME_WEBMCP_BROKER_IDLE_MS, 600000);
/** 等待 broker 完成启动（监听 IPC）的最长时间。 */
export const BROKER_START_WAIT_MS = positiveInt(process.env.CHROME_WEBMCP_START_WAIT_MS, 12000);

/** 整个 CDP 通道允许同时在途的命令总数上限。 */
export const MAX_INFLIGHT = positiveInt(process.env.CHROME_WEBMCP_MAX_INFLIGHT, 32);
/** 单个客户端允许同时在途的命令数上限（公平性由 cdp 调度器保证）。 */
export const CLIENT_MAX_INFLIGHT = positiveInt(process.env.CHROME_WEBMCP_CLIENT_MAX_INFLIGHT, 8);
/** 单条 CDP 命令的默认超时（含等待调度槽位的时间）。 */
export const CDP_TIMEOUT_MS = positiveInt(process.env.CHROME_CDP_TIMEOUT_MS, 30000);
/** 批量发现 page target 时的并发度。 */
export const DISCOVERY_CONCURRENCY = positiveInt(process.env.CHROME_WEBMCP_DISCOVERY_CONCURRENCY, 4);

/** 单条换行分隔 IPC 帧的硬上限，超出即断开连接，防止内存被无换行数据拖爆。 */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;
/** 工具调用等待时间的绝对上限，任何调用方传入的 waitMs 都会被夹到该值以内。 */
export const MAX_TOOL_WAIT_MS = 120000;

/**
 * 推导 IPC 端点：Windows 用命名管道，其他平台用临时目录下的 Unix socket。
 *
 * 名称里带端口，确保不同 CDP 端口对应不同 broker，互不串扰。
 *
 * @param {number} [port=CDP_PORT] CDP 端口号。
 * @returns {string} Windows 返回 `\\.\pipe\...`，其他平台返回 .sock 路径。
 */
export function defaultIpcName(port = CDP_PORT) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\dsh-chrome-webmcp-${port}`;
  return path.join(os.tmpdir(), `dsh-chrome-webmcp-${port}.sock`);
}

/**
 * 尽力创建状态目录。
 *
 * 失败（权限不足、路径被占用等）只影响诊断能力，bridge 仍可继续运行，
 * 因此这里静默吞掉异常，不向调用方抛错。
 */
export function ensureStateDir() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch {
    /* 仅用于诊断；没有状态目录 bridge 也能工作 */
  }
}

/**
 * 等待指定毫秒数。
 *
 * @param {number} ms 毫秒数。
 * @returns {Promise<void>} 定时器触发后完成。
 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 按优先级列出可能的 Chrome 可执行文件路径。
 *
 * 顺序即优先级：`CHROME_PATH` 环境变量最高，其次各平台常见安装位置；
 * 末尾用 `filter(Boolean)` 去掉未设置的环境变量项。
 *
 * @returns {string[]} 候选绝对路径（不保证存在）。
 */
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

/**
 * 依次探测候选路径，返回第一个真实存在的 Chrome 可执行文件。
 *
 * `existsSync` 对畸形路径可能抛错，单个候选失败不影响后续探测。
 *
 * @returns {string|undefined} 找到时返回路径，全部失败返回 undefined。
 */
export function findChrome() {
  for (const candidate of chromeCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* 继续尝试下一个候选 */
    }
  }
  return undefined;
}

/** bridge 模块所在目录，从本文件位置推导（被链接/复制后仍能正确定位）。 */
export const BRIDGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/** bridge 入口文件路径，供 MCP 配置与安装脚本引用。 */
export const BRIDGE_ENTRY = path.join(BRIDGE_DIR, 'bridge.mjs');

/**
 * 汇总当前生效的关键配置，用于日志与诊断输出。
 *
 * @returns {{version: string, port: number, endpoint: string, ipc: string, stateDir: string, ownershipFile: string, userDataDir: string}} 配置快照。
 */
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
