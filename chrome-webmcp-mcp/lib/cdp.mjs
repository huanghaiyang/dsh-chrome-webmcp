/**
 * broker 所有客户端共享的一条 Chrome DevTools Protocol 连接。
 *
 * 职责：
 *  - 惰性连接到 `ws://127.0.0.1:<port>/devtools/browser/<id>`，断线后按需重连；
 *  - 以公平且有界的在途调度器按 id 复用（多路复用）CDP 命令，保证单个任务
 *    无法独占整条通道；
 *  - 把协议事件扇出给 session 注册表（`lib/sessions.mjs`）。
 *
 * 使用方：`lib/sessions.mjs`（`send` 与 `onEvent`）、`broker.mjs`（生命周期、
 * 关闭与日志）。
 *
 * 关键不变量：
 *  - 同一时刻最多只有一次连接尝试（`connecting` 单飞），避免并发建链；
 *  - 每条在途命令都恰好被 settle 一次：响应、超时、连接关闭三者互斥；
 *  - 调度槽位必须归还：无论命令成功、失败还是取消，`release()` 都在
 *    `finally` 中执行，否则并发额度会被永久泄漏；
 *  - 事件监听器抛错只记日志，绝不向外传播，避免一个观察者拖垮整条连接。
 */
import { CDP_TIMEOUT_MS, CLIENT_MAX_INFLIGHT, MAX_INFLIGHT } from './config.mjs';

/**
 * CDP 层错误，携带稳定的机器可读错误码。
 *
 * 常见错误码：`CHROME_UNREACHABLE`（找不到/连不上 DevTools 端点）、
 * `CHROME_DISCONNECTED`（连接已断开或发送失败）、`CDP_TIMEOUT`（等待调度
 * 槽位、建链或命令本身超时）、`CDP_ERROR`（浏览器返回协议错误）。
 */
export class CdpError extends Error {
  /**
   * @param {string} code 机器可读错误码。
   * @param {string} message 人类可读的错误描述。
   * @param {*} [data] 附加诊断数据（例如原始协议错误）。
   */
  constructor(code, message, data) {
    super(message);
    this.name = 'CdpError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/**
 * 有界 FIFO 调度器，并为每个客户端设置独立的在途上限。
 *
 * 一个客户端连续入队一批命令时，最多只允许 `perClient` 条同时在途，
 * 因此排在它后面的其他客户端仍能拿到槽位并送达浏览器，而不必等整批命令
 * 跑完。这正是桥接器需要的公平性：任何单个任务都不能独占通道。
 *
 * 选择策略是按 FIFO 顺序扫描队列，取第一条“所属客户端未达上限”的条目，
 * 因此不同客户端之间自然交错，同一客户端内部仍保持先后顺序。
 *
 * @private
 */
class FairScheduler {
  /**
   * @param {{max?: number, perClient?: number}} [options] `max` 为全局在途
   *   上限，`perClient` 为单客户端在途上限。
   */
  constructor({ max = MAX_INFLIGHT, perClient = CLIENT_MAX_INFLIGHT } = {}) {
    this.max = max;
    this.perClient = perClient;
    /** 全局当前在途数。 */
    this.active = 0;
    /** clientId -> 该客户端当前在途数；降到 0 时删除以免 Map 无限膨胀。 */
    this.clientActive = new Map();
    /** 等待槽位的条目队列（FIFO）。 */
    this.queue = [];
    /** 重入保护：`#pump` 内部归还槽位时会再次调用 `#pump`。 */
    this.pumping = false;
  }

  /**
   * 申请一个调度槽位。
   *
   * 返回的票据是 {promise, cancelled, cancel}：`promise` 在拿到槽位时兑现
   * `release` 函数；`cancel()` 用于超时路径，若槽位已授予则立即归还，
   * 若仍在排队则标记为取消（稍后由 `#pump` 清理）。
   *
   * @param {string} [clientId] 客户端标识；缺省时归入 `__internal__` 桶。
   * @returns {{promise: Promise<Function>, readonly cancelled: boolean, cancel: Function}} 调度票据。
   */
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
        // 已授予槽位时必须立刻归还，否则等待超时后额度会被泄漏；
        // 未授予的条目等 #pump 下一轮统一剔除即可。
        if (entry.granted && entry.release) entry.release();
      },
    };
  }

  /**
   * 尝试把队列中的条目提升为“在途”，直到全局上限或无可调度条目。
   *
   * 用 `pumping` 做重入保护：`release()` 会在同一个调用栈里再次触发 `#pump`，
   * 外层循环会把新腾出的槽位一并填满，无需嵌套执行。
   */
  #pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      // 从未被授予槽位的取消条目已无意义，先整体剔除，避免队列被超时请求撑大。
      if (this.queue.some((entry) => entry.cancelled)) {
        this.queue = this.queue.filter((entry) => !entry.cancelled);
      }
      while (this.active < this.max) {
        let index = -1;
        // 线性扫描找到第一条可调度的条目：全局有空位，且它所属客户端
        // 未达到 perClient 上限（这是公平性的核心，而不是简单取队首）。
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
          // 幂等：重复 release（例如 cancel 与 finally 都触发）只生效一次。
          if (!entry.granted) return;
          entry.granted = false;
          this.active -= 1;
          const next = (this.clientActive.get(entry.clientId) || 1) - 1;
          if (next <= 0) this.clientActive.delete(entry.clientId);
          else this.clientActive.set(entry.clientId, next);
          // 归还槽位后立即补位，让排队者尽快发车。
          this.#pump();
        };
        entry.resolve(entry.release);
      }
    } finally {
      this.pumping = false;
    }
  }
}

/**
 * 一条共享的 CDP 连接：建链、命令多路复用、事件扇出与断开清理。
 */
export class ChromeCdp {
  /**
   * @param {{port?: number, endpoint?: string, log?: Function}} [options]
   *   `port` 为调试端口；`endpoint` 为 HTTP 基地址（用于 `/json/version`）；
   *   `log` 为日志函数，默认丢弃。
   */
  constructor({ port, endpoint, log = () => {} } = {}) {
    this.port = port;
    this.endpoint = endpoint;
    this.log = log;
    this.nextId = 0;
    /** id -> {resolve, reject}；连接关闭时全部拒绝。 */
    this.pending = new Map();
    /** 事件监听器集合；任一监听器抛错不影响其他监听器。 */
    this.listeners = new Set();
    this.ws = null;
    /** 进行中的建链 Promise（单飞，防止并发重连）。 */
    this.connecting = null;
    this.closed = false;
    /** `/json/version` 结果缓存，避免每条命令都打一次 HTTP。 */
    this.versionCache = null;
    this.versionCachedAt = 0;
    this.scheduler = new FairScheduler();
    this.connectedAt = 0;
  }

  /**
   * 探测 `/json/version`，带短时缓存；Chrome 不可用时返回 null。
   *
   * 缓存命中直接返回，避免高频命令反复发起 HTTP 请求。失败时不缓存“空结果”，
   * 而是把缓存时间戳前移，使得 500 毫秒后即可重试——这样既不会每条命令都
   * 重试，又能在 Chrome 刚启动时较快恢复。
   *
   * @param {{timeoutMs?: number, cacheMs?: number}} [options] `timeoutMs` 为
   *   单次 HTTP 超时（默认 2000 毫秒），`cacheMs` 为缓存有效期（默认 2000 毫秒）。
   * @returns {Promise<object|null>} 含 `webSocketDebuggerUrl` 的版本信息，失败为 null。
   */
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
      this.versionCachedAt = now - cacheMs + 500; // 尽快重试，但不要每条命令都重试
      return null;
    }
  }

  /**
   * 注册 CDP 事件监听器。
   *
   * @param {(message: {method: string, params: object, sessionId?: string}) => void} listener 事件回调。
   * @returns {Function} 取消注册的函数。
   */
  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 确保连接可用；必要时建立新连接。
   *
   * 单飞语义：已有可用 socket 直接返回；若已有建链在进行中，则复用同一个
   * Promise，避免并发建链产生多条 WebSocket（那会导致事件重复、id 冲突）。
   *
   * @returns {Promise<void>} 连接就绪后完成。
   * @throws {CdpError} `CHROME_UNREACHABLE` / `CDP_TIMEOUT`，见 `#connect`。
   */
  async ensure() {
    if (this.ws && this.ws.readyState === 1 && !this.closed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.#connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /**
   * 实际建立 WebSocket 连接。
   *
   * 先清掉 `closed` 标记（允许断线后重连），再以 `cacheMs: 0` 强刷
   * `/json/version`，确保拿到的是当前浏览器的真实调试地址。
   *
   * @returns {Promise<void>}
   * @throws {CdpError} `CHROME_UNREACHABLE`（无 DevTools 端点或 WebSocket 建链失败）、
   *   `CDP_TIMEOUT`（8 秒内未完成握手）。
   */
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
    // 握手阶段用一次性 race：open / error / 超时三选一，先到者胜出；
    // 超时分支会主动关闭 socket，避免留下半开连接。
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          socket.close();
        } catch {
          /* 忽略 */
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

    // 在协议支持发现能力时维护 target 生命周期事件。
    // 失败无副作用（旧版本或没有该 domain 的假实现都会失败）。这里必须用
    // 原始发送：此刻 ensure() 仍在等待本次连接 Promise，走 send() 会自锁。
    this.#rawSend('Target.setDiscoverTargets', { discover: true }, undefined, 5000).catch(() => {});
  }

  /**
   * 经公平调度器发送一条 CDP 命令。
   *
   * 超时覆盖“排队等槽位 + 实际执行”两段。等待槽位超时时会取消票据并返回
   * `CDP_TIMEOUT`；若取消与授予发生竞态（票据已完成但已被标记 cancelled），
   * 仍需先归还槽位再抛错。执行阶段无论成功失败，都在 `finally` 中归还槽位。
   *
   * @param {string} method CDP 方法名，例如 `WebMCP.enable`。
   * @param {object} [params={}] 方法参数。
   * @param {string} [sessionId] 目标会话 id；浏览器级命令省略。
   * @param {{clientId?: string, timeoutMs?: number}} [options] `clientId` 用于
   *   公平调度归属（同一次任务应传相同值）；`timeoutMs` 默认取 `CDP_TIMEOUT_MS`。
   * @returns {Promise<object>} CDP 命令的 `result`（缺省为空对象）。
   * @throws {CdpError} `CDP_TIMEOUT`（等槽位或执行超时）、`CHROME_DISCONNECTED`
   *   （连接不可用/发送失败）、`CDP_ERROR`（浏览器返回错误）。
   */
  async send(method, params = {}, sessionId, { clientId, timeoutMs = CDP_TIMEOUT_MS } = {}) {
    await this.ensure();
    const ticket = this.scheduler.enqueue(clientId);
    let timedOut = false;
    let rejectTimeout;
    // 独立的“等槽位超时”Promise，与票据 Promise 竞速：谁先完成就用谁的结果。
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
    // 竞态兜底：超时与授予可能同时发生，此时票据虽已兑现也必须归还槽位。
    if (timedOut || ticket.cancelled) {
      release();
      throw new CdpError('CDP_TIMEOUT', `CDP ${method} was cancelled after ${timeoutMs} ms`);
    }
    try {
      return await this.#rawSend(method, params, sessionId, timeoutMs);
    } finally {
      // 槽位只在这里归还，保证异常路径也不会泄漏并发额度。
      release();
    }
  }

  /**
   * 直接发送命令，不经过调度器、也不自动调用 `ensure()`。
   *
   * 仅用于建链过程中的内部命令（如 `Target.setDiscoverTargets`），以及
   * `send()` 在已确保连接后的实际写入。响应、超时、发送失败三条路径都
   * 保证从 `pending` 中摘除表项。
   *
   * @param {string} method CDP 方法名。
   * @param {object} params 方法参数。
   * @param {string|undefined} sessionId 目标会话 id。
   * @param {number} timeoutMs 命令执行超时。
   * @returns {Promise<object>} 命令结果。
   * @throws {CdpError} `CHROME_DISCONNECTED`、`CDP_TIMEOUT`、`CDP_ERROR`。
   */
  #rawSend(method, params, sessionId, timeoutMs) {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new CdpError('CHROME_DISCONNECTED', 'CDP connection is not open'));
    }
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // 若表项已被响应摘除，说明这条命令其实已成功，忽略这次超时。
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
        // 发送失败时表项已存在，必须撤销并清计时器，否则会悬挂。
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new CdpError('CHROME_DISCONNECTED', `failed to send CDP ${method}: ${error.message}`));
      }
    });
  }

  /**
   * 处理来自 WebSocket 的帧：区分响应与事件。
   *
   * 判定规则为“有 id 且无 method”即响应；带 `method` 的则视为事件，扇出给
   * 所有监听器（监听器异常只记日志）。无法解析的帧直接丢弃。
   *
   * @param {MessageEvent} event WebSocket 消息事件。
   */
  #onMessage(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
    } catch {
      // 无法解析的帧（例如二进制调试输出）与协议无关，丢弃即可。
      return;
    }
    if (typeof message.id !== 'undefined' && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new CdpError(
            // 保留原始分支形式：两种 CDP 错误目前都映射为 CDP_ERROR，
            // 但显式区分便于将来细化错误码。
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
          // 单个监听器失败不能影响其他监听器，更不能破坏连接。
          this.log('[cdp] event listener failed', error?.message || String(error));
        }
      }
    }
  }

  /**
   * WebSocket 关闭后的清理。
   *
   * 所有在途命令以 `CHROME_DISCONNECTED` 拒绝（它们不可能再收到响应），
   * 清空版本缓存以便重连时重新探测，并向监听器发送合成的 `__cdpClose`
   * 事件，让上层（session 注册表）同步作废所有会话与等待者。
   */
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
        // 合成事件：上层据此区分“浏览器断开”与普通 target 事件。
        listener({ method: '__cdpClose', params: {} });
      } catch {
        /* 忽略 */
      }
    }
  }

  /**
   * 主动关闭连接（例如 broker 退出时）。
   *
   * 只关闭 socket；在途命令会由 `#onClose` 统一拒绝。
   *
   * @returns {Promise<void>}
   */
  async close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* 忽略 */
    }
    this.ws = null;
  }
}
