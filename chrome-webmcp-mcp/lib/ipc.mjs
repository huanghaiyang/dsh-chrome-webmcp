/**
 * 在本地套接字之上跑的“换行分隔 JSON”协议。
 *
 * bridge 用它承载 broker 协议的全部两个方向：
 *   MCP 客户端进程  <->  broker 进程  <->  一条 Chrome DevTools 套接字
 *
 * 职责：
 *  - `connectIpc` / `createIpcServer` 负责客户端连接与服务端监听（命名管道、
 *    Unix socket，或显式回环 TCP）；
 *  - `LineChannel` 负责分帧、请求/响应按 `id` 配对、超时释放、断线清理。
 *
 * 使用方：`bridge.mjs`（作为客户端）、`broker.mjs`（作为服务端）。
 *
 * 协议不变量：
 *  - 每一帧是单行、单个 JSON 对象。请求带 `id` 与 `method`；响应带相同 `id`
 *    以及 `ok`，成功时附 `result`，失败时附 `{code, message}` 错误。
 *  - 任何不可信数据都不会被当作代码执行（只做 JSON.parse）。
 *  - 一条连接上的在途请求由 `pending` 表跟踪；连接关闭时全部以
 *    `IPC_CLOSED` 拒绝，绝不留下悬挂 Promise。
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { MAX_LINE_BYTES } from './config.mjs';

/**
 * IPC 层错误，携带稳定的机器可读错误码。
 *
 * 常见错误码：`IPC_CLOSED`（连接已关闭）、`IPC_TIMEOUT`（请求或连接超时）、
 * `METHOD_NOT_FOUND`（对端未注册请求处理器）、`EADDRINUSE`（端点已被占用）、
 * `INTERNAL`（未分类错误）。调用方可据此决定是否重试或重启 broker。
 */
export class IpcError extends Error {
  /**
   * @param {string} code 机器可读错误码。
   * @param {string} message 人类可读的错误描述。
   * @param {*} [data] 附加诊断数据，会原样透传给对端。
   */
  constructor(code, message, data) {
    super(message);
    this.name = 'IpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/**
 * 解析端点描述。
 *
 * 端点要么是本地 socket 路径（默认即命名管道 / Unix socket），要么是显式的
 * 回环监听地址 `tcp://127.0.0.1:<port>`。TCP 形式只用于测试以及不可用命名
 * 管道的受限环境；无论如何，默认端点都不会离开本机。
 *
 * @param {string} ipcName 端点字符串。
 * @returns {{tcp: true, host: string, port: number}|{tcp: false, path: string}} 解析结果。
 */
function parseEndpoint(ipcName) {
  if (typeof ipcName === 'string' && ipcName.startsWith('tcp://')) {
    const url = new URL(ipcName);
    return { tcp: true, host: url.hostname || '127.0.0.1', port: Number(url.port) };
  }
  return { tcp: false, path: ipcName };
}

/**
 * 把任意异常转换成可跨 IPC 传输的纯 JSON 结构。
 *
 * Error 实例的 `message`/`stack` 不可枚举，直接 JSON.stringify 会丢失信息，
 * 所以这里显式挑出 `code`、`message` 与可选的 `data`。非 IpcError 且无 code
 * 的异常统一降级为 `INTERNAL`。
 *
 * @param {*} error 捕获到的异常。
 * @returns {{code: string, message: string, data?: *}} 序列化后的错误对象。
 */
export function errorToJson(error) {
  const data = error instanceof IpcError ? error.data : error?.data;
  return {
    code: error?.code || 'INTERNAL',
    message: String(error?.message || error),
    ...(data !== undefined ? { data } : {}),
  };
}

/**
 * 单条连接的读写通道：分帧、请求配对、超时与关闭清理。
 *
 * 同一个类同时用于客户端与服务端，方向由谁调用 `request` / 谁设置
 * `onRequest` 决定。`label` 仅用于日志区分。
 *
 * @private
 */
class LineChannel {
  /**
   * @param {import('node:net').Socket} socket 已建立连接的套接字。
   * @param {{label?: string}} [options] `label` 用于日志标注对端角色。
   */
  constructor(socket, { label = 'ipc' } = {}) {
    this.socket = socket;
    this.label = label;
    /** 服务端分配的对端标识（`c-1`、`c-2`…）；客户端侧保持 null。 */
    this.clientId = null;
    /** id -> {resolve, reject, timer, method}，用于响应配对与超时。 */
    this.pending = new Map();
    this.nextId = 0;
    this.buffer = '';
    this.closed = false;
    /** 收到 `method` 帧时的处理函数，由上层安装。 */
    this.onRequest = null;
    /** 连接关闭时的回调，由上层安装。 */
    this.onClose = null;

    // 关闭 Nagle 算法，让小额控制帧（请求/响应）立即发出，降低往返延迟。
    socket.setNoDelay?.(true);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (error) => {
      // 先记下最后一个错误，真正的清理统一走 'close'，避免重复 reject。
      this.lastError = error;
    });
    socket.on('close', () => this.#onClosed());
  }

  /**
   * 累积数据并按换行切帧。
   *
   * 边界条件：如果缓冲区在还没有换行时就已经超过 `MAX_LINE_BYTES`，说明对端
   * 在发一条超大帧，立刻断开而不是继续吃内存；只要出现过换行就交给下面的
   * 循环逐帧处理，单个合法帧的大小不在这里限制。
   *
   * @param {string} chunk 新到达的 UTF-8 文本（socket 已设为 utf8 编码）。
   */
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
      // 允许空行（例如对端用换行做保活），直接跳过。
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // 协议被破坏时无法再信任该连接，直接断开。
        this.destroy(new Error('IPC peer sent a non-JSON line'));
        return;
      }
      this.#onMessage(message);
    }
  }

  /**
   * 分发单帧消息：响应走 `pending` 配对，请求交给 `onRequest`。
   *
   * 判定规则是“有 id 且没有 method”即为响应。缺少 `onRequest` 时，带 id 的
   * 请求会收到 `METHOD_NOT_FOUND`，无 id 的通知则被静默丢弃（fire-and-forget
   * 无需回复）。
   *
   * @param {*} message 已解析的 JSON 值。
   */
  #onMessage(message) {
    if (message === null || typeof message !== 'object') return;
    if (typeof message.id !== 'undefined' && !message.method) {
      const pending = this.pending.get(message.id);
      // 迟到的响应（已超时或连接正在关闭）直接忽略。
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
        // 没有处理器时，只有需要回复的请求才回错误；通知帧忽略即可。
        if (typeof message.id !== 'undefined') {
          this.send({ id: message.id, ok: false, error: { code: 'METHOD_NOT_FOUND', message: message.method } });
        }
        return;
      }
      // 异步执行处理器，避免长时间处理阻塞后续帧的读取与派发。
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

  /**
   * 写入一帧请求或响应，自动补换行符。
   *
   * @param {object} object 待序列化的消息。
   * @throws {IpcError} 连接已关闭时抛出 `IPC_CLOSED`。
   */
  send(object) {
    if (this.closed) throw new IpcError('IPC_CLOSED', 'IPC connection is closed');
    this.socket.write(`${JSON.stringify(object)}\n`);
  }

  /**
   * 发起一次请求并等待对端响应。
   *
   * 超时从“发出请求”开始计时，覆盖对端处理时间；计时器注册后立即写入
   * `pending`，再发送帧——如果发送本身抛错，需要同步撤销 `pending` 与计时器，
   * 否则会留下永远等不到响应的表项。
   *
   * @param {string} method 请求方法名。
   * @param {object} [params={}] 请求参数。
   * @param {{timeoutMs?: number}} [options] `timeoutMs` 默认 30000 毫秒。
   * @returns {Promise<*>} 对端返回的 `result`（缺省为 null）。
   * @throws {IpcError} `IPC_CLOSED`、`IPC_TIMEOUT`，或对端回传的错误码。
   */
  request(method, params = {}, { timeoutMs = 30000 } = {}) {
    if (this.closed) return Promise.reject(new IpcError('IPC_CLOSED', 'IPC connection is closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // 超时后必须先摘除表项，迟到的响应才能被当作未知 id 忽略。
        this.pending.delete(id);
        reject(new IpcError('IPC_TIMEOUT', `IPC request ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      // unref：仅剩计时器不应阻止进程退出。
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

  /**
   * 连接关闭后的统一清理（幂等）。
   *
   * 所有在途请求都以 `IPC_CLOSED` 拒绝并清空，防止调用方永久等待；
   * `onClose` 回调放在 try/catch 里，观察者抛错不能破坏清理流程。
   */
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
      /* 观察者异常不能破坏清理流程 */
    }
  }

  /**
   * 优雅关闭：先 `end` 刷新待写数据，再 `destroy` 兜底。
   */
  close() {
    try {
      this.socket.end();
    } catch {
      /* 忽略 */
    }
    try {
      this.socket.destroy();
    } catch {
      /* 忽略 */
    }
    this.#onClosed();
  }

  /**
   * 因协议错误而强制断开，并记录原因。
   *
   * @param {Error} error 触发断开的原因，保存在 `lastError` 供日志使用。
   */
  destroy(error) {
    this.lastError = error;
    try {
      this.socket.destroy();
    } catch {
      /* 忽略 */
    }
    this.#onClosed();
  }
}

/**
 * 连接到已存在的 broker 端点。
 *
 * 使用 `settled` 标志保证超时、错误、成功三条路径只触发一次；超时会主动
 * 销毁 socket，避免留下半开连接。
 *
 * @param {string} ipcName 端点字符串（socket 路径或 `tcp://host:port`）。
 * @param {{timeoutMs?: number}} [options] 连接超时，默认 2000 毫秒。
 * @returns {Promise<LineChannel>} 就绪的双向通道。
 * @throws {IpcError|Error} `IPC_TIMEOUT`（超时）；`ENOENT`/`ECONNREFUSED` 等
 *   表示没有 broker 在监听。
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

/**
 * 探测该端点上是否有 broker 接受连接。
 *
 * 连接成功后立即关闭，不留任何状态；任何异常都视为“不存活”。
 *
 * @param {string} ipcName 端点字符串。
 * @param {{timeoutMs?: number}} [options] 探测超时，默认 500 毫秒。
 * @returns {Promise<boolean>} 有 broker 监听时为 true。
 */
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
 * 启动 broker 的 IPC 监听端点。
 *
 * 在 Unix 上，socket 文件可能因上次进程异常退出而残留。这里先试探端点：
 * 如果仍有 broker 存活就报 `EADDRINUSE`（不能抢占别人的连接），只有确认是
 * 陈旧文件才删除重建。Windows 命名管道由系统管理，无需该处理。
 *
 * `onConnection` 会在每个客户端连上来时被调用，此时 `channel.clientId` 已分配
 * （形如 `c-1`）；调用方需要在该回调内安装 `channel.onRequest`。
 *
 * @param {string} ipcName 端点字符串（socket 路径或 `tcp://host:port`）。
 * @param {{onConnection?: (channel: LineChannel) => void, onError?: (error: Error) => void}} [options]
 *   `onConnection` 处理新连接；`onError` 接收监听器级别的运行时错误（注意与
 *   单连接错误区分，后者已由通道自身处理）。
 * @returns {Promise<{ipcName: string, server: import('node:net').Server, address: Function, close: Function}>}
 *   `close()` 会关闭监听并在 Unix 上尽力删除 socket 文件。
 * @throws {IpcError} 端点已被活跃 broker 占用时抛出 `EADDRINUSE`。
 * @throws {Error} 监听失败时抛出底层错误（如权限不足、端口占用）。
 */
export async function createIpcServer(ipcName, { onConnection, onError } = {}) {
  const endpoint = parseEndpoint(ipcName);
  if (!endpoint.tcp && process.platform !== 'win32' && ipcName) {
    const directory = path.dirname(ipcName);
    try {
      fs.mkdirSync(directory, { recursive: true });
    } catch {
      /* 交给 listen 报出真实错误 */
    }
    if (fs.existsSync(ipcName)) {
      // 存活的 broker 拥有该 socket；只有确认陈旧时才 unlink。
      if (await ipcIsAlive(ipcName, { timeoutMs: 300 })) {
        throw new IpcError('EADDRINUSE', `another broker is already listening on ${ipcName}`);
      }
      try {
        fs.unlinkSync(ipcName);
      } catch {
        /* 交给 listen 报出真实错误 */
      }
    }
  }

  let sequence = 0;
  const server = net.createServer((socket) => {
    const channel = new LineChannel(socket, { label: 'client' });
    // clientId 由 broker 递增分配，用于日志、限流与任务归属统计。
    channel.clientId = `c-${++sequence}`;
    try {
      onConnection?.(channel);
    } catch (error) {
      // 回调抛错说明无法正常接管该连接，直接关闭，避免裸奔。
      channel.destroy(error);
    }
  });
  server.on('error', (error) => onError?.(error));

  // 等待监听就绪：临时监听一次 error 用于 reject，成功后立刻摘除，
  // 之后的运行时错误只走 onError，不会被误当作启动失败。
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
        // Unix socket 文件不会随 server.close 自动消失，需要显式删除。
        // 删除失败不影响关闭结果（尽力而为）。
        if (!endpoint.tcp && process.platform !== 'win32') {
          try {
            fs.rmSync(ipcName, { force: true });
          } catch {
            /* 尽力而为 */
          }
        }
      }),
  };
}
