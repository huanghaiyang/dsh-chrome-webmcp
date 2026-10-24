/**
 * broker 为某个固定的 DevTools 端口独占唯一一条 Chrome 连接，并把所有 MCP 客户端
 * 进程（以及所有任务命名空间）复用在这条连接上。
 *
 * 为什么要独立进程：否则两个 DSH host（例如一个 Web 会话和一个 CLI 运行）会各自
 * 打开一条 CDP socket、各自启用 WebMCP、各自重放工具注册表，并争抢同一批页面。
 * 单一 broker 带来一条通道、一份持久注册表、公平调度和任务级页面归属。
 *
 * 架构位置：bridge.mjs（每个 MCP host 一个） --IPC--> 本文件（每个 CDP 端口一个）
 * --CDP WebSocket--> Chrome。broker 由 bridge 在首次调用发现端点无人监听时懒拉起。
 *
 * 主要流程与不变量：
 *  - 一个 broker 进程只持有一条 CDP WebSocket（见 lib/cdp.mjs 的 ChromeCdp）；
 *  - 页面归属由 TaskBook 维护（open_page 打开、close_task 释放），未归属页面为共享；
 *  - WebMCP 会话按 targetId 复用（SessionBook），避免重复启用/重放；
 *  - IPC 方法全部经 dispatch() 分发，除 hello/ping 外必须先完成握手；
 *  - 所有客户端断开后经过 idleMs 空闲期自动退出，并落盘归属文件。
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  ACTION_SETTLE_MS,
  BROKER_IDLE_MS,
  CDP_PORT,
  CHROME_LISTEN_WAIT_MS,
  DISCOVERY_CONCURRENCY,
  ENDPOINT,
  INVOKE_WAIT_MS,
  IPC_NAME,
  LOG_FILE,
  NAVIGATE_WAIT_MS,
  OWNERSHIP_FILE,
  SNAPSHOT_MAX_ELEMENTS,
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
import { PageBook } from './lib/pages.mjs';
import { SessionBook } from './lib/sessions.mjs';
import { TaskBook } from './lib/tasks.mjs';

/** 日志文件轮转阈值：超过 2 MB 就改名为 `<file>.1`，避免长期运行把磁盘写满。 */
const MAX_LOG_BYTES = 2 * 1024 * 1024;
/** 合法的 taskId：1-64 字符，首字符为字母/数字，其余可含 ".", "_", "-"。 */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * 把日志参数转为单行文本：字符串原样，其余尝试 JSON.stringify，
 * 遇到循环引用等不可序列化值时退回 String()。
 *
 * @param {any} value 任意日志参数
 * @returns {string} 可写入日志行的文本
 */
function format(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 创建按行追加的文件日志器（可选同时镜像到 stderr）。
 *
 * 启动时若文件已超过 MAX_LOG_BYTES 则轮转一次；打开失败（如权限问题）时
 * 仍返回可调用的函数，只是不落盘——日志不能成为 broker 的致命依赖。
 *
 * @param {string} file 日志文件绝对路径
 * @returns {((...parts: any[]) => void) & {close: () => void}} 写入函数，附带 close()
 */
function createLogger(file) {
  ensureStateDir();
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    /* 轮转属于尽力而为：失败不影响继续向原文件追加 */
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
        /* 写盘失败（磁盘满/句柄失效）不应影响 broker 主流程 */
      }
    }
    // 调试开关：设 CHROME_WEBMCP_BROKER_STDERR=1 时同时镜像到 stderr。
    if (process.env.CHROME_WEBMCP_BROKER_STDERR === '1') process.stderr.write(line);
  };
  write.close = () => {
    if (fd === undefined) return;
    try {
      fs.closeSync(fd);
    } catch {
      /* 忽略重复关闭 */
    }
    fd = undefined;
  };
  return write;
}

/**
 * 带并发上限的 map：最多 limit 个 worker 同时推进，结果保持输入顺序。
 *
 * 用于 list_tools 的页面扫描——防止一次向几十个页面并发发起 CDP 请求。
 *
 * @template T, R
 * @param {T[]} items 输入项
 * @param {number} limit 并发上限
 * @param {(item: T, index: number) => Promise<R>} worker 处理函数
 * @returns {Promise<R[]>} 与 items 顺序一致的结果数组
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  // 共享游标 next++ 是同步的，因此多个 runner 之间不会取到同一个下标。
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 校验并返回非空字符串参数。
 *
 * @param {any} value 原始值
 * @param {string} name 参数名（用于错误消息）
 * @returns {string} 校验后的字符串
 * @throws {IpcError} INVALID_PARAMS：缺失、非字符串或空串
 */
function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new IpcError('INVALID_PARAMS', `${name} must be a non-empty string`);
  }
  return value;
}

/** 元素索引上限：页面侧用 `>>> 0` 风格整数校验，超过 INT32_MAX 必然越界。 */
const MAX_INDEX = 2 ** 31 - 1;

/**
 * 校验 snapshot 元素索引：必须是 0..INT32_MAX 的整数。
 *
 * 只接受 number 或纯十进制数字字符串（"12"）。**不做隐式类型转换**：
 * `Number(null)` 是 0、`Number(true)` 是 1，若照抄就会把「模型漏填/填错」
 * 变成一次静默的误点击（点到第 0 个元素，可能是删除/提交）。因此 null、布尔、
 * 数组、对象、空串一律按参数错误拒绝，上界也在这里卡住，避免下层 RangeError
 * 被兜底成 INTERNAL。
 *
 * @param {any} value 原始索引
 * @returns {number} 归一化后的整数索引
 * @throws {IpcError} INVALID_PARAMS：类型不合法、非整数、负数或超出 INT32_MAX
 */
function requireIndex(value) {
  let index = Number.NaN;
  if (typeof value === 'number') {
    index = value;
  } else if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) {
    index = Number(value.trim());
  }
  if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) {
    throw new IpcError(
      'INVALID_PARAMS',
      `index must be a non-negative integer from snapshot (maximum ${MAX_INDEX})`,
    );
  }
  return index;
}

/**
 * 校验文本参数：允许空串（用于清空输入框），但必须是字符串。
 *
 * @param {any} value 原始值
 * @returns {string} 文本
 * @throws {IpcError} INVALID_PARAMS：不是字符串
 */
function requireText(value) {
  if (typeof value !== 'string') {
    throw new IpcError('INVALID_PARAMS', 'text must be a string');
  }
  return value;
}

/**
 * 把任意数值收敛为 [min, max] 内的整数；无法转成有限数时返回 fallback。
 * 用于 clickCount 这类「有默认值且有硬上限」的参数。
 *
 * @param {any} value 原始值
 * @param {number} fallback 非法输入时的默认值
 * @param {number} min 下限
 * @param {number} max 上限
 * @returns {number} 收敛后的整数
 */
function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

/** 写 broker 状态文件（供外部发现 pid/IPC/端口）；失败按尽力而为处理。 */
function writeStateFile(file, payload) {
  try {
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  } catch {
    /* 状态文件只是辅助信息，写失败不影响 broker 运行 */
  }
}

/** 删除状态文件（退出时调用）；文件不存在也不报错。 */
function removeStateFile(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* 忽略删除失败 */
  }
}

/**
 * 启动 broker。IPC 端点开始监听后 Promise 才 resolve。
 * 返回 `{ brokerId, ipcName, port, server, sessions, tasks, stats, close }`，
 * 其中 `close()` 幂等（见下方实现）。
 *
 * 所有可调项都在 options 中：port / ipcName / stateFile / ownershipFile / idleMs /
 * logFile / settleMs / invokeWaitMs / actionSettleMs / navigateWaitMs /
 * handleSignals。测试用这些注入随机端口、临时文件和 handleSignals: false。
 *
 * @param {object} [options] 覆盖默认配置的选项
 * @returns {Promise<{brokerId: string, ipcName: string, port: number, server: any, sessions: any, tasks: any, stats: () => object, close: () => Promise<void>}>} broker 句柄
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
  // SessionBook 负责每个 target 的 WebMCP 启用与工具注册表缓存（按 targetId 复用）。
  const sessions = new SessionBook({
    cdp,
    log,
    settleMs: Number(options.settleMs ?? TOOL_SETTLE_MS),
    invokeWaitMs: Number(options.invokeWaitMs ?? INVOKE_WAIT_MS),
  });
  // TaskBook 维护任务 → 页面归属（持久化到 ownershipFile，broker 重启后可恢复）。
  const tasks = new TaskBook({ cdp, sessions, log, ownershipFile });
  // PageBook 承载浏览器操作：snapshot / click / type_text / press_key / navigate。
  const pageBook = new PageBook({
    cdp,
    log,
    settleMs: Number(options.actionSettleMs ?? ACTION_SETTLE_MS),
    navigateWaitMs: Number(options.navigateWaitMs ?? NAVIGATE_WAIT_MS),
  });

  /** 已连接的客户端：client.id → {id, name, channel, handshaken, connectedAt}。 */
  const clients = new Map();
  /** 最后一个客户端离开的时刻，空闲退出计时以此为基准。 */
  let lastClientLeftAt = Date.now();
  let closed = false;
  let idleTimer = null;
  let server = null;

  /**
   * 查询 Chrome 是否可达，返回统一结构（status/hello 都会用到）。
   * version() 走缓存，避免每次状态查询都打一次 CDP。
   *
   * @returns {Promise<{reachable: boolean, browser: string|null, protocolVersion: string|null, error: string|null}>} Chrome 现状
   */
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

  /**
   * 启动 Chrome（仅在 DevTools 端口无人监听时）。已运行则直接返回，不重复拉起。
   *
   * 启动参数必须同时带 base::Feature 与 Blink feature 才能拿到 document.modelContext；
   * 使用独立的 USER_DATA_DIR，避免与用户日常浏览的 profile 互相干扰。
   *
   * @param {{url?: string, timeoutMs?: number}} [params] 初始 URL 与端口等待上限
   * @returns {Promise<object>} launched/alreadyRunning/port/browser 等启动结果
   * @throws {CdpError} BROWSER_LAUNCH_FAILED：找不到 Chrome 可执行文件，或超时仍未监听端口
   */
  const launchChrome = async ({ url, timeoutMs } = {}) => {
    // cacheMs: 0 强制实时探测，避免用缓存的「不可达」误判。
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
      /* 目录创建失败不在这里判断，让 spawn 暴露真正的问题 */
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
      // 在 Chrome 155 上验证过：base::Feature "enable-webmcp-testing" 与 Blink 运行时
      // feature "WebMCP" 两者缺一不可，否则拿不到 document.modelContext。
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
    // 轮询 DevTools 端点直到超时；250 ms 间隔在启动延迟与额外 CDP 压力之间取平衡。
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

  /**
   * list_tools：对任务可见的候选页面并发（受 DISCOVERY_CONCURRENCY 限制）收集 WebMCP 工具。
   *
   * 单个页面失败不影响整体结果：该页 tools 置空并带上 error 码，
   * 由 skipped 计数告知调用方有多少页被跳过。
   *
   * @param {{name: string}} client 发起请求的客户端（用于会话登记）
   * @param {object} params {taskId, targetId, url, waitMs, refresh}
   * @returns {Promise<{taskId: string, candidates: number, pages: object[], skipped: number}>} 页面与工具清单
   */
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
        // 页面级失败被降级为数据，而不是让整个 list_tools 调用失败。
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

  /**
   * invoke_tool：先在候选页面里定位注册了该工具名的页面，再调用它。
   *
   * 定位顺序由 tasks.candidates 决定（本任务页面优先、最近打开的在前，然后是未归属页面）。
   * 显式给出 targetId + frameId 时跳过注册表扫描直接调用；否则扫描所有候选页，
   * 若多页注册同名工具则结果标记 ambiguous（仍调用第一个匹配）。
   *
   * @param {{name: string}} client 发起请求的客户端
   * @param {object} params {taskId, toolName, input, targetId, url, frameId, waitMs}
   * @returns {Promise<object>} 含 taskId/targetId/frameId/status/output/ambiguous 的调用结果
   * @throws {IpcError} FRAME_WITHOUT_TARGET：给了 frameId 却没给 targetId
   * @throws {CdpError} TOOL_NOT_FOUND：任务无可用页面，或所有候选页都没注册该工具
   */
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
    // 显式给出 frameId + targetId 时寻址信息已完整，无需扫描注册表，直接调用。
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
        // 扫描阶段只等待一个 settle 窗口（且不超过调用方的 waitMs），
        // 真正的调用等待由下面的 sessions.invoke 承担。
        const tools = await sessions.listTools(page.targetId, {
          waitMs: Math.min(Number(params.waitMs) || sessions.invokeWaitMs, sessions.settleMs),
          clientId: client.name,
        });
        const tool = tools.find((entry) => entry.name === toolName);
        if (tool) matches.push({ page, tool });
      } catch (error) {
        // 单页扫描失败只记录；其他页面仍可能注册了该工具。
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
    // 多个匹配时选择第一个（本任务最新页面优先），并用 ambiguous 提示调用方存在歧义。
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

  /**
   * 从任务可见的候选页面里挑出要操作的那一个（按 tasks.candidates 的优先级取第一个：
   * targetId 精确指定 → 本任务最近打开的页面 → 未归属页面）。
   *
   * @param {string} taskId 已归一化的任务命名空间
   * @param {{targetId?: string, url?: string}} params 目标约束
   * @returns {Promise<object>} 页面对象（含 targetId）
   * @throws {CdpError} TARGET_NOT_FOUND：没有任何可用页面
   */
  const pageFor = async (taskId, params) => {
    const candidates = await tasks.candidates(taskId, {
      targetId: params.targetId,
      url: params.url,
    });
    if (!candidates.length) {
      throw new CdpError(
        'TARGET_NOT_FOUND',
        `task "${taskId}" has no page to act on; call open_page or list_tools first`,
        { taskId },
      );
    }
    return candidates[0];
  };

  /**
   * 变更类动作（click / type_text / press_key / navigate）的页面解析。
   *
   * unowned 页面（用户自己打开的标签页）可以被 agent 操作，这是“操作我正开着的那一页”
   * 的真实场景；但**必须显式点名 targetId**。缺 targetId 时绝不静默挑一个 unowned 页面，
   * 否则并发任务会劫持用户正在用的标签页（也可能撞上另一个 agent 手动打开的页面）。
   * 只读感知（snapshot / list_tools / invoke_tool）不受此限制，仍按候选优先级自动选页。
   *
   * @param {string} taskId 已归一化的任务命名空间
   * @param {{targetId?: string, url?: string}} params 目标约束
   * @returns {Promise<object>} 页面对象（含 targetId）
   * @throws {CdpError} TARGET_ID_REQUIRED：解析到 unowned 页面但没有显式 targetId
   * @throws {CdpError} TARGET_NOT_FOUND / TARGET_OTHER_TASK：见 pageFor
   */
  const pageForAction = async (taskId, params) => {
    const page = await pageFor(taskId, params);
    if (!params.targetId && tasks.pageFacts(page).ownedBy === null) {
      throw new CdpError(
        'TARGET_ID_REQUIRED',
        `task "${taskId}" resolved to unowned page ${page.targetId}, which no task opened; ` +
          'pass that targetId explicitly to act on the user\'s tab, or call open_page to create ' +
          'a task-owned page',
        { taskId, targetId: page.targetId },
      );
    }
    return page;
  };

  /**
   * snapshot：感知页面，返回编号化的可见交互元素列表。
   * 在隔离 world 中执行，不修改页面；索引只对本次快照有效。
   *
   * @param {{name: string}} client 客户端
   * @param {object} params {taskId, targetId, url, maxElements}
   * @returns {Promise<object>} 含 targetId/url/title/snapshotId/elements/total/truncated/snapshot
   */
  const snapshot = async (client, params) => {
    const taskId = tasks.normalize(params.taskId);
    const page = await pageFor(taskId, params);
    const data = await pageBook.snapshot(page.targetId, {
      maxElements: params.maxElements ?? SNAPSHOT_MAX_ELEMENTS,
      clientId: client.name,
    });
    return {
      taskId,
      targetId: page.targetId,
      url: data.url,
      title: data.title,
      snapshotId: data.snapshotId,
      elements: data.elements,
      total: data.total,
      truncated: data.truncated,
      snapshot: data.text,
    };
  };

  /**
   * click：按快照索引点击元素。未知的 button 值静默降级为 'left'；
   * clickCount 收敛到 1..3。点击后等待 settle 并回读 URL/title 供模型判断结果。
   *
   * @param {{name: string}} client 客户端
   * @param {object} params {taskId, targetId, url, index, button, clickCount, waitMs}
   * @returns {Promise<object>} 动作结果 + 动作后的 url/title
   * @throws {IpcError} INVALID_PARAMS：index 非法
   * @throws {CdpError} TARGET_NOT_FOUND / 页面侧点击失败
   */
  const click = async (client, params) => {
    const taskId = tasks.normalize(params.taskId);
    const index = requireIndex(params.index);
    const page = await pageForAction(taskId, params);
    const button =
      params.button === 'right' || params.button === 'middle' ? params.button : 'left';
    const clicked = await pageBook.click(page.targetId, {
      index,
      button,
      clickCount: clampInteger(params.clickCount, 1, 1, 3),
      clientId: client.name,
    });
    await pageBook.settle(params.waitMs);
    const facts = await pageBook.targetFacts(page.targetId, client.name);
    return {
      taskId,
      targetId: page.targetId,
      action: 'click',
      ...clicked,
      url: facts.url,
      title: facts.title,
    };
  };

  /**
   * type_text：按索引聚焦输入框并插入文本。clear 默认为 true（替换原有内容），
   * submit 默认为 false；对 <select> 则按 value 或可见 label 选项匹配。
   *
   * @param {{name: string}} client 客户端
   * @param {object} params {taskId, targetId, url, index, text, clear, submit, waitMs}
   * @returns {Promise<object>} 动作结果 + 动作后的 url/title
   * @throws {IpcError} INVALID_PARAMS：index 或 text 非法
   */
  const typeText = async (client, params) => {
    const taskId = tasks.normalize(params.taskId);
    const index = requireIndex(params.index);
    const text = requireText(params.text);
    const page = await pageForAction(taskId, params);
    const typed = await pageBook.typeText(page.targetId, {
      index,
      text,
      clear: params.clear !== false,
      submit: params.submit === true,
      clientId: client.name,
    });
    await pageBook.settle(params.waitMs);
    const facts = await pageBook.targetFacts(page.targetId, client.name);
    return {
      taskId,
      targetId: page.targetId,
      action: 'type_text',
      ...typed,
      url: facts.url,
      title: facts.title,
    };
  };

  /**
   * press_key：向当前聚焦元素/页面发送一个按键或组合键（如 "Enter"、"Control+A"）。
   *
   * @param {{name: string}} client 客户端
   * @param {object} params {taskId, targetId, url, key, waitMs}
   * @returns {Promise<object>} 动作结果 + 动作后的 url/title
   * @throws {IpcError} INVALID_PARAMS：key 非字符串或为空
   */
  const pressKey = async (client, params) => {
    const taskId = tasks.normalize(params.taskId);
    const key = requireString(params.key, 'key');
    const page = await pageForAction(taskId, params);
    const pressed = await pageBook.pressKey(page.targetId, {
      key,
      clientId: client.name,
    });
    await pageBook.settle(params.waitMs);
    const facts = await pageBook.targetFacts(page.targetId, client.name);
    return {
      taskId,
      targetId: page.targetId,
      action: 'press_key',
      ...pressed,
      url: facts.url,
      title: facts.title,
    };
  };

  /**
   * navigate：让现有页面（同一 tab）跳转到新 URL，等待 readyState 变为 complete。
   *
   * 只接受 http(s)/file/about 协议，其他 scheme（javascript:、data: 等）一律拒绝。
   * 注意此处只按 targetId 定位，不参与 url 子串过滤（因为导航后 URL 会变）。
   *
   * @param {{name: string}} client 客户端
   * @param {object} params {taskId, targetId, url, waitMs}
   * @returns {Promise<object>} 含 requestedUrl/url/title/loaded/elapsedMs 的结果
   * @throws {IpcError} INVALID_PARAMS：url 缺失或协议不被允许
   * @throws {CdpError} TARGET_NOT_FOUND：任务没有可导航的页面
   */
  const navigate = async (client, params) => {
    const taskId = tasks.normalize(params.taskId);
    const url = requireString(params.url, 'url');
    if (!/^(https?:|file:|about:)/i.test(url)) {
      throw new CdpError('INVALID_PARAMS', 'url must be an http(s), file, or about URL', { url });
    }
    const page = await pageForAction(taskId, { targetId: params.targetId });
    const result = await pageBook.navigate(page.targetId, {
      url,
      waitMs: params.waitMs,
      clientId: client.name,
    });
    const facts = await pageBook.targetFacts(page.targetId, client.name);
    return {
      taskId,
      targetId: page.targetId,
      action: 'navigate',
      requestedUrl: url,
      // 导航后若读取不到目标页事实（例如页面尚未就绪），退回请求的 URL。
      url: facts.url || url,
      title: facts.title,
      loaded: result.loaded,
      elapsedMs: result.elapsedMs,
    };
  };

  /**
   * IPC 方法分发入口：校验握手状态，然后路由到对应的处理函数。
   *
   * 除 hello / ping 外，所有方法都要求先握手；这样 broker 能在日志和会话里
   * 使用稳定的 clientId（而非临时连接 id）。
   *
   * @param {{id: string, name: string, handshaken: boolean}} client 客户端状态
   * @param {string} method IPC 方法名
   * @param {object} [params] 方法参数
   * @returns {Promise<any>} 方法返回值
   * @throws {IpcError} INVALID_PARAMS（未握手）、METHOD_NOT_FOUND（未知方法）、CONFIRM_REQUIRED（未确认关闭浏览器）
   * @throws {CdpError} 各方法自身的业务错误
   */
  const dispatch = async (client, method, params = {}) => {
    if (!client.handshaken && method !== 'hello' && method !== 'ping') {
      throw new IpcError('INVALID_PARAMS', 'send hello before any other request');
    }
    switch (method) {
      case 'hello': {
        // clientId 截断到 128 字符，防止异常客户端写入超长名字污染日志/归属文件。
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
      case 'snapshot':
        return await snapshot(client, params);
      case 'click':
        return await click(client, params);
      case 'type_text':
        return await typeText(client, params);
      case 'press_key':
        return await pressKey(client, params);
      case 'navigate':
        return await navigate(client, params);
      case 'open_page': {
        const url = requireString(params.url, 'url');
        // isolated: true 会为新任务创建一个独立的浏览器上下文（独立 cookie/storage）。
        return await tasks.openPage({
          taskId: params.taskId,
          url,
          isolated: params.isolated === true,
          waitMs: params.waitMs,
          clientId: client.name,
        });
      }
      case 'close_task': {
        const result = await tasks.closeTask({ taskId: params.taskId });
        // TaskBook 只管归属，PageBook 需要同步丢弃这些 target 的缓存/快照状态。
        for (const targetId of result.closedTargetIds) pageBook.dropTarget(targetId);
        return result;
      }
      case 'close_browser':
        // 关闭整个浏览器影响所有任务，必须显式 confirm，避免误触。
        if (params.confirm !== true) {
          throw new IpcError('CONFIRM_REQUIRED', 'close_browser requires confirm: true');
        }
        return await tasks.closeBrowser();
      case 'launch':
        return await launchChrome({ url: params.url, timeoutMs: params.timeoutMs });
      case 'shutdown':
        // 延迟 100 ms 再关，保证当前响应帧先写回客户端；unref 不阻止进程退出。
        setTimeout(() => void close(), 100).unref?.();
        return { stopping: true };
      default:
        throw new IpcError('METHOD_NOT_FOUND', `unknown broker method: ${method}`);
    }
  };

  server = await createIpcServer(ipcName, {
    onConnection(channel) {
      // 每个 IPC 连接初始处于未握手状态，hello 之后才拥有稳定的客户端名。
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
        // 空闲计时从「最后一个客户端离开」开始，而不是从启动时开始。
        if (clients.size === 0) lastClientLeftAt = Date.now();
        log('[broker] client disconnected', client.id, `clients=${clients.size}`);
      };
    },
    onError(error) {
      log('[broker] ipc server error', error?.message || String(error));
    },
  });

  // 测试或受限环境可能请求 port 0；此时回报操作系统实际分配的端口，客户端才能连上。
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
  /**
   * 关闭 broker：停空闲计时、落盘归属、关 IPC 服务端、断开 CDP、删除状态文件。
   * 幂等（closed 标志），可从空闲计时器、shutdown 方法或信号处理器并发触发。
   */
  const close = async () => {
    if (closed) return;
    closed = true;
    if (idleTimer) clearInterval(idleTimer);
    try {
      tasks.persist();
    } catch {
      /* 归属持久化属于尽力而为：失败不阻止关闭 */
    }
    try {
      await server.close();
    } catch {
      /* 已关闭则忽略 */
    }
    try {
      await cdp.close();
    } catch {
      /* 连接已断则忽略 */
    }
    removeStateFile(stateFile);
    log('[broker] stopped');
    log.close();
  };

  // 空闲退出：无客户端且持续 idleMs 后自动关闭，避免 broker 永久驻留。
  // 轮询周期取 idleMs/2，并夹在 [250 ms, 30 s]，兼顾及时性与开销。
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
      // 异常退出前尽量保住归属信息，避免重启后页面被当成无主页面。
      log('[broker] uncaught exception', error?.stack || error?.message || String(error));
      try {
        removeStateFile(stateFile);
      } catch {
        /* 忽略 */
      }
      try {
        tasks.persist();
      } catch {
        /* 归属持久化属于尽力而为 */
      }
      try {
        log.close();
      } catch {
        /* 忽略 */
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

/**
 * 导出 taskId 校验正则，供测试与上层复用（不导出内部实现）。
 */
export { TASK_ID };

// 只有被直接执行（node broker.mjs）时才自启动；被 import 时由调用方驱动。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await runBroker();
}
