/**
 * Task namespaces and page ownership.
 *
 * A task is a logical caller identity ("default" unless the agent passes one).
 * Pages created by the bridge are owned by the task that opened them; pages the
 * user opened are unowned and shared read-only. Scoping discovery and
 * invocation to owned + unowned pages is what keeps concurrent tasks from
 * driving each other's tabs, and task-scoped close never touches the browser or
 * another task's work.
 */
import { CdpError } from './cdp.mjs';

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class TaskBook {
  constructor({ cdp, sessions, log = () => {} }) {
    this.cdp = cdp;
    this.sessions = sessions;
    this.log = log;
    this.tasks = new Map();
    this.owners = new Map(); // targetId -> taskId
    this.pages = new Map(); // targetId -> targetInfo
    this.refreshing = null;
    cdp.onEvent((message) => this.#onEvent(message));
  }

  normalize(taskId) {
    const id = taskId === undefined || taskId === null || taskId === '' ? 'default' : String(taskId);
    if (!TASK_ID.test(id)) {
      throw new CdpError('INVALID_PARAMS', `taskId must match ${TASK_ID}`, { taskId: id });
    }
    return id;
  }

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

  touch(task) {
    if (task) task.lastUsedAt = Date.now();
  }

  async refreshPages() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const { targetInfos = [] } = await this.cdp.send('Target.getTargets', {}, undefined, { timeoutMs: 10000 });
      const next = new Map();
      for (const info of targetInfos) if (info?.type === 'page') next.set(info.targetId, info);
      // Drop ownership of targets that no longer exist (closed by the user,
      // browser restart, or another task).
      for (const [targetId, owner] of this.owners) {
        if (next.has(targetId)) continue;
        this.owners.delete(targetId);
        this.tasks.get(owner)?.targets.delete(targetId);
      }
      this.pages = next;
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

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
   * Pages a task may use: its own pages first (most recently opened last), then
   * unowned pages. Never another task's pages.
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
    // Newest opened first, so a task that reopened a page after a reload wins
    // over its older tabs when a tool name exists on several of them.
    const owned = [...task.targets].reverse().map((targetIdValue) => this.pages.get(targetIdValue));
    const unowned = [...this.pages.values()].filter((page) => !this.owners.has(page.targetId));
    return matches(...owned, ...unowned);
  }

  async openPage({ taskId, url, isolated = false, waitMs, clientId }) {
    const id = this.normalize(taskId);
    const task = this.ensure(id);
    if (typeof url !== 'string' || !/^(https?:|file:|about:)/i.test(url)) {
      throw new CdpError('INVALID_PARAMS', 'url must be an http(s), file, or about URL', { url });
    }

    let contextId;
    if (isolated) {
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

    await this.refreshPages();
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
      // The page exists and is owned even if it never enabled WebMCP; report
      // the empty registry instead of losing the tab handle.
      this.log('[tasks] no tool registry for new page', targetId, error?.message || String(error));
    }
    // Pick up the final title/URL once the page had time to load.
    try {
      const info = await this.cdp.send('Target.getTargetInfo', { targetId }, undefined, { timeoutMs: 5000 });
      if (info?.targetInfo) {
        this.pages.set(targetId, info.targetInfo);
        page = info.targetInfo;
      }
    } catch {
      /* target info is best effort */
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

  async closeTask({ taskId }) {
    const id = this.normalize(taskId);
    const task = this.tasks.get(id);
    if (!task) return { taskId: id, closedTargetIds: [], disposedContext: false };

    const closedTargetIds = [];
    await Promise.all(
      [...task.targets].map(async (targetId) => {
        try {
          await this.cdp.send('Target.closeTarget', { targetId }, undefined, { timeoutMs: 5000 });
          closedTargetIds.push(targetId);
        } catch {
          /* already gone */
        }
        this.owners.delete(targetId);
        this.pages.delete(targetId);
        this.sessions.dropTarget(targetId);
      }),
    );

    let disposedContext = false;
    if (task.browserContextId) {
      try {
        await this.cdp.send(
          'Target.disposeBrowserContext',
          { browserContextId: task.browserContextId },
          undefined,
          { timeoutMs: 5000 },
        );
        disposedContext = true;
      } catch {
        /* target/context already gone */
      }
    }
    this.tasks.delete(id);
    return { taskId: id, closedTargetIds, disposedContext };
  }

  async closeBrowser() {
    try {
      await Promise.race([
        this.cdp.send('Browser.close', {}, undefined, { timeoutMs: 2000 }),
        new Promise((resolve) => setTimeout(resolve, 2500)),
      ]);
    } catch {
      /* the connection normally drops */
    }
    this.tasks.clear();
    this.owners.clear();
    this.pages.clear();
    return { closed: true };
  }

  async status({ taskId, detail = 'summary' } = {}) {
    const id = this.normalize(taskId);
    const task = this.ensure(id);
    await this.refreshPages();
    const pages = [...task.targets]
      .map((targetId) => this.pages.get(targetId))
      .filter(Boolean)
      .map((page) => this.pageFacts(page));
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
    };
  }

  describeCandidate(page) {
    return this.pageFacts(page);
  }

  #onEvent(message) {
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
      const targetId = message.params?.targetId;
      if (!targetId) return;
      this.pages.delete(targetId);
      const owner = this.owners.get(targetId);
      if (owner) {
        this.owners.delete(targetId);
        this.tasks.get(owner)?.targets.delete(targetId);
      }
    }
  }
}
