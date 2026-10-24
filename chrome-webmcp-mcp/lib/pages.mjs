/**
 * 面向"感知 -> 思考 -> 动作"浏览器循环的页面自动化会话（Browser Use 层）。
 *
 * 职责：
 * - PageBook 为每个 target 维护一条独立的 CDP session，与 SessionBook 的 WebMCP
 *   session 分离：这样即使页面没有暴露 WebMCP 也能使用 browser-use 能力，同时
 *   不会干扰已有的工具注册表。
 * - 每条 session 在主 frame 上创建一个私有 isolated world（WORLD_NAME），快照文本
 *   与引用表（refs）都保存在该 world 的 globalThis.__dshBrowserUse 上，绝不污染
 *   页面自身的全局变量、DOM 属性或样式。
 * - 提供 snapshot / click / typeText / pressKey / navigate / targetFacts 等原语；
 *   动作一律通过真实 CDP Input 事件（Input.dispatchMouseEvent / dispatchKeyEvent /
 *   insertText）发出，让页面框架（React、Vue 等）像对待真人输入一样响应。
 *
 * 关键不变量：
 * - 快照索引单调递增且跨快照不复用：每张快照都会递增 revision 并重建 refs 表，
 *   因此旧索引在新快照中查不到时会明确报 REF_NOT_FOUND，而不会悄悄命中别的元素。
 * - 导航/重载会销毁执行上下文（isolated world）：页面一旦跳转，缓存的 contextId
 *   立即失效，必须清空并重新创建；对调用方表现为 PAGE_CONTEXT_LOST，需要重新拍快照。
 * - 同一个 target 的 attach 是"单飞"的：并发调用共享同一个 promise，避免创建多条
 *   session 或重复建 world。
 * - 一个 target 只对应一条 session、且 sessionId 与 targetId 双向可查；target 被
 *   销毁或 session 被 detach 时必须同时清理三张表（sessions / bySession / ensuring）。
 * - 所有动作都基于"最近一次快照"的引用表；页面重排、元素被移除或遮挡时动作应显式
 *   失败（REF_STALE / ELEMENT_NOT_VISIBLE / ELEMENT_COVERED），不做静默降级。
 */
import { CdpError } from './cdp.mjs';
import {
  ACTION_SETTLE_MS,
  CDP_TIMEOUT_MS,
  MAX_TOOL_WAIT_MS,
  NAVIGATE_WAIT_MS,
  sleep,
} from './config.mjs';
import {
  clickExpression,
  readyExpression,
  snapshotExpression,
  typeExpression,
} from './page-scripts.mjs';

/** attachToTarget / getFrameTree / createIsolatedWorld 的超时：冷启动时 Chrome 可能较慢。 */
const ATTACH_TIMEOUT_MS = 15000;
/** 单次 Runtime.evaluate 的超时；页面脚本可能包含等待帧的逻辑。 */
const PAGE_EVAL_TIMEOUT_MS = 15000;
/** isolated world 名称：同一 frame 上该名称的 world 是唯一的，便于调试与复用。 */
const WORLD_NAME = 'dsh-browser-use';
/** 导航后轮询 readyState 的间隔。 */
const READY_POLL_MS = 120;
/** 读取 target 事实（url/title）的超时；这是尽力而为的信息，不宜拖慢主流程。 */
const FACT_TIMEOUT_MS = 5000;

/**
 * 修饰键到 CDP modifiers 位掩码的映射（CDP 使用 1=Alt, 2=Ctrl, 4=Meta, 8=Shift）。
 * 同时接受常见别名（control/cmd/command），便于模型输出 "Cmd+A" 之类的写法。
 */
const MODIFIER_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

/**
 * 具名键表：把人类可读键名翻译成 CDP dispatchKeyEvent 需要的
 * key / code / windowsVirtualKeyCode，必要时附带可直接插入的 text。
 * 只有这里列出的键以及单个 ASCII 字母/数字会被 parseKey 接受。
 */
const NAMED_KEYS = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
};

/**
 * 把 "Control+A" / "Enter" / "x" 这类组合键解析为 CDP dispatchKeyEvent 的参数。
 *
 * 解析规则：
 * - 以 '+' 分隔，最后一段是主键，前面的都是修饰键（顺序无关）。
 * - 主键先查 NAMED_KEYS 具名表；否则必须是单个 ASCII 字母或数字，code 分别为
 *   Key<字母> / Digit<数字>，虚拟键码取大写字符的 ASCII 码。
 * - text 只在"没有 Alt/Ctrl/Meta"时才生成（带修饰键时浏览器不会产生字符输入）；
 *   Shift 只影响大小写。
 *
 * @param {string} raw 用户/模型给出的键名或组合键。
 * @returns {{key: string, code: string, vk: number, text?: string, modifiers: number, names: string[]}|null}
 *   解析结果；无法识别时返回 null（调用方据此抛 INVALID_PARAMS，而不是猜测）。
 */
export function parseKey(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.split('+').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;
  const keyName = parts.pop();
  let modifiers = 0;
  const names = [];
  for (const part of parts) {
    const bits = MODIFIER_BITS[part.toLowerCase()];
    if (!bits) return null;
    modifiers |= bits;
    names.push(
      bits === 1 ? 'Alt' : bits === 2 ? 'Control' : bits === 4 ? 'Meta' : 'Shift',
    );
  }
  const named = NAMED_KEYS[keyName.toLowerCase()];
  if (named) return { ...named, modifiers, names };
  if (keyName.length !== 1) return null;
  const upper = keyName.toUpperCase();
  let code;
  if (/^[A-Z]$/.test(upper)) code = `Key${upper}`;
  else if (/^[0-9]$/.test(upper)) code = `Digit${upper}`;
  else return null;
  const vk = upper.charCodeAt(0);
  const shifted = (modifiers & 8) !== 0;
  let text;
  if (!(modifiers & 1 || modifiers & 2 || modifiers & 4)) {
    text = shifted ? upper : keyName.toLowerCase();
  }
  return { key: shifted ? upper : keyName.toLowerCase(), code, vk, text, modifiers, names };
}

/**
 * 把 attach 阶段的底层错误归一化为 TARGET_NOT_FOUND。
 *
 * 只有"target 不存在/已关闭"这类错误才改码；其它错误（权限、超时等）原样抛出，
 * 以免把可诊断的失败伪装成"页面不存在"。
 *
 * @param {string} targetId 目标页面 targetId。
 * @param {Error} error 原始错误。
 * @returns {Error} CdpError(TARGET_NOT_FOUND) 或原始错误。
 */
function mapAttachError(targetId, error) {
  if (
    error instanceof CdpError &&
    /no target|not found|target closed|session closed/i.test(error.message)
  ) {
    return new CdpError('TARGET_NOT_FOUND', `page ${targetId} is no longer available`, {
      targetId,
    });
  }
  return error;
}

/**
 * 判断错误是否源于执行上下文失效（导航、frame 重建、session detach）。
 *
 * 特意排除 PAGE_EVALUATION_FAILED：那是页面脚本自身抛错（例如语法/运行时异常），
 * 重试或重建 world 都无济于事，必须原样上抛。
 *
 * @param {Error} error 待判断的错误。
 * @returns {boolean} 是否为上下文类失效。
 */
function isContextLoss(error) {
  if (!(error instanceof CdpError)) return false;
  if (error.code === 'PAGE_EVALUATION_FAILED') return false;
  return /context|destroyed|detached|disconnected/i.test(error.message);
}

/**
 * 判断错误是否意味着整条 CDP session 已不可用（而非仅 world 失效）。
 * session 级失效需要连 session 记录一起丢弃，下次 attach 会重新建立。
 *
 * @param {Error} error 待判断的错误。
 * @returns {boolean}
 */
function isSessionLoss(error) {
  return error instanceof CdpError && /session closed|target closed|detached/i.test(error.message);
}

/**
 * 把等待参数收敛到 [0, MAX_TOOL_WAIT_MS]。
 *
 * 缺省/非法/负数一律回退到调用方给的默认值（而不是 0），避免"传错就立刻超时"；
 * 合法值向下取整并封顶，防止模型传入极大等待时间拖死请求。
 *
 * @param {number|string|undefined|null} value 原始等待毫秒数。
 * @param {number} fallback 缺省值。
 * @returns {number} 规范化后的毫秒数。
 */
function clampWait(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), MAX_TOOL_WAIT_MS);
}

/**
 * 把页面脚本返回的失败结果转换为可读的 CdpError。
 *
 * 页面脚本用 reason 字段表达失败原因（REF_NOT_FOUND、REF_STALE、
 * ELEMENT_NOT_VISIBLE、ELEMENT_COVERED、NOT_EDITABLE、OPTION_NOT_FOUND），
 * 这里负责映射为同名的错误码并生成面向模型的提示语（提示"重新拍快照"等下一步动作）。
 * 未知 reason 统一降级为 ACTION_FAILED，避免向调用方泄漏内部枚举。
 *
 * @param {object} result 页面脚本返回值 {ok:false, reason?, detail?, options?}。
 * @param {string} targetId 出错的页面 targetId（附加到 error.data）。
 * @returns {CdpError} 带 code/message/data 的错误；OPTION_NOT_FOUND 会把候选 options 一并返回。
 */
export function actionError(result, targetId) {
  const reason = typeof result?.reason === 'string' ? result.reason : 'ACTION_FAILED';
  const detail = result?.detail ? `: ${result.detail}` : '';
  const messages = {
    REF_NOT_FOUND: `the element index is not part of the latest snapshot; take a new snapshot${detail}`,
    REF_STALE: `the element is no longer in the page; take a new snapshot${detail}`,
    ELEMENT_NOT_VISIBLE: `the element is not visible or cannot be scrolled into view${detail}`,
    ELEMENT_COVERED: `another element is on top of the target${detail}`,
    NOT_EDITABLE: `the target does not accept text input${detail}`,
    OPTION_NOT_FOUND: `no option in the select matches the requested text${detail}`,
  };
  const code = messages[reason] ? reason : 'ACTION_FAILED';
  const data = { targetId };
  if (Array.isArray(result?.options)) data.options = result.options;
  return new CdpError(code, messages[reason] || `the page rejected the action${detail}`, data);
}

/**
 * 页面自动化会话簿：按 targetId 维护 CDP session 与 isolated world。
 *
 * 与 TaskBook 的分工：TaskBook 负责"哪些页面属于哪个任务"，PageBook 负责"如何
 * 真正操作某个页面"。调用方应先通过 TaskBook 做归属校验，再拿 targetId 来这里执行动作。
 */
export class PageBook {
  /**
   * @param {object} options
   * @param {object} options.cdp CDP 连接封装，提供 send() / onEvent()。
   * @param {Function} [options.log] 日志函数。
   * @param {number} [options.settleMs] 动作后的默认静置时间（默认取 ACTION_SETTLE_MS）。
   * @param {number} [options.navigateWaitMs] 导航后默认等待加载的时间（默认取 NAVIGATE_WAIT_MS）。
   */
  constructor({
    cdp,
    log = () => {},
    settleMs = ACTION_SETTLE_MS,
    navigateWaitMs = NAVIGATE_WAIT_MS,
  }) {
    this.cdp = cdp;
    this.log = log;
    this.settleMs = settleMs;
    this.navigateWaitMs = navigateWaitMs;
    this.sessions = new Map(); // targetId -> {targetId, sessionId, frameId, contextId}
    this.bySession = new Map(); // sessionId -> targetId（用于把 detach 事件反查回页面）
    this.ensuring = new Map(); // targetId -> Promise（attach 单飞锁）
    cdp.onEvent((message) => this.#onEvent(message));
  }

  /**
   * 订阅 CDP 事件，维护 session 表的生命周期。
   *
   * 连接断开时整表清空；target 销毁或 session 被 detach 时按 targetId 精确清理，
   * 保证下一次操作会重新 attach 而不是复用已失效的 sessionId。
   *
   * @param {object} message CDP 事件消息。
   * @returns {void}
   */
  #onEvent(message) {
    if (message.method === '__cdpClose') {
      this.sessions.clear();
      this.bySession.clear();
      this.ensuring.clear();
      return;
    }
    if (message.method === 'Target.targetDestroyed') {
      const targetId = message.params?.targetId;
      if (targetId) this.dropTarget(targetId);
      return;
    }
    if (message.method === 'Target.detachedFromTarget') {
      const sessionId = message.params?.sessionId;
      const targetId = sessionId && this.bySession.get(sessionId);
      if (targetId) this.dropTarget(targetId);
    }
  }

  /**
   * 彻底移除某页面的 session 记录（三张表同步清理，避免悬挂引用）。
   *
   * @param {string} targetId 页面 targetId。
   * @returns {void}
   */
  dropTarget(targetId) {
    const session = this.sessions.get(targetId);
    if (session) this.bySession.delete(session.sessionId);
    this.sessions.delete(targetId);
    this.ensuring.delete(targetId);
  }

  /**
   * 会话统计，供 status 输出使用。
   *
   * @returns {{pages: number}} 当前已 attach 的页面数量。
   */
  stats() {
    return { pages: this.sessions.size };
  }

  /**
   * 取得（必要时建立）某个页面的可用 session（含有效的 isolated world）。
   *
   * 单飞语义：同一 target 的并发调用共享同一个 attach Promise，避免并发
   * Target.attachToTarget 产生多条 session 或重复创建 isolated world。已缓存
   * contextId 的 session 直接返回；contextId 为空（导航后失效）则重新 attach。
   *
   * @param {string} targetId 页面 targetId。
   * @param {string} [clientId] CDP 客户端标识。
   * @returns {Promise<{targetId: string, sessionId: string, frameId: string, contextId: number}>}
   * @throws {CdpError} TARGET_NOT_FOUND / PAGE_NOT_READABLE 等（见 #attach）。
   */
  async #ensure(targetId, clientId) {
    const session = this.sessions.get(targetId);
    if (session?.contextId) return session;
    const pending = this.ensuring.get(targetId);
    if (pending) return pending;
    const promise = this.#attach(targetId, clientId);
    this.ensuring.set(targetId, promise);
    try {
      return await promise;
    } finally {
      // attach 结束（成功或失败）即释放单飞锁，失败时下次调用可以重试。
      this.ensuring.delete(targetId);
    }
  }

  /**
   * 为页面建立 CDP session，并在主 frame 上创建（或重建）isolated world。
   *
   * 两个阶段分开的原因：sessionId 可复用（attach 成本低），而 world 在导航后会
   * 被销毁，必须重建。因此这里先复用已有的 sessionId，再重新取 frameTree 与 world。
   *
   * @param {string} targetId 页面 targetId。
   * @param {string} [clientId] CDP 客户端标识。
   * @returns {Promise<object>} 填好 frameId / contextId 的 session 记录。
   * @throws {CdpError} TARGET_NOT_FOUND —— target 不存在或已关闭；
   *   PAGE_NOT_READABLE —— 无主 frame，或页面不可执行脚本（如被禁止注入的页面）。
   */
  async #attach(targetId, clientId) {
    let session = this.sessions.get(targetId);
    let sessionId = session?.sessionId;
    if (!sessionId) {
      const attached = await this.cdp
        .send('Target.attachToTarget', { targetId, flatten: true }, undefined, {
          clientId,
          timeoutMs: ATTACH_TIMEOUT_MS,
        })
        .catch((error) => {
          throw mapAttachError(targetId, error);
        });
      sessionId = attached.sessionId;
      this.bySession.set(sessionId, targetId);
      session = { targetId, sessionId, frameId: null, contextId: null };
      this.sessions.set(targetId, session);
    }
    try {
      const frameTree = await this.cdp.send('Page.getFrameTree', {}, sessionId, {
        clientId,
        timeoutMs: ATTACH_TIMEOUT_MS,
      });
      const frameId = frameTree?.frameTree?.frame?.id;
      // 没有主 frame 的 target（例如尚未初始化的新标签页）无法注入脚本。
      if (!frameId) {
        throw new CdpError('PAGE_NOT_READABLE', `page ${targetId} has no main frame`, {
          targetId,
        });
      }
      // 创建/复用私有 world：worldName 相同则返回已存在的 contextId，所以导航后再调用
      // 会为新文档创建新的 world。grantUniveralAccess 保持 false（CDP 历史拼写如此），
      // 即不授予跨源访问能力，脚本只能看到同源页面内容。
      const world = await this.cdp.send(
        'Page.createIsolatedWorld',
        { frameId, worldName: WORLD_NAME, grantUniveralAccess: false },
        sessionId,
        { clientId, timeoutMs: ATTACH_TIMEOUT_MS },
      );
      if (world?.executionContextId === undefined) {
        throw new CdpError('PAGE_NOT_READABLE', `page ${targetId} is not scriptable`, {
          targetId,
        });
      }
      session.frameId = frameId;
      session.contextId = world.executionContextId;
      return session;
    } catch (error) {
      // 保留已建立的 attach 供下次重试，但绝不缓存半成品 world（contextId 置空），
      // 否则后续 evaluate 会拿着无效的 contextId 反复失败。
      session.contextId = null;
      if (error instanceof CdpError) throw error;
      throw new CdpError(
        'PAGE_NOT_READABLE',
        `page ${targetId} cannot be read: ${error.message}`,
        { targetId },
      );
    }
  }

  /**
   * 在 world 被导航/重载销毁后使缓存失效，必要时连 session 一起丢弃。
   *
   * @param {string} targetId 页面 targetId。
   * @param {Error} [error] 触发失效的原始错误，用于判断是否 session 级失效。
   * @returns {void}
   */
  #invalidateContext(targetId, error) {
    const session = this.sessions.get(targetId);
    if (!session) return;
    session.contextId = null;
    if (isSessionLoss(error)) {
      this.bySession.delete(session.sessionId);
      this.sessions.delete(targetId);
    }
  }

  /**
   * 在页面的 isolated world 中执行表达式并返回其值。
   *
   * 关键行为：
   * - returnByValue: true，因此返回值必须是可结构化克隆的普通对象；
   * - awaitPromise: true，允许注入的 async IIFE（如 click 的双帧等待）；
   * - userGesture: true，使脚本内的 focus/select 等行为按用户手势对待；
   * - 两次尝试：首次失败若是上下文失效且 retry 为真，则销毁旧 world 后重建再试一次
   *   （主要用于导航后立刻轮询 readyState）；否则直接报 PAGE_CONTEXT_LOST。
   *
   * @param {string} targetId 页面 targetId。
   * @param {string} expression 在页面中求值的表达式。
   * @param {{clientId?: string, retry?: boolean}} [options] retry=true 允许一次上下文失效重试。
   * @returns {Promise<*>} 表达式的结果值（returnByValue）。
   * @throws {CdpError} PAGE_EVALUATION_FAILED —— 页面脚本自身抛错（不做重试）；
   *   PAGE_CONTEXT_LOST —— 导航/重载导致 world 失效且无法重试恢复；
   *   TARGET_NOT_FOUND / PAGE_NOT_READABLE —— attach 阶段失败。
   */
  async evaluate(targetId, expression, { clientId, retry = false } = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await this.#ensure(targetId, clientId);
      try {
        const response = await this.cdp.send(
          'Runtime.evaluate',
          {
            expression,
            contextId: session.contextId,
            returnByValue: true,
            awaitPromise: true,
            userGesture: true,
          },
          session.sessionId,
          { clientId, timeoutMs: PAGE_EVAL_TIMEOUT_MS },
        );
        if (response?.exceptionDetails) {
          // 页面脚本抛错：只取首行，避免把整段堆栈塞进模型上下文。
          const description =
            response.exceptionDetails.exception?.description ||
            response.exceptionDetails.text ||
            'page evaluation failed';
          throw new CdpError(
            'PAGE_EVALUATION_FAILED',
            String(description).split('\n')[0],
            { targetId },
          );
        }
        return response?.result?.value;
      } catch (error) {
        if (isContextLoss(error)) {
          this.#invalidateContext(targetId, error);
          // 仅在调用方允许时重试一次；第二次仍失效说明页面仍在跳转，直接报错。
          if (retry && attempt === 0) continue;
          throw new CdpError(
            'PAGE_CONTEXT_LOST',
            'the page navigated or reloaded; take a new snapshot',
            { targetId },
          );
        }
        throw error;
      }
    }
    throw new CdpError('PAGE_CONTEXT_LOST', 'the page context could not be created', {
      targetId,
    });
  }

  /**
   * 通过指定 session 发送 CDP 命令的便捷包装（自动带上 sessionId 与超时）。
   *
   * @param {object} session 会话记录。
   * @param {string} method CDP 方法名。
   * @param {object} params 方法参数。
   * @param {string} [clientId] 客户端标识。
   * @param {number} [timeoutMs] 超时毫秒数。
   * @returns {Promise<object>} CDP 响应 result。
   */
  async #send(session, method, params, clientId, timeoutMs = CDP_TIMEOUT_MS) {
    return this.cdp.send(method, params, session.sessionId, { clientId, timeoutMs });
  }

  /**
   * 拍摄页面快照：把可见、可交互的元素序列化为带索引的文本列表。
   *
   * 脚本在 isolated world 中运行并把 live 引用存入 __dshBrowserUse.refs，
   * 返回 {snapshotId, url, title, total, elements, truncated, text}。
   * 这里用 retry: true，因为页面可能正处于导航途中，重建 world 后仍可拍快照。
   *
   * @param {string} targetId 页面 targetId。
   * @param {{maxElements?: number, clientId?: string}} [options] maxElements 上限（脚本内收敛到 1~2000，默认 200）。
   * @returns {Promise<{snapshotId: number, url: string, title: string, total: number, elements: number, truncated: boolean, text: string}>}
   * @throws {CdpError} PAGE_NOT_READABLE —— 页面没有返回合法快照；
   *   PAGE_CONTEXT_LOST / PAGE_EVALUATION_FAILED —— 见 evaluate。
   */
  async snapshot(targetId, { maxElements, clientId } = {}) {
    const value = await this.evaluate(
      targetId,
      snapshotExpression({ maxElements }),
      { clientId, retry: true },
    );
    // text 是快照的契约字段；缺失说明脚本未正确执行（或返回值不可克隆）。
    if (!value || typeof value.text !== 'string') {
      throw new CdpError('PAGE_NOT_READABLE', 'the page returned no snapshot', { targetId });
    }
    return value;
  }

  /**
   * 点击快照索引对应的元素。
   *
   * 流程：先在页面内解析索引 -> 滚动到视口中心 -> 等待两帧 -> 命中测试，得到视口
   * 坐标；再通过真实 CDP 鼠标事件点击。真实事件而非 el.click()，是为了让框架的
   * 事件委托、pointerdown/up 与用户手势判定都按真人操作处理。
   *
   * @param {string} targetId 页面 targetId。
   * @param {{index: number, button?: 'left'|'right'|'middle', clickCount?: number, clientId?: string}} options
   * @returns {Promise<{index: number, tag: string, label: string, x: number, y: number, button: string, clickCount: number}>}
   * @throws {CdpError} REF_NOT_FOUND / REF_STALE / ELEMENT_NOT_VISIBLE / ELEMENT_COVERED
   *   （由 actionError 映射）；以及 evaluate/#send 透传的错误。
   */
  async click(targetId, { index, button = 'left', clickCount = 1, clientId } = {}) {
    const point = await this.evaluate(targetId, clickExpression({ index }), { clientId });
    if (!point?.ok) throw actionError(point, targetId);
    const session = await this.#ensure(targetId, clientId);
    // CDP 的 buttons 位掩码：1=左键按下，2=右键，4=中键。
    const mask = button === 'right' ? 2 : button === 'middle' ? 4 : 1;
    // 先移动鼠标，触发 pointerover/mouseover，模拟真实指针轨迹。
    await this.#send(
      session,
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 },
      clientId,
    );
    // 按 clickCount 依次按下/抬起：count 递增让浏览器识别双击（count=2）与三击。
    for (let count = 1; count <= clickCount; count += 1) {
      await this.#send(
        session,
        'Input.dispatchMouseEvent',
        {
          type: 'mousePressed',
          x: point.x,
          y: point.y,
          button,
          buttons: mask,
          clickCount: count,
        },
        clientId,
      );
      await this.#send(
        session,
        'Input.dispatchMouseEvent',
        {
          type: 'mouseReleased',
          x: point.x,
          y: point.y,
          button,
          buttons: 0,
          clickCount: count,
        },
        clientId,
      );
    }
    return {
      index,
      tag: point.tag,
      label: point.label,
      // 保留两位小数：坐标对模型可读，又不暴露浮点噪声。
      x: Math.round(point.x * 100) / 100,
      y: Math.round(point.y * 100) / 100,
      button,
      clickCount,
    };
  }

  /**
   * 向指定索引的输入框/可编辑元素输入文本。
   *
   * 页面脚本部分只负责"选中目标、清空或定位光标、处理 select"，真正输入由主进程
   * 通过 Input.insertText 完成，这样页面框架能观察到与真实输入一致的 input 事件。
   * select 元素无法用键盘输入，脚本会直接设置原生 value 并派发 input/change。
   *
   * @param {string} targetId 页面 targetId。
   * @param {{index: number, text: string, clear?: boolean, submit?: boolean, clientId?: string}} options
   *   clear=true 时先全选再输入（覆盖原值）；submit=true 时输入后按 Enter。
   * @returns {Promise<object>} mode='selected' 时为 {index, mode, value, label}；
   *   mode='typed' 时为 {index, mode, tag, label, text, cleared, submitted}。
   * @throws {CdpError} REF_NOT_FOUND / REF_STALE / NOT_EDITABLE / OPTION_NOT_FOUND
   *   （由 actionError 映射），以及输入阶段的 CDP 错误。
   */
  async typeText(
    targetId,
    { index, text, clear = true, submit = false, clientId } = {},
  ) {
    const result = await this.evaluate(
      targetId,
      typeExpression({ index, text, clear }),
      { clientId },
    );
    if (!result?.ok) throw actionError(result, targetId);
    // select 在页面脚本内已直接选中并派发事件，无需也不应再走键盘输入。
    if (result.mode === 'selected') {
      return { index, mode: 'selected', value: result.value, label: result.label };
    }
    if (clear) {
      // 用平台对应的"全选"组合键，随后 insertText 会替换整个选区。
      const selectAll = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';
      await this.pressKey(targetId, { key: selectAll, clientId });
    }
    const session = await this.#ensure(targetId, clientId);
    // insertText 走真实的文本插入路径（而非逐字符按键），速度快且能正确触发 input。
    await this.#send(session, 'Input.insertText', { text }, clientId);
    if (submit) await this.pressKey(targetId, { key: 'Enter', clientId });
    return {
      index,
      mode: 'typed',
      tag: result.tag,
      label: result.label,
      text,
      cleared: clear === true,
      submitted: submit === true,
    };
  }

  /**
   * 发送一次完整的按键：rawKeyDown -> (char) -> keyUp。
   *
   * 三段的必要性：rawKeyDown/keyUp 负责快捷键与导航键（不会触发默认字符输入），
   * char 才真正产生可打印字符；带 Alt/Ctrl/Meta 时不发 char，否则会把组合键
   * 误当成文本输入。
   *
   * @param {string} targetId 页面 targetId。
   * @param {{key: string, clientId?: string}} options key 形如 "Enter"、"Tab"、"Control+A"。
   * @returns {Promise<{key: string, modifiers: string[]}>} 回显原始键名与解析出的修饰键名。
   * @throws {CdpError} INVALID_PARAMS —— 无法解析的键名（附可用写法提示）。
   */
  async pressKey(targetId, { key, clientId } = {}) {
    const combo = parseKey(key);
    if (!combo) {
      throw new CdpError(
        'INVALID_PARAMS',
        `unsupported key "${key}"; use Enter, Tab, Escape, arrows, or a combination like Control+A`,
      );
    }
    const session = await this.#ensure(targetId, clientId);
    const base = {
      key: combo.key,
      code: combo.code,
      windowsVirtualKeyCode: combo.vk,
      nativeVirtualKeyCode: combo.vk,
      modifiers: combo.modifiers,
      location: 0,
    };
    // 位掩码 7 = Alt|Ctrl|Meta，此时不应产生字符（Shift 除外，见 parseKey）。
    const sendText = combo.text && !(combo.modifiers & 7);
    await this.#send(session, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, clientId);
    if (sendText) {
      await this.#send(
        session,
        'Input.dispatchKeyEvent',
        { type: 'char', ...base, text: combo.text, unmodifiedText: combo.text },
        clientId,
      );
    }
    await this.#send(session, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base }, clientId);
    return { key, modifiers: combo.names };
  }

  /**
   * 导航页面并在限定时间内等待新文档加载完成。
   *
   * 先作废缓存 world（导航必然销毁它），再发 Page.navigate；随后轮询
   * document.readyState，直到 'complete' 或超时。轮询中的 evaluate 使用 retry，
   * 以容忍"文档正在被替换、旧 contextId 已失效"的中间态。
   *
   * @param {string} targetId 页面 targetId。
   * @param {{url: string, waitMs?: number, clientId?: string}} options
   *   waitMs 缺省取构造参数 navigateWaitMs，并被 clampWait 收敛。
   * @returns {Promise<{loaded: boolean, elapsedMs: number}>}
   * @throws {CdpError} NAVIGATION_FAILED —— Chrome 返回 errorText（DNS/证书/被拦截等）；
   *   NAVIGATION_TIMEOUT —— 等待窗口内未达到 complete；
   *   PAGE_CONTEXT_LOST 等 —— 见 evaluate。
   */
  async navigate(targetId, { url, waitMs, clientId } = {}) {
    const wait = clampWait(waitMs, this.navigateWaitMs);
    const session = await this.#ensure(targetId, clientId);
    // 提前清空 contextId：即使导航命令本身失败，旧 world 也不应再被使用。
    this.#invalidateContext(targetId);
    const startedAt = Date.now();
    const result = await this.#send(session, 'Page.navigate', { url }, clientId);
    if (result?.errorText) {
      throw new CdpError('NAVIGATION_FAILED', result.errorText, { targetId, url });
    }
    const deadline = startedAt + wait;
    let loaded = false;
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate(targetId, readyExpression(), {
          clientId,
          retry: true,
        });
        if (state === 'complete') {
          loaded = true;
          break;
        }
      } catch {
        /* 文档仍在替换中（旧上下文已销毁），忽略并在下一轮重试 */
      }
      await sleep(READY_POLL_MS);
    }
    if (!loaded) {
      throw new CdpError(
        'NAVIGATION_TIMEOUT',
        `the page did not finish loading within ${wait} ms`,
        { targetId, url },
      );
    }
    return { loaded, elapsedMs: Date.now() - startedAt };
  }

  /**
   * 读取页面的 url/title 事实。
   *
   * 走 Target.getTargetInfo 而非 evaluate，因此不要求页面可执行脚本，也不受导航
   * 上下文失效影响；读取失败时返回空字符串而不是抛错（调用方用于展示，不应阻断操作）。
   *
   * @param {string} targetId 页面 targetId。
   * @param {string} [clientId] 客户端标识。
   * @returns {Promise<{url: string, title: string}>}
   */
  async targetFacts(targetId, clientId) {
    try {
      const info = await this.cdp.send(
        'Target.getTargetInfo',
        { targetId },
        undefined,
        { clientId, timeoutMs: FACT_TIMEOUT_MS },
      );
      const target = info?.targetInfo;
      return {
        url: typeof target?.url === 'string' ? target.url : '',
        title: typeof target?.title === 'string' ? target.title : '',
      };
    } catch {
      return { url: '', title: '' };
    }
  }

  /**
   * 动作后的静置等待，给异步渲染/网络请求留出稳定时间。
   *
   * @param {number} [waitMs] 期望等待毫秒数；缺省取构造参数 settleMs。
   * @returns {Promise<void>} ms 为 0 时立即完成。
   */
  settle(waitMs) {
    const ms = clampWait(waitMs, this.settleMs);
    return ms > 0 ? sleep(ms) : Promise.resolve();
  }
}

export { clampWait };
