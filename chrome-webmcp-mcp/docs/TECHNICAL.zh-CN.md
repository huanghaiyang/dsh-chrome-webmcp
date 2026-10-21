# Chrome WebMCP 桥接器技术文档（v2）

> 适用版本：`dsh-chrome-webmcp` **2.0.0**
> 实测环境：Windows 11 / Chrome **155.0.8059.80** / Node **v22.22.0**
> 运行要求：Node **>= 22.3**（补丁使用 `process.getBuiltinModule`）
> 读者：需要部署、运维、排查或二次开发本插件的工程师
> 相关文档：[安装指南](INSTALL.md) · [内部 IPC 契约](IPC.md) · [中文 README](../README.zh-CN.md) · [英文 README](../README.md)

---

## 目录

1. [摘要](#1-摘要)
2. [术语表](#2-术语表)
3. [背景与问题定义](#3-背景与问题定义)
4. [总体架构](#4-总体架构)
5. [安装与部署](#5-安装与部署)
6. [配置参考](#6-配置参考)
7. [任务隔离模型](#7-任务隔离模型)
8. [信道与并发模型](#8-信道与并发模型)
9. [协议参考](#9-协议参考)
10. [源码导读](#10-源码导读)
11. [开发与扩展指南](#11-开发与扩展指南)
12. [测试与验证](#12-测试与验证)
13. [运维与故障排查](#13-运维与故障排查)
14. [安全模型](#14-安全模型)
15. [性能与限制](#15-性能与限制)
16. [版本与变更记录](#16-版本与变更记录)
17. [附录](#17-附录)

---

## 1. 摘要

Chrome 155 没有内置的 MCP 服务器，它的 MCP 能力是网页侧 **WebMCP**（`document.modelContext`）加调试侧 **CDP `WebMCP` 域**。本插件把后者包装成 7 个标准 MCP 工具，让 DSH 里的 Agent 能发现并调用网页注册的工具。

v2 在 v1 的基础上解决了四个工程问题：

| 问题 | v2 方案 |
|---|---|
| 多任务互相干扰浏览器行为 | `taskId` 命名空间 + 页面归属 + 可选隔离 browser context + 任务级 `close` |
| 多任务与浏览器通信的信道抢占 | 单 broker / 单 CDP WebSocket + 有界公平调度 + 持久工具注册表 + 事件驱动结果 |
| 换机器要改绝对路径 | bundle 补丁通过 profile 依赖图解析自身；`process.execPath` 启动 |
| 手工安装、仓库含机器信息 | 一键安装器 + 仓库敏感信息扫描与归档整理 |

核心不变量：

1. **一个 CDP 端口只有一个 broker、一条 CDP WebSocket。**
2. **一个页面 target 最多一个 attached session、一次 `WebMCP.enable`。**
3. **一个由桥接器创建的页面只归一个 task 所有。**
4. **一个工具调用结果只按 `invocationId` 唤醒对应等待者。**
5. **`close` 只关本任务页面；只有 `close_browser` 能关 Chrome。**

---

## 2. 术语表

| 术语 | 含义 |
|---|---|
| **MCP** | Model Context Protocol。DSH 通过 stdio JSON-RPC 2.0 与 MCP 服务器通信。 |
| **WebMCP** | Chrome 的网页侧工具注册协议。网页调用 `document.modelContext.registerTool()` 注册工具。 |
| **CDP** | Chrome DevTools Protocol。`WebMCP` 域是 **frame 级** 的，只在 page session 上可用。 |
| **target** | CDP 的页面目标，对应一个标签页（`targetId`）。 |
| **frame** | 页面内的 frame（`frameId`）。`WebMCP.invokeTool` 必须带 `frameId`。 |
| **session** | `Target.attachToTarget` 返回的页面会话（`sessionId`），WebMCP 域挂在其上。 |
| **browser context** | Chrome 的隔离存储上下文；`isolated: true` 时一个 task 独占一个。 |
| **task** | 调用方命名空间（`taskId`），用于页面归属与可见性隔离。 |
| **broker** | 独立进程，独占 Chrome CDP 连接，并向所有 MCP 客户端提供本地 IPC。 |
| **client** | 一个 `bridge.mjs` MCP 服务器进程；每个 MCP host 一个。 |
| **settle** | 等待 Chrome 重放完 `toolsAdded` 的观察窗口（自适应，非固定 sleep）。 |
| **invocationId** | `WebMCP.invokeTool` 返回的调用标识；结果事件按它配对。 |
| **无主页面** | 不是桥接器通过 `open_page` 创建、而是用户或其他软件打开的页面。 |

---

## 3. 背景与问题定义

### 3.1 Chrome 的两层 WebMCP

| 层次 | 接口 | 要点 |
|---|---|---|
| 网页侧 API | `document.modelContext` | `registerTool` / `getTools` / `executeTool` / `ontoolchange` |
| 调试侧协议 | CDP 域 `WebMCP` | `WebMCP.enable`；事件 `toolsAdded` / `toolsRemoved` / `toolInvoked` / `toolResponded`；命令 `invokeTool` |

必须同时启用两个特性，缺一不可：

```text
--enable-features=enable-webmcp-testing,WebMCP   # base::Feature 名是 enable-webmcp-testing
--enable-blink-features=WebMCP                  # 否则 document.modelContext 仍为 undefined
```

`WebMCP` 域是 frame 级的，不会出现在 browser 级 `Schema.getDomains` 或 `/json/protocol` 中，必须 attach 到页面 target 后再 `WebMCP.enable`。`invokeTool` 的 `frameId` 是必填；结果异步到达 `toolResponded`，按 `invocationId` 配对。

### 3.2 为什么不能“一个会话直接连 Chrome”

v1 是每个 MCP 服务器进程直接打开一条 CDP WebSocket。它在单任务下可用，但多任务/多 host 时会出现：

1. **多条 CDP 连接竞争同一页面**：每个客户端都 `WebMCP.enable`，Chrome 重复重放工具列表；页面工具注册表被反复刷新。
2. **信道抢占**：`list_tools` 每页固定 sleep 1.5s、调用结果每 40ms 轮询，慢工具会拖住共享连接上的其他请求。
3. **行为互相影响**：`close` 直接 `Browser.close`；`open_page` 的标签页没有归属；`invoke_tool` 按工具名跨所有页面找，可能打到别的任务正在用的页面。
4. **无法共享登录态与隔离并存**：要么所有任务共享默认上下文，要么全部隔离，缺少按任务选择。

### 3.3 v2 设计目标

- **任务隔离**：任务只能看见/操作自己的页面和无主页面。
- **单信道**：同一端口的所有客户端共享一个 broker、一条 CDP socket。
- **公平**：单个任务不能占满通道；慢调用不占通道槽。
- **可移植**：bundle 补丁不含绝对路径；换目录/换机器/registry 安装都可用。
- **可验证**：不依赖真实 Chrome 的 hermetic 测试；真实 Chrome 的端到端冒烟。

---

## 4. 总体架构

### 4.1 进程拓扑

```text
┌──────────────────────────── DSH Host（一个进程） ────────────────────────────┐
│  Agent 会话 A ─┐                                                              │
│  Agent 会话 B ─┼── MCP tools: mcp__chrome__status / list_tools / invoke_tool  │
│  Agent 会话 C ─┘                        │                                     │
│                                         ▼                                     │
│                              bridge.mjs（每个 MCP host 一个）                 │
│                                         │                                     │
│                    换行 JSON / 本地 IPC（Windows 命名管道 / Unix socket）      │
│                                         │                                     │
│                                         ▼                                     │
│                              broker.mjs（每个 CDP 端口一个）                  │
│                                         │                                     │
│                              唯一一条 CDP WebSocket                           │
│                                         │                                     │
└─────────────────────────────────────────┼─────────────────────────────────────┘
                                          ▼
                              Chrome 155
                        ├─ 默认 browser context
                        │    ├─ 用户页面（无主）
                        │    ├─ task A 页面
                        │    └─ task B 页面
                        └─ task C 隔离 context
                             └─ task C 页面
```

### 4.2 进程职责

| 进程 | 数量 | 职责 | 生命周期 |
|---|---|---|---|
| `bridge.mjs`（MCP 模式） | 每个 MCP host 一个 | stdio MCP 协议、7 个工具、broker 客户端 | 随 MCP host 启动；stdin 关闭/信号时退出 |
| `bridge.mjs --broker` | 每个 CDP 端口一个 | 独占 CDP、任务/会话/注册表、IPC 服务 | 懒启动；空闲退出；Chrome 不受影响 |
| Chrome | 每端口一个 | 页面与 WebMCP 执行 | 由用户或 `launch` 启动 |

### 4.3 关键不变量与状态机

- broker 启动后写 `broker.json` 状态文件；退出时删除。
- 任务页面归属写入同目录的 `ownership.json`；broker 重启/空闲退出后重新加载并与 `Target.getTargets` 对账。
- client 连接后必须先 `hello`；除 `ping` 外的请求在握手前被拒绝。
- 每个 target 的 session 由 `SessionBook.ensuring` 单飞创建；断开/关闭时清理。
- 每个 target 的归属由 `TaskBook.owners` 记录；target 消失时自动回收。
- 工具调用等待者由 `waiters: invocationId → waiter` 管理；超时/断线时统一拒绝。

### 4.4 一次调用的数据流

```text
Agent
  │ tools/call invoke_tool {toolName, taskId, ...}
  ▼
bridge.mjs
  │ IPC invoke_tool（一行 JSON）
  ▼
broker.mjs
  ├─ TaskBook.candidates(taskId)         → 目标页面集合
  ├─ SessionBook.ensure(targetId)        → attach + WebMCP.enable（首次）
  ├─ SessionBook.listTools(targetId)     → 命中缓存 / 首次 settle
  ├─ SessionBook.invoke(...)             → waiter 先注册，再发 CDP
  ▼
Chrome CDP
  │ WebMCP.invokeTool {frameId, toolName, input}
  │ → {invocationId}
  │ ...页面执行...
  │ WebMCP.toolResponded {invocationId, status, output}
  ▼
broker.mjs → IPC 结果 → bridge.mjs → MCP text content → Agent
```

注意：结果事件可能早于 `{invocationId}` 应答到达。`SessionBook` 用 `recent` 表暂存这类响应，拿到 invocationId 后立即消费，避免竞态丢结果。

---

## 5. 安装与部署

### 5.1 bundle 结构

```text
chrome-webmcp-mcp/
├── package.json          # dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml      # 插入 @deepseek-ai/dsh-mcp-client 行
├── bridge.mjs            # MCP 客户端 / broker 入口
├── broker.mjs            # broker 实现
├── lib/                  # config / ipc / cdp / sessions / tasks
├── install.mjs|.cmd|.sh  # 一键安装
├── docs/                 # 安装、IPC 契约、本文档
├── scripts/              # 敏感信息扫描
└── test/                 # 假 CDP + hermetic 测试
```

这是一个 **configuration-only bundle**：没有 Host 侧 JavaScript 插件代码，只通过补丁插入 DSH 已内置的 `@deepseek-ai/dsh-mcp-client` 行。

### 5.2 补丁为什么没有绝对路径

DSH 会把 bundle 补丁层展平到 profile 的根 Include。**bundle 补丁中的 `baseUrl` 是 profile 目录，不是 bundle 目录。** 因此不能用 `new URL('bridge.mjs', baseUrl)`，而要通过 profile 自己的依赖图解析已安装的包：

```yaml
- insert:
    - id: chrome-webmcp-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: chrome
        transport: stdio
        command: !!js process.execPath
        args:
          - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('bridge.mjs', process.getBuiltinModule('node:url').pathToFileURL(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('dsh-chrome-webmcp/package.json'))))"
        cwd: !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('.', process.getBuiltinModule('node:url').pathToFileURL(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('dsh-chrome-webmcp/package.json'))))"
        env:
          CHROME_CDP_PORT: '9333'
        toolCallTimeoutMs: 90000
        failOnStartupError: true
```

要点：

1. `command` 使用当前运行 harness 的 Node（`process.execPath`），不写死安装路径。
2. `args[0]` 通过 `createRequire(baseUrl).resolve(...)` 找到 profile 中 `link:` 依赖的真实路径。
3. `cwd` 设为 bundle 目录，便于相对路径资源（当前 bridge 不依赖 cwd，但保持稳定）。
4. `package.json` **不要**加 `exports` 字段阻断 `./package.json` 子路径，否则上述解析会失败。
5. `env` 目前只固定端口；其余变量可继承 harness 环境或在 profile 中追加。

### 5.3 一键安装

Windows：

```bat
:: 双击，或在有 dsh 的终端里
install.cmd
node install.mjs
node install.mjs --profile web
node install.mjs --dry-run
node install.mjs --uninstall
```

POSIX：

```sh
./install.sh --profile web
```

安装器只做三件事：检查 Node ≥ 22.3 与 bundle 完整性、找到 `dsh`（`DSH_BIN` 或 PATH）、执行官方命令：

```text
dsh plugin --profile <profile> add link:<bundle绝对路径>       # 安装
dsh plugin --profile <profile> remove dsh-chrome-webmcp        # 卸载
```

它**不手改** profile 的 `package.json` / `cordis.patch.yml`。退出码：`0` 成功，`1` 失败，`2` 用法错误。

### 5.4 安装后生效

- HMR 开启的 profile：补丁变化会触发重新组合，MCP 行可能自动重启；若代码文件（`bridge.mjs`/`broker.mjs`）在进程启动后修改，必须重启该行或等待 broker 空闲退出。
- 启动型 profile：重启 harness。
- 验证：`mcp__chrome__status` → `reachable: true`；`mcp__chrome__launch` 启动 Chrome。

### 5.5 手动安装

在 Agent 中使用：

```text
plugin_manager install_bundle target=<bundle绝对路径>
plugin_manager set_bundle target=dsh-chrome-webmcp enabled=false   # 暂停
plugin_manager set_bundle target=dsh-chrome-webmcp enabled=true    # 恢复
```

或在有 CLI 的终端中执行上面的 `dsh plugin ...`。

---

## 6. 配置参考

所有配置由 `lib/config.mjs` 读取；非法/非正数回退默认值。

| 环境变量 | 默认值 | 作用 | 调优建议 |
|---|---|---|---|
| `CHROME_CDP_PORT` | `9333` | DevTools 端口；同时决定 broker IPC 名称 | 改端口会启动独立 broker |
| `CHROME_WEBMCP_IPC` | Windows `\\.\pipe\dsh-chrome-webmcp-<port>`；Unix `<tmp>/dsh-chrome-webmcp-<port>.sock` | IPC 端点 | 测试用 `tcp://127.0.0.1:<port>` |
| `CHROME_WEBMCP_STATE_DIR` | `%LOCALAPPDATA%\dsh-chrome-webmcp`（端口 9333）；其他端口为 `...-<port>` | broker 日志/状态/归属文件 | 多实例测试隔离 |
| `CHROME_PATH` | 自动探测 | `launch` 使用的 Chrome | 非标准安装时显式设置 |
| `CHROME_USER_DATA_DIR` | `%LOCALAPPDATA%\dsh-webmcp-chrome`（端口 9333）；其他端口为 `...-<port>` | `launch` 的隔离 profile | 不要指向日常 profile |
| `CHROME_LISTEN_WAIT_MS` | `25000` | `launch` 等端口上限 | 慢机器可调大 |
| `CHROME_TOOL_SETTLE_MS` | `1200` | 首次工具发现的 settle 上限 | 页面工具注册慢时调大 |
| `CHROME_INVOKE_WAIT_MS` | `20000` | 默认调用等待 | 长任务页面调大 |
| `CHROME_WEBMCP_BROKER_IDLE_MS` | `600000`（10 分钟） | 无客户端后 broker 退出 | 频繁启停可调大 |
| `CHROME_WEBMCP_START_WAIT_MS` | `12000` | 客户端等待新建 broker | 慢磁盘可调大 |
| `CHROME_WEBMCP_MAX_INFLIGHT` | `32` | 全局 CDP 在飞上限 | 页面很多时可调大 |
| `CHROME_WEBMCP_CLIENT_MAX_INFLIGHT` | `8` | 单客户端在飞上限 | 防止单任务占满通道 |
| `CHROME_CDP_TIMEOUT_MS` | `30000` | 单条 CDP 命令超时 | 大页面/慢调试可调大 |
| `CHROME_WEBMCP_DISCOVERY_CONCURRENCY` | `4` | 并行页面发现上限 | 页面多时平衡延迟与负载 |
| `CHROME_WEBMCP_BROKER_STDERR` | 未设置 | 设为 `1` 时 broker 日志同时写 stderr | 前台调试 |

**固定内部上限**（不提供环境变量）：

- IPC 单行最大 8 MiB。
- 工具等待夹取范围 50 ms ～ 120000 ms。
- 日志单文件 2 MiB：broker 启动时若发现超过上限，先把旧的 `broker.log` 轮转为 `broker.log.1`。

**文件位置**：

```text
%LOCALAPPDATA%\dsh-chrome-webmcp\
├── broker.log       # 运行日志（连接、错误、停止）
├── broker.json      # {pid, ipc, port, startedAt, version}（退出时删除）
└── ownership.json   # 任务 → target/context 快照（跨 broker 重启保留）
```

非 9333 端口使用 `dsh-chrome-webmcp-<port>` 目录；Chrome 隔离 profile 同理使用 `dsh-webmcp-chrome-<port>`，避免两个端口共用同一个 Chrome 实例。

---

## 7. 任务隔离模型

### 7.1 `taskId` 规则

- 默认 `"default"`；客户端未传时自动补默认值。
- 正则：`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`。
- 每个并发任务应使用不同 `taskId`，并复用 `open_page` 返回的 `taskId` 与 `targetId`。

### 7.2 页面归属

broker 维护：

```text
tasks:      taskId → { id, targets:Set, browserContextId, isolated, createdAt, lastUsedAt }
owners:     targetId → taskId        # 仅记录 open_page 创建的页面
pages:      targetId → targetInfo    # 来自 Target.getTargets / 事件
```

规则：

| 页面来源 | 归属 | 其他任务可见？ |
|---|---|---|
| 本任务 `open_page` | 本任务 | 否（直接给 targetId 也会被拒绝） |
| 其他任务 `open_page` | 其他任务 | 否 |
| 用户/其他软件打开 | 无主 | 是（只读使用；`close` 不会关） |

**归属持久化**：`owners`/`tasks` 会同步写入状态目录的 `ownership.json`（原子替换，失败只记日志）。broker 空闲退出、崩溃或升级后重新启动时，会先加载该文件，再在首次 `Target.getTargets` 时丢弃已不存在的 target。Chrome 本身重启后 targetId 全部变化，旧归属会被清空；`close_browser` 会清空并持久化空快照。

### 7.3 候选页面算法

`TaskBook.candidates(taskId, {targetId, url})`：

1. 若给 `targetId`：必须存在；若属于其他任务 → `TARGET_OTHER_TASK`；否则只返回该页。
2. 否则：**本任务拥有的页面（最近打开的优先）** + **所有无主页面**；排除其他任务的页面。
3. 若给 `url`：只保留 URL 包含该子串的页面。
4. 每次调用先 `Target.getTargets` 对账，已消失的 target 自动从归属表移除。

### 7.4 隔离 browser context

`open_page({ isolated: true })`：

- 首次为该任务调用 `Target.createBrowserContext {disposeOnDetach:false}`；
- 后续该任务的隔离页面复用同一个 context；
- 页面创建时带 `browserContextId`；
- `close` 时 `Target.disposeBrowserContext` 销毁，`disposedContext: true`；
- 隔离上下文拥有独立 cookie / localStorage / cache，但**不影响可见性规则**（仍可读无主页面）。

### 7.5 `close` 与 `close_browser`

| 工具 | 行为 | 影响范围 |
|---|---|---|
| `close {taskId?}` | 并行 `Target.closeTarget` 关闭本任务拥有的页面；销毁其隔离 context；删除任务记录 | 只影响本任务 |
| `close_browser {confirm:true}` | `Browser.close`，清空 broker 的任务/页面状态 | 整个 Chrome |

`close` 对无主页面、其他任务页面、Chrome 本身**完全无副作用**；对不存在的任务返回空结果而不是错误。
关闭失败或无法确认关闭的页面会出现在 `stillOpen` 中并**保留归属**，避免“关闭失败后页面变成所有人可见”；隔离 context 也只有在全部页面确认关闭后才销毁。重试 `close` 即可继续清理。

### 7.6 `status` 的信息边界

- `status` 只读：不 attach 页面、不 enable WebMCP。
- Chrome 不可达时仍然返回：`chrome.reachable:false` + 顶层 `pageIndexError`（如 `CHROME_UNREACHABLE`），不会抛错。
- `detail: "summary"`（默认）：只列本任务页面，其他任务只给 `{id, pages}`。
- `detail: "full"`：其他任务额外给 `isolated` 与 `lastUsedAt`，**仍不给 URL**。
- 因此一个任务无法通过 `status` 枚举其他任务访问了哪些网址。

---

## 8. 信道与并发模型

### 8.1 单信道

所有 `bridge.mjs` 客户端通过本地 IPC 连到同一个 broker；broker 只打开一条 CDP WebSocket。这样：

- Chrome 只看到一条调试连接；
- `WebMCP.enable` 每个页面只发生一次；
- 工具注册表只有一份，不会因多客户端重复重放而抖动；
- 调用结果事件只有一个分发点。

### 8.2 公平调度器

`lib/cdp.mjs` 的 `FairScheduler`：

```text
queue: FIFO 请求队列
active: 全局在飞数
clientActive: clientId → 该客户端在飞数

enqueue(clientId) → 入队并 pump
pump():
  while active < MAX_INFLIGHT:
    找到队列中第一个“该 client 在飞数 < CLIENT_MAX_INFLIGHT”的请求
    没有则退出循环（避免忙等）
    取出、active++、clientActive++
    请求完成时 release(): active--、clientActive--、再次 pump
```

默认 `MAX_INFLIGHT=32`、`CLIENT_MAX_INFLIGHT=8`。效果：

- 单个客户端最多占用 8 个在飞槽；
- 即使它一次排入 100 条命令，队列中其他客户端的请求仍能被选中（扫描时跳过超配额项）；
- 命令超时（默认 30s）会释放槽位，迟到响应被忽略。

### 8.3 单飞与自适应 settle

每个 target 的首次发现：

```text
SessionBook.ensuring: targetId → Promise   # 并发调用共享同一个 attach+enable
SessionBook.refreshChain: 串行化 refresh
```

settle 规则（`#settle`）：

| 情况 | 结束条件 |
|---|---|
| 收到 `toolsAdded` / `toolsRemoved` | 最后一次事件后静默 **120ms** |
| 页面完全没有工具（无事件） | 最短 **450ms** 或 `waitMs`（取较小） |
| 一直有事件 | 硬上限 `waitMs`（默认 1200ms） |

与 v1 的固定 1500ms sleep 相比：有工具的页面通常 120ms 内完成；无工具页面约 450ms；已缓存的页面立即返回。

### 8.4 事件驱动调用

- 发送 `WebMCP.invokeTool` 并拿到 `{invocationId}`；若 `toolResponded` 已经提前到达，会先落在 `recent` 表里，拿到 id 后立即消费。
- 否则按 invocationId 挂 waiter；`WebMCP.toolResponded` 到达时查找并 resolve；找不到 waiter 的响应存入 `recent` 60 秒，专门处理“响应早于 ack”的竞态。
- 等待结果**不占用**调度器槽位：`invokeTool` 命令本身很快返回，之后只是本地 Promise 等待。
- 超时（默认 20s，最大 120s）拒绝为 `TOOL_TIMEOUT`；本版本 Chrome 没有取消命令，页面侧调用可能继续完成。

### 8.5 断开与清理

| 事件 | 处理 |
|---|---|
| CDP WebSocket 关闭 | 拒绝所有 pending 命令（`CHROME_DISCONNECTED`）；拒绝所有 waiter；清空 session 注册表；任务/归属保留，下次请求重连并 `Target.getTargets` 对账 |
| target 销毁 / `Inspector.detached` | 删除 session、注册表、归属；拒绝该 target 的 waiter（`TARGET_GONE`） |
| client 断开 | broker 删除客户端记录；若无客户端，开始空闲计时；不关闭页面 |
| broker 空闲 | 关闭 IPC 与 CDP，删除 `broker.json`，保留 `ownership.json` 后退出；Chrome 继续运行 |

### 8.6 为什么不会“信道抢占”

| v1 行为 | v2 行为 |
|---|---|
| 每个客户端一条 CDP 连接 | 一个 broker 一条连接 |
| 每页固定 1.5s sleep | 自适应 settle + 缓存 |
| 结果每 40ms 轮询 | `toolResponded` 事件唤醒 |
| 发现串行扫描所有页面 | 并行上限 4 + 单飞 + 缓存 |
| 无客户端配额 | 全局 32 / 单客户端 8 |
| 慢工具可能拖住连接 | 等待不占槽位 |

---

## 9. 协议参考

### 9.1 MCP stdio 协议

- 传输：stdin/stdout，**换行分隔 JSON-RPC 2.0**；stdout 只输出协议帧，诊断走 stderr。
- 支持方法：`initialize`、`ping`、`tools/list`、`tools/call`。
- `initialize`：回显请求的 `protocolVersion`（缺省 `2024-11-05`）；`capabilities.tools.listChanged=false`；`serverInfo={name:"chrome-webmcp",version:"2.0.0"}`；`instructions` 说明 taskId/close 规则。
- 通知（无 `id`）不回复；未知方法 `-32601`；未知工具 `-32602`；非法 JSON 行 `-32700`（`id:null`）。
- 工具执行错误：`isError:true`，文本以 `Error [CODE]: message` 开头；`error.data.message` 若存在且未包含在主消息中，会追加一行。

### 9.2 MCP 工具

按注册顺序：

| # | 工具 | 参数（`?` 可省） | 返回 |
|---|---|---|---|
| 1 | `status` | `taskId?`、`detail?: summary\|full` | `{task, otherTasks, chrome, broker, port, ipc}` |
| 2 | `list_tools` | `taskId?`、`targetId?`、`url?`、`waitMs?`、`refresh?` | `{taskId, candidates, pages[], skipped}` |
| 3 | `invoke_tool` | `toolName`、`input?`、`taskId?`、`targetId?`、`url?`、`frameId?`、`waitMs?` | `{taskId, toolName, targetId, frameId, status, output, invocationId, durationMs, ambiguous}` |
| 4 | `open_page` | `url`、`taskId?`、`isolated?`、`waitMs?` | `{taskId, targetId, url, title, isolated, tools[]}` |
| 5 | `launch` | `url?`、`timeoutMs?` | `{launched, alreadyRunning, pid?, port, userDataDir?, browser?}` |
| 6 | `close` | `taskId?` | `{taskId, closedTargetIds[], disposedContext}` |
| 7 | `close_browser` | `confirm`（必须 `true`） | `{closed:true}` |

补充：

- `invoke_tool.frameId` 必须同时给 `targetId`，否则 `FRAME_WITHOUT_TARGET`。
- 未给 `targetId` 时，`invoke_tool` 先在本任务页面（最近打开优先）中按工具名查找，再查无主页面；多个匹配时 `ambiguous:true`，使用第一个。
- `open_page` 只接受 `http(s)`、`file`、`about` URL。
- `close_browser` 的 `confirm` 在 JSON Schema 中为 `const true`，broker 也会二次校验。

### 9.3 broker IPC 协议

传输：换行 JSON；端点默认本地命名管道/Unix socket，测试可用 `tcp://127.0.0.1:<port>`。请求 `{id,method,params}`；响应 `{id,ok:true,result}` 或 `{id,ok:false,error:{code,message,data?}}`。

客户端首个请求必须是：

```json
{"id":1,"method":"hello","params":{"clientId":"mcp-1234-ab12","pid":1234,"version":"2.0.0","taskId":"default"}}
```

方法：

| 方法 | 参数 | 说明 |
|---|---|---|
| `hello` | `clientId`、`pid?`、`version?`、`taskId?` | 返回 brokerId、pid、ipc、port、startedAt、chrome 事实 |
| `ping` | — | `{pong:true, uptimeMs}` |
| `status` | `taskId?`、`detail?` | 任务/Chrome/broker 快照 |
| `list_tools` | `taskId?`、`targetId?`、`url?`、`waitMs?`、`refresh?` | 工具列表 |
| `invoke_tool` | `taskId?`、`toolName`、`input?`、`targetId?`、`url?`、`frameId?`、`waitMs?` | 调用工具 |
| `open_page` | `taskId?`、`url`、`isolated?`、`waitMs?` | 创建任务页面 |
| `close_task` | `taskId?` | 关闭任务页面 |
| `close_browser` | `confirm:true` | 关闭 Chrome |
| `launch` | `url?`、`timeoutMs?` | 必要时启动 Chrome |
| `shutdown` | — | 仅测试用：broker 退出 |

`list_tools` 的返回中，单个页面 attach/enable 失败不会让整个请求失败，而是该页 `tools:[]`、`error:"CODE"`，并计入 `skipped`。

### 9.4 CDP 时序

```text
broker                          Chrome
  │ Target.getTargets              │
  │───────────────────────────────>│
  │<───────────────────────────────│ {targetInfos}
  │ Target.attachToTarget          │
  │───────────────────────────────>│
  │<───────────────────────────────│ {sessionId}
  │ WebMCP.enable (session)        │
  │───────────────────────────────>│
  │<───────────────────────────────│ WebMCP.toolsAdded (replay)
  │ WebMCP.invokeTool (session)    │
  │───────────────────────────────>│
  │<───────────────────────────────│ {invocationId}
  │                               │ ...页面 execute...
  │<───────────────────────────────│ WebMCP.toolResponded
  │         resolve waiter         │
```

### 9.5 错误码总表

| 错误码 | 触发条件 | 典型处理 |
|---|---|---|
| `INVALID_PARAMS` | 缺参、taskId 非法、url 不合法、未 hello | 修正参数 |
| `CHROME_UNREACHABLE` | `/json/version` 失败 | `launch` 或检查端口 |
| `CHROME_DISCONNECTED` | CDP 连接关闭 | 下次调用重连 |
| `CDP_TIMEOUT` | 调度/命令超时 | 检查页面是否卡死 |
| `CDP_ERROR` | Chrome 返回协议错误 | 看 message |
| `TARGET_NOT_FOUND` | targetId 不存在 | 重新 `status/list_tools` |
| `TARGET_OTHER_TASK` | targetId 属于其他 task | 用自己的 taskId 或换页面 |
| `TARGET_GONE` | target 在等待期间被关闭 | 重新打开页面 |
| `FRAME_WITHOUT_TARGET` | 给了 frameId 没给 targetId | 两个一起给 |
| `TOOL_NOT_FOUND` | 候选页面都没有该工具 | 检查注册/taskId |
| `TOOL_TIMEOUT` | 等待 `toolResponded` 超时 | 增大 `waitMs`/检查页面 |
| `CONFIRM_REQUIRED` | `close_browser` 未传 confirm:true | 显式确认 |
| `BROWSER_LAUNCH_FAILED` | 找不到 Chrome 或端口未开 | 检查 `CHROME_PATH`/日志 |
| `BROKER_UNAVAILABLE` | 客户端等不到 broker | 看 `broker.log`/手动启动 |
| `IPC_TIMEOUT` / `IPC_CLOSED` | IPC 连接/请求超时或断开 | 重试下一次调用 |
| `METHOD_NOT_FOUND` | 未知 broker/MCP 方法 | 检查版本 |
| `INTERNAL` | 兜底 | 看日志 |
| `EADDRINUSE` | 同端点已有 broker | 直接复用即可 |

---

## 10. 源码导读

| 文件 | 行数（约） | 职责 |
|---|---|---|
| `lib/config.mjs` | 113 | 环境变量、默认值、Chrome 探测、路径 |
| `lib/ipc.mjs` | 302 | 换行 JSON、pipe/socket/TCP、客户端/服务端、错误序列化 |
| `lib/cdp.mjs` | 333 | CDP WebSocket、版本缓存、公平调度器、事件分发 |
| `lib/sessions.mjs` | 341 | target attach、enable、注册表、settle、invoke waiter |
| `lib/tasks.mjs` | 302 | task/页面归属、隔离 context、candidates、close/status |
| `broker.mjs` | 498 | broker 生命周期、IPC handler、launch、空闲退出 |
| `bridge.mjs` | 715 | MCP stdio、7 工具、broker 生命周期客户端 |
| `install.mjs` | 309 | 一键安装器 |
| `scripts/check-sensitive.mjs` | 334 | 敏感信息扫描 |

### 10.1 `lib/config.mjs`

所有常量只读一次环境变量。`positiveInt` 保证非正数回退默认。`BRIDGE_ENTRY` 由 `import.meta.url` 推导，因此包被 `link:`、复制或 registry 安装都能定位。`defaultStateDir(port)` / `defaultUserDataDir(port)` 为非 9333 端口追加 `-<port>`，避免多端口共享日志、归属文件和 Chrome profile。

### 10.2 `lib/ipc.mjs`

- `LineChannel`：socket 上的行协议；`pending: id → {resolve,reject,timer}`；请求超时、关闭时统一拒绝。
- `connectIpc(ipcName)`：支持路径或 `tcp://host:port`；连接超时默认 2s。
- `createIpcServer`：Windows 命名管道；Unix 先探测活跃进程再清理 stale socket。
- `errorToJson`：保留任意错误的 `code`/`message`/`data`。

### 10.3 `lib/cdp.mjs`

- `FairScheduler`：见 8.2。
- `ChromeCdp.version()`：2s 超时 + 2s 成功缓存；失败后短暂缓存，避免每条命令都打 HTTP。
- `ChromeCdp.ensure()`：单飞连接；打开后发 `Target.setDiscoverTargets`。
- `send(method, params, sessionId, {clientId,timeoutMs})`：先拿调度槽，再发命令；命令超时释放槽位。
- `#onMessage`：`id` 响应走 pending；其他 method 广播给监听者。
- `#onClose`：拒绝 pending，广播 `__cdpClose` 伪事件，供 session/task 清理。

### 10.4 `lib/sessions.mjs`

- `ensure()`：单飞 attach + enable；已有且 enabled 直接返回。
- `#enable()`：先挂 settle 监听，再发 `WebMCP.enable`；失败时 drop session。
- `#settle()`：120ms 静默 / 450ms 无事件 / 硬上限。
- `listTools()`：返回规范化工具数组。
- `invoke()`：先 ensure；解析 frameId；先发命令拿 invocationId；再查 `recent` 或挂 waiter。
- `#onEvent()`：`toolsAdded`/`toolsRemoved` 更新 Map 并通知 settle；`toolResponded` 优先按 invocationId 唤醒，未命中则暂存；`targetDestroyed`/`Inspector.detached` 清理。

### 10.5 `lib/tasks.mjs`

- `normalize()`：校验 taskId。
- `#loadOwnership()` / `persist()`：加载/原子写入 `ownership.json`；`open_page`、`close_task`、target 销毁、`close_browser`、broker 优雅退出时同步持久化。
- `refreshPages()`：单飞 `Target.getTargets`；按结果回收已消失 target 的归属（变化时持久化）。
- `candidates()`：见 7.3；本任务页面 `reverse()` 后优先。
- `openPage()`：可选创建 context；创建 target；登记归属并**立即持久化**；首次发现工具；补一次 `Target.getTargetInfo` 拿最终标题/URL。
- `closeTask()`：并行关页面；刷新校验实际是否消失；失败的页面保留在 `stillOpen` 且不销毁 context，成功的页面删除归属；只有全部关闭才删除任务。
- `closeBrowser()`：`Browser.close` 带 2s 超时；清空状态并持久化空快照。
- `status()`：只统计，不 attach；Chrome 不可达时返回 `pageIndexError` 而不是抛错。

### 10.6 `broker.mjs`

- `runBroker(options)`：可编程启动（测试直接调用）或 `--broker` 入口；支持 `ownershipFile` 覆盖。
- `createLogger()`：写 `broker.log`；>2 MiB 轮转一次。
- `launchChrome()`：复用已存在端口，否则 spawn Chrome（detached、stdio ignore），250ms 轮询等端口。
- `close()`：持久化归属、关闭 IPC/CDP、删除 `broker.json`；`ownership.json` 保留。
- 生产模式（`handleSignals !== false`）安装 SIGINT/SIGTERM；`uncaughtException` 记录后清理状态并 `exit(1)`，由客户端下次调用重建 broker。
- `listTools()`：`mapLimit(..., DISCOVERY_CONCURRENCY, ...)` 并行发现；单页失败降级为 `skipped`。
- `invokeTool()`：直接 `frameId+targetId` 跳过注册表扫描；否则按候选顺序找工具；返回 `ambiguous`。
- `dispatch()`：IPC 方法分发；未 hello 拒绝除 hello/ping 外的请求；`shutdown` 仅测试用。
- 空闲定时器：每 `max(250, min(idleMs/2, 30000))` 检查一次。

### 10.7 `bridge.mjs`

- 工具定义 `TOOLS`：名称、broker 方法、参数白名单、Schema、描述。
- `ensureBroker()`：单飞连接；失败则 `spawn(process.execPath, [BRIDGE_ENTRY,'--broker'], {detached,stdio:'ignore'})`，每 200ms 重试，上限 `BROKER_START_WAIT_MS`。
- `brokerRequest()`：每次工具调用一个 IPC 请求；**从不自动重试**（避免重复执行变更）。
- `handleMessage()`：MCP 方法分发；通知忽略；错误转为 `isError` 内容。
- `startStdioServer(input, output, {exitOnClose})`：生产用 `process.stdin/stdout`；测试可注入 PassThrough。

---

## 11. 开发与扩展指南

### 11.1 新增一个 MCP 工具

1. 在 `bridge.mjs` 的 `TOOLS` 增加一项：

```js
{
  name: 'navigate',
  method: 'navigate',
  paramNames: ['taskId', 'targetId', 'url'],
  description: '...',
  inputSchema: { /* JSON Schema, additionalProperties:false */ },
}
```

2. 在 `broker.mjs` 的 `dispatch()` 增加对应 `case`，实现业务逻辑；只读/写操作都要明确 task 作用域。
3. 在 `docs/IPC.md` 第 4 节补充方法契约（参数、返回、错误码）。
4. 在 `test/broker.test.mjs` 增加隔离/错误/并发断言；在 `test/mcp.test.mjs` 验证工具出现在 `tools/list` 且错误文本格式正确。
5. 跑 `node --test --experimental-test-isolation=none "test/*.test.mjs"`。

> 原则：**一个 MCP 工具 = 一个 broker IPC 请求**；不要把多步变更隐藏在客户端；错误码由 broker 统一给出。

### 11.2 新增 broker 方法

在 `dispatch()` 中加 `case`，并在 `docs/IPC.md` 的方法表登记；若需要新 CDP 命令，使用 `cdp.send(method, params, sessionId, {clientId,timeoutMs})`。不要在 broker 内直接 `ws.send`，否则绕过调度器。

### 11.3 测试写法

```js
import { startFakeCdp } from './test/fake-cdp.mjs';
import { runBroker } from './broker.mjs';
import { connectIpc } from './lib/ipc.mjs';

const fake = await startFakeCdp({ slowMs: 300 });
const broker = await runBroker({
  ipcName: 'tcp://127.0.0.1:0',
  port: fake.port,
  stateFile: '...',
  logFile: '...',
  handleSignals: false,
});
const client = await connectIpc(broker.ipcName);
await client.request('hello', { clientId: 'test', pid: process.pid, version: '2.0.0' });
// ...断言...
await broker.close();
await fake.close();
```

MCP 层测试可用：

```js
import { startStdioServer } from './bridge.mjs';
const server = startStdioServer(inputPassThrough, outputPassThrough, { exitOnClose: false });
```

### 11.4 调试

- 前台看 broker 日志：`CHROME_WEBMCP_BROKER_STDERR=1`。
- 日志文件：`%LOCALAPPDATA%\dsh-chrome-webmcp\broker.log`。
- 状态文件：同目录 `broker.json`（进程、端点、启动时间、版本）。
- Chrome 实例识别：打开 `chrome://version` 看命令行与 profile 路径；或请求 `http://127.0.0.1:9333/json/version`。
- 代码变更后：MCP 行常驻，必须重启行；broker 是独立进程，需等空闲退出或手动结束。

---

## 12. 测试与验证

### 12.1 测试矩阵

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `test/broker.test.mjs` | 13 | 任务隔离、隔离 context、跨任务拒绝、并发 300ms 调用、`close_task` 作用域、关闭失败保留归属、Chrome down 的 `status`、归属跨 broker 重启、缓存 vs refresh、错误码、非法参数连接存活、真实 broker 子进程空闲退出 |
| `test/config.test.mjs` | 1 | 状态目录/隔离 profile 按端口区分 |
| `test/mcp.test.mjs` | 5 | initialize、7 工具、open→invoke→close 往返、`[CODE]` 错误文本、stdout 纯 JSON-RPC |
| `test/live.test.mjs` | 1（默认 skip） | 真实 Chrome + `webmcp-test.html`，`add_numbers {20,22}` → 42 |

### 12.2 命令

```sh
cd chrome-webmcp-mcp
node --test --experimental-test-isolation=none "test/*.test.mjs"
# tests 20 / pass 19 / fail 0 / skipped 1
```

真实 Chrome 冒烟：

```bat
set CHROME_E2E=1
node --test --experimental-test-isolation=none "test/live.test.mjs"
```

POSIX：

```sh
CHROME_E2E=1 node --test --experimental-test-isolation=none "test/live.test.mjs"
```

需要 Chrome 已在 `CHROME_CDP_PORT`（默认 9333）开启调试端口。

### 12.3 沙箱注意事项

- 某些沙箱禁止带管道 stdio 的子进程：`node --test test/` 会报 `spawn EPERM`；使用 `--experimental-test-isolation=none` + 文件 glob。
- 某些沙箱禁止命名管道：测试使用 `tcp://127.0.0.1:<临时端口>`，不触碰真实 broker。
- 测试使用独立 `CHROME_WEBMCP_STATE_DIR`，不会污染用户日志。

### 12.4 验收清单

- [x] `status` 可达且返回 Chrome 版本。
- [x] `open_page` 返回 targetId 与工具列表。
- [x] `invoke_tool` 返回页面真实执行结果。
- [x] 两个 task 的页面互不可见；跨 task 直接 targetId → `TARGET_OTHER_TASK`。
- [x] `close_task(a)` 后 task b 仍可调用。
- [x] 两个 300ms 并发调用总耗时 < 500ms。
- [x] `refresh:true` 只增加一次 enable。
- [x] broker 空闲退出后 Chrome 仍存活。
- [x] 敏感信息扫描 clean。

---

## 13. 运维与故障排查

| 症状 | 可能原因 | 处理 |
|---|---|---|
| `mcp__chrome__*` 工具不存在 | 行未安装/未启用/启动失败 | 看 DSH 日志；`plugin_manager list_bundles`；重启行 |
| 行启动失败，args 指向不存在的路径 | bundle 不是用 `link:`/registry 安装，profile 依赖解析不到 | 用 `install.mjs` 重新安装 |
| `status.reachable=false` | Chrome 未启动或未开调试端口 | `mcp__chrome__launch`；或手动带 `--remote-debugging-port` |
| `WebMCP` 域不可用 | 启动参数缺 base feature | 用 `launch` 的参数，确认 `enable-webmcp-testing` |
| `document.modelContext` 为 `undefined` | 缺 Blink runtime feature | 加 `--enable-blink-features=WebMCP` |
| `TOOL_NOT_FOUND` | 页面未注册、工具名错、targetId 属于别人 | 重新 `list_tools`；检查 taskId |
| `TOOL_TIMEOUT` | 页面执行慢/导航/异常 | 增大 `waitMs`；检查页面是否跨源导航 |
| `TARGET_OTHER_TASK` | 想操作其他 task 的页面 | 用该 taskId 调用，或 `open_page` 自己的页面 |
| `CONFIRM_REQUIRED` | `close_browser` 未确认 | 传 `confirm:true`（仅用户明确要求时） |
| 修改代码不生效 | MCP 行/broker 常驻 | 重启 MCP 行；结束旧 broker 或等空闲退出 |
| `broker.log` 显示 EADDRINUSE | 同端口已有 broker | 正常复用；不要重复启动 |
| 测试 `spawn EPERM` | 沙箱禁止管道子进程 | 用 12.2 的命令 |
| Chrome 在 Agent shell 中自退 | 沙箱拒绝 crashpad `OpenProcess` | 通过 Host 的 `mcp__chrome__launch` 启动 |

### 重启策略

1. 只改 `cordis.patch.yml`：HMR 可能自动重组；否则重启 harness。
2. 改 `bridge.mjs`：重启 MCP 行（`set_bundle false → true`）。
3. 改 `broker.mjs`/`lib/*`：broker 是独立进程，必须结束旧 broker（或等空闲退出）后由下一次调用重新拉起。
4. 修改环境变量：需要新的 MCP 行/broker 进程才生效。

---

## 14. 安全模型

| 资产/边界 | 设计 |
|---|---|
| MCP 传输 | stdio，只在本机父子进程间；不监听网络 |
| broker IPC | 默认命名管道/Unix socket（当前用户）；`tcp://` 仅测试/受限环境使用 |
| Chrome 调试端口 | 仅 loopback；`--remote-allow-origins=*` 只用于 `launch` 的隔离 profile |
| Chrome profile | `launch` 使用 `%LOCALAPPDATA%\dsh-webmcp-chrome`，与日常 profile 分离 |
| 页面工具元数据 | 不可信输入：只展示，不隐式执行；`invoke_tool` 必须由 Agent 显式调用 |
| 凭据 | 插件不读取/不存储账号、Token、Cookie；隔离 context 初始为空 |
| 破坏性操作 | `close_browser` 需要 `confirm:true`；`close` 只影响本任务 |
| 仓库 | `check-sensitive.mjs` 扫描个人路径/Token/私钥/Cookie；`.gitignore` 排除 profile 与日志 |

威胁与缓解：

- **页面通过工具描述注入指令**：描述只作为数据展示；模型可能被诱导，但执行仍需显式 `invoke_tool`；高风险场景应只对可信页面启用。
- **本地其他进程连接 IPC**：命名管道由 OS 用户边界保护；测试用 TCP 仅绑定 127.0.0.1 且不应在生产启用。
- **调试端口暴露**：`--remote-allow-origins=*` 会放宽本地网页对调试端口的访问；只对专用隔离 profile 使用，不要对日常 Chrome 开启调试端口。

---

## 15. 性能与限制

### 15.1 实测

| 场景 | 结果 |
|---|---|
| 两个任务并发 `slow_echo`（各 300ms） | 总耗时 303–318ms，fake CDP `maxInflight=2` |
| 单次真实页面工具调用 | 约 1–2ms（不含页面自身耗时） |
| 首次无工具页面发现 | ~450ms（自适应 fallback） |
| 已缓存页面 `list_tools` | 立即返回，不再 enable |
| broker 空闲退出检查 | 每 `max(250ms, min(idle/2, 30s))` 一次 |

### 15.2 复杂度

- 单次调用：`Target.getTargets` + 缓存命中时 O(1)；首次发现 O(页面工具数)。
- `list_tools`：候选页面并行，最多 `DISCOVERY_CONCURRENCY=4` 个并发发现。
- 内存：每个 target 一份工具 Map + 一份 session；waiter 在调用结束后移除。

### 15.3 限制

- `WebMCP` 域是 frame 级，不能通过 browser 级协议枚举。
- 页面使用 `document.domain` 时 WebMCP 被 Chrome 禁用。
- 跨源导航后无法返回工具结果（Chrome 限制）。
- 本版本没有取消命令：`TOOL_TIMEOUT` 只停止等待，页面侧可能继续执行。
- 只暴露 WebMCP；通用 `Page.*`/`Browser.*` 能力未开放给模型。
- `close_browser` 关闭整个 Chrome，不应作为任务清理手段。

---

## 16. 版本与变更记录

### v2.0.0（当前）

- 新增 broker：单 CDP 通道、公平调度、持久注册表、事件驱动调用。
- 新增任务命名空间、页面归属、隔离 browser context、任务级 `close`。
- 新增 `close_browser`（显式确认）。
- 新增一键安装器、可移植补丁、敏感信息扫描、hermetic 测试。
- 修复 v1 的固定 settle、轮询结果、跨任务页面干扰、`close` 关整个浏览器等问题。

**稳定性修复（本批次）**

- Chrome 不可达时 `status` 返回 `reachable:false` + `pageIndexError`，不再抛错。
- 非 9333 端口的状态目录、日志、`ownership.json` 和 Chrome profile 自动追加端口后缀，避免多端口冲突。
- 任务归属持久化到 `ownership.json`，broker 重启/空闲退出后可恢复。
- `close_task` 只有确认页面消失才删除归属；失败页面进入 `stillOpen`，隔离 context 不提前销毁。
- broker 生产模式 `uncaughtException` 记录后退出，由客户端重新拉起；测试模式不安装全局处理器。
- Node 最低版本提升到 **22.3**（`process.getBuiltinModule`）。

### v1（历史）

- 单进程直接连 CDP；每个调用重新 attach/enable；固定 1.5s settle；40ms 轮询结果；无任务隔离；`close` 直接 `Browser.close`。保留在 `dev/` 中作为调查记录。

---

## 17. 附录

### A. 文件清单

| 文件 | 说明 |
|---|---|
| [bridge.mjs](../bridge.mjs) | MCP stdio 客户端 + broker 生命周期 |
| [broker.mjs](../broker.mjs) | broker：CDP/任务/会话/IPC |
| [lib/config.mjs](../lib/config.mjs) | 配置与默认值 |
| [lib/ipc.mjs](../lib/ipc.mjs) | 本地 IPC |
| [lib/cdp.mjs](../lib/cdp.mjs) | CDP 连接与调度 |
| [lib/sessions.mjs](../lib/sessions.mjs) | 会话与工具注册表 |
| [lib/tasks.mjs](../lib/tasks.mjs) | 任务与页面归属 |
| [cordis.patch.yml](../cordis.patch.yml) | 可移植 bundle 补丁 |
| [install.mjs](../install.mjs) | 一键安装器 |
| [docs/INSTALL.md](INSTALL.md) | 安装/卸载/排障 |
| [docs/IPC.md](IPC.md) | broker/client 契约（英文） |
| [scripts/check-sensitive.mjs](../scripts/check-sensitive.mjs) | 敏感信息扫描 |
| [test/fake-cdp.mjs](../test/fake-cdp.mjs) | 假 Chrome DevTools |
| [test/broker.test.mjs](../test/broker.test.mjs) | 隔离/并发测试 |
| [test/mcp.test.mjs](../test/mcp.test.mjs) | MCP 协议测试 |
| [test/live.test.mjs](../test/live.test.mjs) | 真实 Chrome 冒烟 |

### B. 快速命令

```sh
# 安装/卸载
node install.mjs --dry-run
node install.mjs
node install.mjs --uninstall

# 测试
node --test --experimental-test-isolation=none "test/*.test.mjs"

# 敏感信息
node scripts/check-sensitive.mjs

# 前台 broker 日志
CHROME_WEBMCP_BROKER_STDERR=1 node bridge.mjs --broker
```

### C. 参考

- 本地内部契约：[docs/IPC.md](IPC.md)
- 安装与运行：[docs/INSTALL.md](INSTALL.md)
- 用户视角说明：[README.zh-CN.md](../README.zh-CN.md)
- 历史探针与证据：[../../dev/README.md](../../dev/README.md)
