/**
 * 按 page target 维护的 WebMCP 会话注册表。
 *
 * 每个 page target 需要在一条独立的 CDP session 上启用 WebMCP：Chrome 在
 * `WebMCP.enable` 之后先回放页面已注册的工具，随后再以增量事件汇报变更。
 * 本模块对这些过程做封装：
 *  - 每个 target 只 attach + enable 一次（并发请求共享同一个 Promise）；
 *  - 依据事件持续维护 target -> 工具表的映射；
 *  - 通过 `invocationId` 精确匹配 `toolResponded`，避免轮询 CDP 通道。
 *
 * 使用方：`broker.mjs` 与 MCP 工具层（`listTools` / `invoke` / `dropTarget` /
 * `stats`）。
 *
 * 关键不变量：
 *  - `sessions`（targetId -> session）与 `bySession`（sessionId -> targetId）
 *    必须同步增删，否则事件路由会指向已失效的会话；
 *  - 同一个 target 的并发 `ensure()` 只会产生一次 attach，多出来的调用等待
 *    同一个 Promise；
 *  - 每个 waiter 都必须被 settle：响应、超时、target 关闭、CDP 断开四条路径
 *    都会清理表项，绝不留下悬挂的 invoke；
 *  - enable/refresh 期间到达的 `toolsAdded` 事件不会丢，它们由 settle 监听器
 *    及时唤醒，用于判断回放是否结束。
 */
import { INVOKE_WAIT_MS, MAX_TOOL_WAIT_MS, TOOL_SETTLE_MS } from './config.mjs';
import { CdpError } from './cdp.mjs';

/**
 * 把调用方传入的等待时间夹到合法区间 `[50, MAX_TOOL_WAIT_MS]`。
 *
 * 非法值（NaN、0、负数）使用 fallback；结果取整，保证传给 setTimeout 的是
 * 整数毫秒，避免平台差异。
 *
 * @param {*} value 原始等待时间（可能来自 MCP 工具入参）。
 * @param {number} fallback 缺省值（settle 窗口或 invoke 默认等待）。
 * @returns {number} 夹取后的整数毫秒。
 */
const clampWait = (value, fallback) => {
  const n = Number(value);
  const chosen = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.min(Math.max(Math.floor(chosen), 50), MAX_TOOL_WAIT_MS);
};

/**
 * 把 attach 阶段的原始 CDP 错误映射为更明确的“target 不存在”。
 *
 * target 在 attach 之前被关闭是最常见的失败；上游需要据此返回 `TARGET_NOT_FOUND`
 * 而不是笼统的 CDP 错误，便于调用方区分“页面已关”和“浏览器不可用”。
 *
 * @param {string} targetId 目标 id。
 * @param {*} error 原始错误。
 * @returns {*} 映射后的错误（非 CdpError 或消息不匹配时原样返回）。
 */
const mapAttachError = (targetId, error) => {
  if (error instanceof CdpError) {
    if (/no target|not found|target.*closed/i.test(error.message)) {
      return new CdpError('TARGET_NOT_FOUND', `page target ${targetId} is not available`, { targetId });
    }
  }
  return error;
};

/**
 * 每个 page target 的 WebMCP 会话与工具注册表。
 */
export class SessionBook {
  /**
   * @param {{cdp: import('./cdp.mjs').ChromeCdp, log?: Function, settleMs?: number, invokeWaitMs?: number}} options
   *   `cdp` 为共享连接；`settleMs` 为默认回放静默窗口；`invokeWaitMs` 为默认
   *   工具调用等待上限。
   */
  constructor({ cdp, log = () => {}, settleMs = TOOL_SETTLE_MS, invokeWaitMs = INVOKE_WAIT_MS }) {
    this.cdp = cdp;
    this.log = log;
    this.settleMs = settleMs;
    this.invokeWaitMs = invokeWaitMs;
    this.sessions = new Map(); // targetId -> session
    this.bySession = new Map(); // sessionId -> targetId
    this.ensuring = new Map(); // targetId -> promise（attach 单飞）
    this.waiters = new Map(); // invocationId -> waiter（等待 toolResponded）
    this.recent = new Map(); // invocationId -> {params, at}，用于“结果早于 ack”的竞态
    this.invocations = new Map(); // invocationId -> 诊断信息
    cdp.onEvent((message) => this.#onEvent(message));
  }

  /**
   * 读取已缓存的会话（不触发 attach）。
   *
   * @param {string} targetId 目标 id。
   * @returns {object|undefined} 会话对象。
   */
  #session(targetId) {
    return this.sessions.get(targetId);
  }

  /**
   * 确保某个 target 已 attach 并启用 WebMCP。
   *
   * 分支优先级：已有启用会话直接返回；正在 enable 则等待；`refresh` 复用已有
   * 会话重新 enable（不重新 attach）；否则走 attach 单飞流程。单飞用
   * `ensuring` 表实现，且用 `finally` 保证无论成功失败都移除表项，避免失败后
   * 永久卡住后续请求。
   *
   * @param {string} targetId 目标 page target id。
   * @param {{waitMs?: number, refresh?: boolean}} [options] `waitMs` 为 settle
   *   窗口（会被夹取）；`refresh` 为 true 时对已有会话重新 enable。
   * @returns {Promise<object>} 就绪的会话对象。
   * @throws {CdpError} `TARGET_NOT_FOUND`（attach 时页面已关闭）、`CDP_TIMEOUT`、
   *   `CHROME_DISCONNECTED`，或 WebMCP.enable 返回的错误。
   */
  async ensure(targetId, { waitMs = this.settleMs, refresh = false } = {}) {
    const wait = clampWait(waitMs, this.settleMs);
    let session = this.sessions.get(targetId);
    if (session && !refresh && session.enabled) return session;
    if (session && !refresh && session.enabling) {
      // 已有 enable 在进行中：等它完成即可，不要重复 attach/enable。
      await session.enabling;
      return session;
    }
    if (session && refresh) {
      // 刷新只重新 enable，保留已缓存的工具表与事件监听器。
      await this.refresh(session, wait);
      return session;
    }
    const existing = this.ensuring.get(targetId);
    if (existing) return existing;
    const promise = (async () => {
      const attached = await this.cdp
        .send('Target.attachToTarget', { targetId, flatten: true }, undefined, { timeoutMs: 15000 })
        .catch((error) => {
          // attach 失败通常意味着 target 在探测与 attach 之间被关闭。
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
        // 串行化 refresh：并发 refresh 会排在同一条链上，避免 enable 互相打断。
        refreshChain: Promise.resolve(),
        enableCount: 0,
      };
      // 两张表必须同步写入，否则后续事件无法按 sessionId 路由回 target。
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

  /**
   * 在会话上执行 `WebMCP.enable`，并等待工具回放结束。
   *
   * 顺序很关键：先挂上 settle 监听器，再发 enable 命令——因为 Chrome 可能在
   * 命令返回之前就开始回放工具事件，晚挂监听器会漏掉“回放已开始”的信号。
   *
   * 并发调用共享 `session.enabling`（单飞）；enable 失败时直接丢弃会话，
   * 让下次调用重新 attach，避免留下半初始化状态。
   *
   * @param {object} session 会话对象。
   * @param {number} waitMs settle 的最长等待。
   * @returns {Promise<void>} 回放结束（或窗口耗尽）后完成。
   */
  async #enable(session, waitMs) {
    if (session.enabling) return session.enabling;
    session.enabling = (async () => {
      const settled = this.#settle(session, waitMs);
      try {
        await this.cdp.send('WebMCP.enable', {}, session.sessionId, { timeoutMs: 15000 });
        session.enableCount += 1;
      } catch (error) {
        // enable 失败说明该 session 已不可用，清掉注册表，让上层重试时重新 attach。
        this.#dropSession(session);
        throw error;
      }
      await settled;
      session.enabled = true;
    })();
    try {
      await session.enabling;
    } finally {
      // 无论成功失败都释放 enabling，避免后续 ensure 永远等待一个已结束的 Promise。
      session.enabling = null;
    }
  }

  /**
   * 对已有会话重新启用 WebMCP（不重新 attach）。
   *
   * 多次 refresh 按 `refreshChain` 串行执行；链上某次失败不会阻断后续 refresh
   * （前面的 `.catch(() => {})` 把异常吞掉，仅影响该次调用者的 Promise）。
   *
   * @param {object} session 会话对象。
   * @param {number} [waitMs=this.settleMs] settle 窗口。
   * @returns {Promise<void>} 本次 refresh 完成时结束。
   */
  async refresh(session, waitMs = this.settleMs) {
    session.refreshChain = session.refreshChain
      .catch(() => {})
      .then(() => this.#enable(session, waitMs));
    return session.refreshChain;
  }

  /**
   * 等待 Chrome 停止回放工具变更。
   *
   * 三种结束条件，先到者生效：
   *  - 已收到事件后静默 120 毫秒（页面确实有工具，回放已收敛）；
   *  - 起始后 450 毫秒仍无任何事件（页面没有工具，不必等满整个预算）；
   *  - 到达 `waitMs` 硬上限（防止持续变更的页面无限拖住发现流程）。
   *
   * 因此每次发现都不是固定 sleep，而是自适应窗口。计时器全部 unref，且
   * `finish` 负责移除监听器，避免会话上残留闭包。
   *
   * @param {object} session 会话对象。
   * @param {number} waitMs 硬上限毫秒数。
   * @returns {Promise<void>} 判定回放结束后完成。
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
        // 每来一条工具事件就重置静默计时器：只要还在回放，就不算结束。
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, 120);
        quietTimer.unref?.();
      };
      session.listeners.add(onEvent);
      hardTimer = setTimeout(finish, waitMs);
      hardTimer.unref?.();
      // 完全没有任何回放，说明页面本来就没有工具：不要每次都等满预算。
      quietTimer = setTimeout(finish, Math.min(waitMs, 450));
      quietTimer.unref?.();
    });
  }

  /**
   * 列出某个 target 上当前的 WebMCP 工具。
   *
   * 返回结构对缺失字段做了兜底（`inputSchema` 默认为空对象 schema），
   * 便于上层直接序列化给 MCP 客户端。
   *
   * @param {string} targetId 目标 id。
   * @param {{waitMs?: number, refresh?: boolean, clientId?: string}} [options]
   *   `refresh` 为 true 时先重新 enable；`clientId` 预留给调度归属。
   * @returns {Promise<Array<{name: string, description: string, inputSchema: object, frameId: string}>>} 工具描述数组。
   */
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
   * 调用一个工具，并以它的 `toolResponded` 载荷 resolve。
   *
   * 关键时序：waiter 必须在发送 `WebMCP.invokeTool` **之前**装上，但
   * `invocationId` 只有命令返回后才可知。因此存在两种交错：
   *  - 正常情况：先拿到 invocationId 再装 waiter，等待事件；
   *  - 结果早于 ack：事件先到，`#onEvent` 先把它停放在 `recent`，随后这里
   *    立即消费并返回，不再注册 waiter。
   *
   * 未指定 frameId 时回退到工具自身记录的 frameId；两者都没有则说明工具
   * 未注册，抛 `TOOL_NOT_FOUND` 并在 data 里附上可用工具名。
   *
   * @param {string} targetId 目标 page target id。
   * @param {{frameId?: string, toolName: string, input?: object, waitMs?: number, clientId?: string}} params
   *   `toolName` 必填；`input` 缺省为 `{}`；`waitMs` 会被夹取到
   *   `[50, MAX_TOOL_WAIT_MS]`；`clientId` 用于 CDP 调度归属。
   * @returns {Promise<{status: string, output: *, invocationId: string, durationMs: number}>}
   *   `status` 缺省为 `Completed`，`output` 缺省为 null。
   * @throws {CdpError} `TOOL_NOT_FOUND`（工具未注册）、`INTERNAL`（未返回
   *   invocationId）、`TOOL_TIMEOUT`（wait 内无响应）、`TARGET_GONE`
   *   （等待期间 target 被关闭）、`CHROME_DISCONNECTED`（等待期间 CDP 断开）。
   */
  async invoke(targetId, { frameId, toolName, input, waitMs, clientId } = {}) {
    const wait = clampWait(waitMs, this.invokeWaitMs);
    // 调用前只给一个较短的 settle 预算：工具回放通常已经完成，没必要等满。
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
    // 发送阶段只占 wait 与 15 秒中的较小值，剩下时间留给等待响应事件。
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
    // 记录诊断信息，方便 stats/排障关联 invocation 与 target、工具。
    this.invocations.set(invocationId, { targetId, sessionId: session.sessionId, toolName, startedAt });
    // 兜底清理：即使调用方忘记 settle，5 分钟后也不会让诊断表无限增长。
    const forgetTimer = setTimeout(() => this.invocations.delete(invocationId), 300000);
    forgetTimer.unref?.();

    // 竞态分支：响应事件比 invokeTool 的 ack 更早到达，已被停放在 recent。
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
        // 超时必须先摘除 waiter 与诊断，否则迟到的事件会 resolve 一个已拒绝的 Promise。
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

  /**
   * 在 invocation 已正常结束时清理诊断信息。
   *
   * 只有开始超过 5 分钟的条目才会被删除；刚创建的条目交给兜底计时器处理，
   * 以免刚结束的调用信息立刻消失、影响紧接着的排障。
   *
   * @param {string} invocationId 调用 id。
   */
  #forgetInvocation(invocationId) {
    const invocation = this.invocations.get(invocationId);
    if (!invocation) return;
    if (Date.now() - invocation.startedAt > 300000) this.invocations.delete(invocationId);
  }

  /**
   * 丢弃一个会话，并让属于它的所有 waiter 立即失败。
   *
   * 两张索引表与 `ensuring` 单飞表都要一并清理；waiter 以 `TARGET_GONE`
   * 拒绝，避免调用方一直等到超时才发现页面早被关掉。
   *
   * @param {object|undefined} session 待丢弃的会话。
   */
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

  /**
   * 按 targetId 丢弃会话。
   *
   * 没有缓存会话时（例如 attach 还没完成就收到 targetDestroyed），仍然要
   * 清理该 target 上已登记的 waiter，因此下面有第二条遍历分支。
   *
   * @param {string} targetId 目标 id。
   */
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

  /**
   * CDP 事件路由。
   *
   * 顺序上有意先处理“连接级/会话级”事件，再按 `sessionId` 反查 target 处理
   * 工具事件：
   *  - `__cdpClose`（cdp 模块合成的关闭事件）：所有 waiter 以
   *    `CHROME_DISCONNECTED` 失败并清空全部注册表，之后交给重连后的新一轮会话；
   *  - `Target.targetDestroyed` / `Inspector.detached`：页面关闭或 session 分离；
   *  - `WebMCP.toolResponded`：有 waiter 就 settle，没有就停放到 `recent`
   *    等待 invoke 的 ack 到达（60 秒后自动丢弃）；
   *  - `WebMCP.toolsAdded` / `WebMCP.toolsRemoved`：更新工具表并唤醒 settle
   *    监听器，让回放窗口及时收敛。
   *
   * @param {{method: string, params?: object, sessionId?: string}} message CDP 事件。
   */
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
        // 响应早于 ack 的竞态：先停放，等 invoke() 拿到 invocationId 后立即取用。
        this.recent.set(invocationId, { params: message.params, at: Date.now() });
        const timer = setTimeout(() => this.recent.delete(invocationId), 60000);
        timer.unref?.();
      }
      return;
    }
    // 其余事件都带 sessionId，必须能反查到 target 才有意义（浏览器级事件会在这里被忽略）。
    const targetId = this.bySession.get(message.sessionId);
    if (!targetId) return;
    const session = this.sessions.get(targetId);
    if (!session) return;

    if (message.method === 'WebMCP.toolsAdded') {
      for (const tool of message.params?.tools || []) {
        // 同名工具覆盖旧条目：以页面最后一次注册为准。
        if (tool?.name) session.tools.set(tool.name, tool);
      }
      session.lastEventAt = Date.now();
      // 逐个唤醒 settle 监听器，重置静默计时器。
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

  /**
   * 运行指标快照，用于日志与健康检查。
   *
   * @returns {{sessions: number, waiters: number, recent: number}} 当前会话数、
   *   等待中的调用数、停放待匹配的响应数。
   */
  stats() {
    return {
      sessions: this.sessions.size,
      waiters: this.waiters.size,
      recent: this.recent.size,
    };
  }
}
