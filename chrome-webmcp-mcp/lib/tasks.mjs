/**
 * 任务命名空间与页面归属（Task namespaces and page ownership）。
 *
 * 职责：
 * - 把一个逻辑调用方身份建模为"任务"：默认是 "default"，agent 可通过 taskId 指定。
 * - 记录页面归属：由桥接器创建（openPage）的页面归"打开它的任务"所有；用户自己
 *   打开的页面不属于任何任务（unowned）。unowned 页面可被任何任务感知；但变更类
 *   动作（click/type_text/press_key/navigate）必须显式传该页的 targetId —— 缺 targetId
 *   时 broker 绝不静默挑一个 unowned 页面，否则并发任务会劫持用户正在用的标签页。
 * - 把页面发现（candidates）与调用范围限定在"本任务拥有的页面 + unowned 页面"，
 *   这正是并发任务不会互相驱动对方标签页的原因。
 * - 任务级关闭（closeTask）只处理本任务拥有的页面，绝不关闭浏览器，也不会破坏
 *   其它任务正在进行的工作。
 * - 归属关系会写入 ownershipFile，使 broker 重启（空闲退出、崩溃、升级）后仍能恢复。
 *
 * 关键不变量：
 * - 所有跨任务页面访问都必须先经过 candidates()；其它任务的页面不仅不可操作，
 *   连"可见"都做不到——直接按 targetId 访问会抛出 TARGET_OTHER_TASK。
 * - Chrome 的 targetId 在 Chrome 进程存活期间保持稳定，因此持久化 targetId 是
 *   安全的；Chrome 侧已消失的 target 会在下一次 refreshPages() 时被剔除。
 * - 关闭页面后必须以 Chrome 的实际状态复核，而不能只信任命令返回值；在无法证明
 *   页面已消失时保留其归属，避免把仍存活的标签页错误地移交给下一个任务。
 * - 只有当本任务所有页面都被确认消失后，才销毁其 browser context——销毁 context
 *   会连带关闭其中仍保留的页面，因此顺序与条件不能颠倒。
 * - 页面索引是"单飞"的：同一时刻只会有一次 refreshPages 在飞行，并发调用共享它。
 */
import fs from 'node:fs';
import path from 'node:path';
import { CdpError } from './cdp.mjs';

/**
 * taskId 白名单：ASCII 字母或数字开头，后续允许字母、数字、点、下划线和连字符，
 * 总长 2~64。该正则既用于入口校验（normalize），也用于恢复快照时的二次校验，
 * 防止持久化文件被篡改后注入非法身份。
 */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * 任务与页面归属登记册。
 *
 * 同时承担三件事：任务生命周期（ensure/closeTask）、页面索引（refreshPages +
 * 事件增量维护）、归属校验（candidates/pageFacts）。所有对外可见的页面都带有
 * ownedBy 事实，调用方据此判断是否能操作。
 */
export class TaskBook {
  /**
   * @param {object} options
   * @param {object} options.cdp CDP 连接封装，需提供 send() 与 onEvent()。
   * @param {object} options.sessions SessionBook，用于列出新页面的 WebMCP 工具并清理会话。
   * @param {Function} [options.log] 日志函数，签名 (…args) => void。
   * @param {string|null} [options.ownershipFile] 归属快照文件路径；省略则不持久化。
   */
  constructor({ cdp, sessions, log = () => {}, ownershipFile }) {
    this.cdp = cdp;
    this.sessions = sessions;
    this.log = log;
    this.ownershipFile = ownershipFile || null;
    this.tasks = new Map(); // taskId -> 任务记录 {id, targets, browserContextId, isolated, createdAt, lastUsedAt}
    this.owners = new Map(); // targetId -> 拥有该页面的 taskId
    this.pages = new Map(); // targetId -> Chrome 返回的 targetInfo（页面索引缓存）
    this.refreshing = null; // 单飞：进行中的 refreshPages Promise，避免并发全量刷新
    this.#loadOwnership();
    cdp.onEvent((message) => this.#onEvent(message));
  }

  /**
   * 在 broker 重启（空闲退出、崩溃、升级）后恢复页面归属。
   *
   * Chrome 进程存活期间 targetId 是稳定的，所以可以直接复用快照中的 targetId；
   * 已经消失的 target 会在首次 refreshPages() 时被剔除，这里无需（也无法）验证。
   * 读取失败一律降级为"无归属"：文件不存在（ENOENT）属正常首次启动，静默忽略；
   * 其它 I/O 错误只记日志。版本号或结构不匹配时整体放弃快照，避免误读旧格式。
   */
  #loadOwnership() {
    if (!this.ownershipFile) return;
    let snapshot;
    try {
      snapshot = JSON.parse(fs.readFileSync(this.ownershipFile, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.log('[tasks] could not read ownership file', this.ownershipFile, error?.message || String(error));
      }
      return;
    }
    // 只接受 version === 1 的显式格式；tasks 必须是数组，否则视为不可用快照。
    if (snapshot?.version !== 1 || !Array.isArray(snapshot.tasks)) {
      this.log('[tasks] ignoring unsupported ownership snapshot', this.ownershipFile);
      return;
    }
    let restored = 0;
    for (const entry of snapshot.tasks) {
      // 快照来自磁盘，必须按不可信输入处理：逐项校验 id 与 targets 的元素类型。
      if (!entry || typeof entry.id !== 'string' || !TASK_ID.test(entry.id)) continue;
      const targets = new Set(
        (Array.isArray(entry.targets) ? entry.targets : []).filter((targetId) => typeof targetId === 'string'),
      );
      if (targets.size === 0) continue;
      // isolated 只是 browserContextId 的派生事实，不单独信任快照中的布尔值。
      const browserContextId =
        typeof entry.browserContextId === 'string' && entry.browserContextId ? entry.browserContextId : null;
      this.tasks.set(entry.id, {
        id: entry.id,
        targets,
        browserContextId,
        isolated: Boolean(browserContextId),
        createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
        lastUsedAt: Number.isFinite(entry.lastUsedAt) ? entry.lastUsedAt : Date.now(),
      });
      for (const targetId of targets) this.owners.set(targetId, entry.id);
      restored += 1;
    }
    if (restored > 0) this.log('[tasks] restored ownership for', restored, 'task(s)');
  }

  /**
   * 同步持久化归属快照。
   *
   * 采用同步写的原因：文件很小、变更频率低，而归属丢失的代价（页面被别的任务接管
   * 或永久泄漏）远高于一次阻塞写。写入使用"临时文件 + 原子 rename"，避免读到
   * 写了一半的 JSON。没有 target 的空任务不落盘，保持文件精简。
   */
  persist() {
    if (!this.ownershipFile) return;
    const snapshot = {
      version: 1,
      savedAt: new Date().toISOString(),
      tasks: [...this.tasks.values()]
        .filter((task) => task.targets.size > 0)
        .map((task) => ({
          id: task.id,
          targets: [...task.targets],
          browserContextId: task.browserContextId,
          isolated: task.isolated,
          createdAt: task.createdAt,
          lastUsedAt: task.lastUsedAt,
        })),
    };
    const text = `${JSON.stringify(snapshot, null, 2)}\n`;
    try {
      fs.mkdirSync(path.dirname(this.ownershipFile), { recursive: true });
      const temporary = `${this.ownershipFile}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, text);
      try {
        fs.renameSync(temporary, this.ownershipFile);
      } catch {
        // Windows 有时拒绝覆盖已存在的文件；退化为先删除目标再 rename。
        // 这一步不是原子的，但比直接写入更接近替换语义，且失败会被外层捕获。
        fs.rmSync(this.ownershipFile, { force: true });
        fs.renameSync(temporary, this.ownershipFile);
      }
    } catch (error) {
      this.log('[tasks] could not persist ownership', this.ownershipFile, error?.message || String(error));
    }
  }

  /**
   * 规范化 taskId：undefined / null / 空串都视作 "default"。
   *
   * @param {string|undefined|null} taskId 调用方传入的原始任务标识。
   * @returns {string} 合法任务标识。
   * @throws {CdpError} INVALID_PARAMS —— 不匹配 TASK_ID 白名单时抛出，附 taskId 原文。
   */
  normalize(taskId) {
    const id = taskId === undefined || taskId === null || taskId === '' ? 'default' : String(taskId);
    if (!TASK_ID.test(id)) {
      throw new CdpError('INVALID_PARAMS', `taskId must match ${TASK_ID}`, { taskId: id });
    }
    return id;
  }

  /**
   * 取回任务记录，不存在则创建（懒初始化）。
   *
   * 任何一次使用都会刷新 lastUsedAt，供后续空闲回收/统计使用。
   *
   * @param {string|undefined|null} taskId 原始任务标识。
   * @returns {{id: string, targets: Set<string>, browserContextId: string|null, isolated: boolean, createdAt: number, lastUsedAt: number}}
   * @throws {CdpError} INVALID_PARAMS —— 非法 taskId（由 normalize 抛出）。
   */
  ensure(taskId) {
    const id = this.normalize(taskId);
    let task = this.tasks.get(id);
    if (!task) {
      task = {
        id,
        targets: new Set(),
        browserContextId: null,
        isolated: false,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
      };
      this.tasks.set(id, task);
    }
    task.lastUsedAt = Date.now();
    return task;
  }

  /**
   * 刷新任务的最近使用时间；容忍空记录（调用方可能拿到 undefined）。
   *
   * @param {object|undefined} task 任务记录。
   * @returns {void}
   */
  touch(task) {
    if (task) task.lastUsedAt = Date.now();
  }

  /**
   * 从 Chrome 全量刷新页面索引，并回收已消失 target 的归属。
   *
   * 单飞语义：并发调用不会各自发一次 Target.getTargets，而是共享同一个 Promise；
   * 刷新结束后清空 refreshing，让下一次调用重新发起。
   *
   * @returns {Promise<void>}
   * @throws {CdpError} 透传 Target.getTargets 的错误（如连接断开）。
   */
  async refreshPages() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const { targetInfos = [] } = await this.cdp.send('Target.getTargets', {}, undefined, { timeoutMs: 10000 });
      const next = new Map();
      // 只索引 type === 'page' 的 target：iframe / worker / browser 等不是可操作页面。
      for (const info of targetInfos) if (info?.type === 'page') next.set(info.targetId, info);
      // 丢弃已不存在的 target 的归属（被用户关闭、浏览器重启，或已被其它任务回收）。
      let removed = false;
      for (const [targetId, owner] of this.owners) {
        if (next.has(targetId)) continue;
        this.owners.delete(targetId);
        this.tasks.get(owner)?.targets.delete(targetId);
        removed = true;
      }
      this.pages = next;
      if (removed) this.persist();
    })();
    try {
      return await this.refreshing;
    } finally {
      // 无论成功失败都要释放单飞锁，否则后续刷新会永远悬挂在失败的 Promise 上。
      this.refreshing = null;
    }
  }

  /**
   * 把内部页面记录投影为对外事实对象（不泄漏内部 Map 结构）。
   *
   * isolated 的判定要求"任务确有 browserContextId"且"该页面确实属于这个 context"，
   * 避免把后来被移入/移出 context 的页面误标为隔离。
   *
   * @param {object} page Chrome targetInfo。
   * @returns {{targetId: string, url: string, title: string, isolated: boolean, ownedBy: string|null}}
   */
  pageFacts(page) {
    const ownerTaskId = this.owners.get(page.targetId) ?? null;
    const task = ownerTaskId ? this.tasks.get(ownerTaskId) : null;
    const isolated = Boolean(task?.browserContextId && page.browserContextId === task.browserContextId);
    return {
      targetId: page.targetId,
      url: page.url ?? '',
      title: page.title ?? '',
      isolated,
      ownedBy: ownerTaskId,
    };
  }

  /**
   * 列出某任务可使用的页面：先本任务页面（最近打开的在前），再 unowned 页面。
   * 其它任务的页面永远不会出现在结果中。
   *
   * 传入 targetId 时走精确查询：target 不存在抛 TARGET_NOT_FOUND，属于其它任务抛
   * TARGET_OTHER_TASK（附 ownerTaskId），此时调用方既看不到也无法操作该页面。
   *
   * @param {string|undefined|null} taskId 原始任务标识。
   * @param {{targetId?: string, url?: string}} [filters]
   *   targetId 精确指定页面；url 为子串过滤（仅作用于列表模式）。
   * @returns {Promise<object[]>} targetInfo 数组，可能为空。
   * @throws {CdpError} INVALID_PARAMS / TARGET_NOT_FOUND / TARGET_OTHER_TASK，
   *   或 refreshPages 透传的连接错误。
   */
  async candidates(taskId, { targetId, url } = {}) {
    const id = this.normalize(taskId);
    const task = this.ensure(id);
    await this.refreshPages();
    if (targetId) {
      const page = this.pages.get(targetId);
      if (!page) throw new CdpError('TARGET_NOT_FOUND', `page target ${targetId} does not exist`, { targetId });
      const owner = this.owners.get(targetId);
      if (owner && owner !== id) {
        throw new CdpError('TARGET_OTHER_TASK', `page target ${targetId} belongs to task "${owner}"`, {
          targetId,
          ownerTaskId: owner,
        });
      }
      return [page];
    }
    const matches = (...pages) =>
      pages.filter((page) => page && (!url || String(page.url || '').includes(url)));
    // 最近打开的排在最前：任务在 reload 后重开的页面会优先于它的旧标签页，
    // 从而在多个页面都有同名工具时选中"最新"的那个。task.targets 是 Set，
    // 插入顺序即打开顺序，因此 reverse() 即可得到从新到旧。
    const owned = [...task.targets].reverse().map((targetIdValue) => this.pages.get(targetIdValue));
    const unowned = [...this.pages.values()].filter((page) => !this.owners.has(page.targetId));
    return matches(...owned, ...unowned);
  }

  /**
   * 为一个任务打开新页面，并（可选）创建任务专属的隔离 browser context。
   *
   * 隔离语义：isolated: true 时，任务首次开页会创建 browser context 并缓存到
   * task.browserContextId；之后该任务的所有页面都在这个 context 内，与用户的
   * 默认 context 及别的任务的 context 完全隔离（cookie / storage 不共享）。
   *
   * @param {object} options
   * @param {string|undefined|null} options.taskId 任务标识。
   * @param {string} options.url 必须是 http(s)、file: 或 about: URL。
   * @param {boolean} [options.isolated=false] 是否使用隔离 browser context。
   * @param {number} [options.waitMs] 等待页面 WebMCP 工具注册的时间，默认 2500ms。
   * @param {string} [options.clientId] 发起调用的客户端标识，用于 CDP 多客户端路由。
   * @returns {Promise<{taskId: string, targetId: string, url: string, title: string, isolated: boolean, tools: Array}>}
   * @throws {CdpError} INVALID_PARAMS —— URL 协议不被接受；
   *   其余 CDP 错误（如 Target.createTarget 失败、超时）原样透传。
   */
  async openPage({ taskId, url, isolated = false, waitMs, clientId }) {
    const id = this.normalize(taskId);
    const task = this.ensure(id);
    if (typeof url !== 'string' || !/^(https?:|file:|about:)/i.test(url)) {
      throw new CdpError('INVALID_PARAMS', 'url must be an http(s), file, or about URL', { url });
    }

    let contextId;
    if (isolated) {
      // 每个任务只创建一次 context；后续开页复用，保证同一任务的页面互相可见
      // （共享 cookie/storage），同时与其它任务隔离。
      if (!task.browserContextId) {
        const created = await this.cdp.send(
          'Target.createBrowserContext',
          { disposeOnDetach: false },
          undefined,
          { clientId, timeoutMs: 15000 },
        );
        task.browserContextId = created.browserContextId;
        task.isolated = true;
      }
      contextId = task.browserContextId;
    }

    const params = { url };
    if (contextId) params.browserContextId = contextId;
    const { targetId } = await this.cdp.send('Target.createTarget', params, undefined, {
      clientId,
      timeoutMs: 15000,
    });
    task.targets.add(targetId);
    this.owners.set(targetId, id);
    this.touch(task);
    // 先持久化，再做较慢的发现阶段：这样即使进程在此刻崩溃，Chrome 中已经存在的
    // 这个页面也不会变成"无主页面"从而被其它任务随意使用。
    this.persist();

    await this.refreshPages();
    // refreshPages 可能因事件延迟尚未看到新 target，用刚才的参数兜底构造一条记录，
    // 保证后续 pageFacts/tools 查询有据可依。
    const page = this.pages.get(targetId) ?? {
      targetId,
      type: 'page',
      url,
      title: '',
      ...(contextId ? { browserContextId: contextId } : {}),
    };
    this.pages.set(targetId, page);

    let tools = [];
    try {
      tools = await this.sessions.listTools(targetId, {
        waitMs: waitMs ?? 2500,
        clientId,
      });
    } catch (error) {
      // 页面即使从未启用 WebMCP 也已经存在且归属于本任务；此时返回空工具注册表，
      // 而不是让调用方丢失这个标签页句柄。
      this.log('[tasks] no tool registry for new page', targetId, error?.message || String(error));
    }
    // 页面加载一段时间后再取一次 targetInfo，以获得最终的 title/url（初始值可能
    // 还是 about:blank）。此处失败不影响主流程，属于尽力而为。
    try {
      const info = await this.cdp.send('Target.getTargetInfo', { targetId }, undefined, { timeoutMs: 5000 });
      if (info?.targetInfo) {
        this.pages.set(targetId, info.targetInfo);
        page = info.targetInfo;
      }
    } catch {
      /* targetInfo 获取失败可以忽略，保留兜底记录 */
    }
    return {
      taskId: id,
      targetId,
      url: page.url ?? url,
      title: page.title ?? '',
      isolated: Boolean(contextId),
      tools,
    };
  }

  /**
   * 关闭某任务拥有的所有页面，并在条件满足时销毁其隔离 context。
   *
   * 只处理本任务页面；不会关闭浏览器，也不会碰其它任务的页面。
   * 关闭结果分为 closedTargetIds（命令确认关闭）与 stillOpen（仍存活、保留归属）。
   *
   * @param {{taskId?: string|null}} options
   * @returns {Promise<{taskId: string, closedTargetIds: string[], stillOpen: string[], disposedContext: boolean}>}
   * @throws {CdpError} INVALID_PARAMS —— 非法 taskId。
   */
  async closeTask({ taskId }) {
    const id = this.normalize(taskId);
    const task = this.tasks.get(id);
    // 未知任务直接返回空结果：关闭一个从未出现的任务是幂等的，不应报错。
    if (!task) return { taskId: id, closedTargetIds: [], stillOpen: [], disposedContext: false };

    const attempted = [...task.targets];
    const closedTargetIds = [];
    // 并发关闭所有页面；单个失败不影响其余页面，也不中止整批操作。
    await Promise.all(
      attempted.map(async (targetId) => {
        try {
          await this.cdp.send('Target.closeTarget', { targetId }, undefined, { timeoutMs: 5000 });
          closedTargetIds.push(targetId);
        } catch (error) {
          // 保留归属：页面可能仍然存活（受保护 target、Chrome 繁忙，或瞬时 CDP 错误）。
          this.log('[tasks] closeTarget failed', targetId, error?.code || '', error?.message || String(error));
        }
      }),
    );

    // 以 Chrome 的实际状态复核，而不是只信任命令返回值。若 Chrome 不可达，
    // 我们无法证明页面已消失，此时 liveTargets 为 null，一律保留归属。
    let liveTargets = null;
    try {
      await this.refreshPages();
      liveTargets = new Set(this.pages.keys());
    } catch (error) {
      this.log('[tasks] could not verify closed targets', error?.code || '', error?.message || String(error));
    }

    const stillOpen = [];
    for (const targetId of attempted) {
      const closedByCommand = closedTargetIds.includes(targetId);
      const gone = closedByCommand || (liveTargets !== null && !liveTargets.has(targetId));
      if (!gone) {
        stillOpen.push(targetId);
        continue;
      }
      // 彻底移除：归属、页面索引、以及该 target 的 WebMCP 会话（SessionBook）三处
      // 都要清理，否则会残留指向已关闭 target 的会话。
      this.owners.delete(targetId);
      this.pages.delete(targetId);
      this.sessions.dropTarget(targetId);
    }

    let disposedContext = false;
    // 销毁 browser context 会连带关闭我们仍想保留的页面，所以只有在"本任务所有
    // 页面都被确认消失"时才执行；dispose 失败通常意味着 context 已不存在，忽略即可。
    if (task.browserContextId && stillOpen.length === 0) {
      try {
        await this.cdp.send(
          'Target.disposeBrowserContext',
          { browserContextId: task.browserContextId },
          undefined,
          { timeoutMs: 5000 },
        );
        disposedContext = true;
      } catch {
        /* target/context 已经不存在 */
      }
    }

    if (stillOpen.length > 0) {
      // 仍有页面存活：任务保留，targets 收缩为存活集合，等下次 closeTask 再试。
      task.targets = new Set(stillOpen);
      task.lastUsedAt = Date.now();
    } else {
      this.tasks.delete(id);
    }
    this.persist();
    return { taskId: id, closedTargetIds, stillOpen, disposedContext };
  }

  /**
   * 关闭整个浏览器并清空所有任务状态。
   *
   * Browser.close 的响应通常不会到达（连接直接断开），因此与 2.5s 定时器竞速，
   * 只保证不会无限等待；无论命令是否成功都清空本地状态并持久化。
   *
   * @returns {Promise<{closed: true}>}
   */
  async closeBrowser() {
    try {
      await Promise.race([
        this.cdp.send('Browser.close', {}, undefined, { timeoutMs: 2000 }),
        new Promise((resolve) => setTimeout(resolve, 2500)),
      ]);
    } catch {
      /* 正常情况下连接会直接断开，属于预期行为 */
    }
    this.tasks.clear();
    this.owners.clear();
    this.pages.clear();
    this.persist();
    return { closed: true };
  }

  /**
   * 汇报任务状态与它的页面事实。
   *
   * status 必须在 Chrome 不可用时依然可用：页面索引刷新失败时不抛错，而是把错误码
   * 放进 pageIndexError，并返回"最后已知"的页面事实。
   *
   * @param {{taskId?: string|null, detail?: 'summary'|'full'}} [options]
   *   detail 为 'summary' 时其它任务只暴露 {id, pages}；'full' 额外给出 isolated
   *   与 lastUsedAt。
   * @returns {Promise<{task: {id: string, pages: object[], isolated: boolean, browserContextId: string|null}, otherTasks: object[], pageIndexError?: string}>}
   * @throws {CdpError} INVALID_PARAMS —— 非法 taskId。
   */
  async status({ taskId, detail = 'summary' } = {}) {
    const id = this.normalize(taskId);
    const task = this.ensure(id);
    let pageIndexError = null;
    try {
      await this.refreshPages();
    } catch (error) {
      // status 需要在 Chrome 挂掉时保持有用：报告失败码与最后已知的页面事实，
      // 而不是把异常抛给调用方。
      pageIndexError = error?.code || 'INTERNAL';
      this.log('[tasks] status page index unavailable', pageIndexError, error?.message || String(error));
    }
    // 只报告本任务拥有的页面，且过滤掉索引中已不存在（但归属尚未回收）的条目。
    const pages = [...task.targets]
      .map((targetId) => this.pages.get(targetId))
      .filter(Boolean)
      .map((page) => this.pageFacts(page));
    // 其它任务只暴露计数（或摘要），不泄漏它们的页面明细，维持任务隔离边界。
    const otherTasks = [...this.tasks.values()]
      .filter((entry) => entry.id !== id)
      .map((entry) => ({
        id: entry.id,
        pages: entry.targets.size,
        isolated: entry.isolated,
        lastUsedAt: new Date(entry.lastUsedAt).toISOString(),
      }));
    return {
      task: {
        id,
        pages,
        isolated: task.isolated,
        browserContextId: task.browserContextId,
      },
      otherTasks: detail === 'full' ? otherTasks : otherTasks.map(({ id: otherId, pages: count }) => ({ id: otherId, pages: count })),
      ...(pageIndexError ? { pageIndexError } : {}),
    };
  }

  /**
   * 把候选页面描述为对外事实对象；目前与 pageFacts 等价，保留独立入口以便
   * 未来在不改变内部结构的前提下扩展对外字段。
   *
   * @param {object} page Chrome targetInfo。
   * @returns {{targetId: string, url: string, title: string, isolated: boolean, ownedBy: string|null}}
   */
  describeCandidate(page) {
    return this.pageFacts(page);
  }

  /**
   * 订阅 CDP 事件，增量维护页面索引与归属。
   *
   * 走事件而不是每次查询都全量刷新的原因：targetCreated/InfoChanged/Destroyed
   * 能覆盖大部分变化，让 candidates/status 拿到接近实时的数据；refreshPages 仍
   * 作为兜底与校验手段保留。
   *
   * @param {object} message CDP 事件消息 {method, params}。
   * @returns {void}
   */
  #onEvent(message) {
    // 连接关闭（内部伪事件）：索引全部失效，等待重连后的全量刷新重建。
    if (message.method === '__cdpClose') {
      this.pages.clear();
      return;
    }
    if (message.method === 'Target.targetCreated') {
      const info = message.params?.targetInfo;
      if (info?.type === 'page') this.pages.set(info.targetId, info);
      return;
    }
    if (message.method === 'Target.targetInfoChanged') {
      const info = message.params?.targetInfo;
      if (info?.type === 'page') this.pages.set(info.targetId, info);
      return;
    }
    if (message.method === 'Target.targetDestroyed') {
      // target 消失即回收归属：否则该 targetId 会一直占着 owners，导致任务
      // 的 targets 集合无法清空、closeTask 也无法正常结束任务。
      const targetId = message.params?.targetId;
      if (!targetId) return;
      this.pages.delete(targetId);
      const owner = this.owners.get(targetId);
      if (owner) {
        this.owners.delete(targetId);
        this.tasks.get(owner)?.targets.delete(targetId);
        this.persist();
      }
    }
  }
}
