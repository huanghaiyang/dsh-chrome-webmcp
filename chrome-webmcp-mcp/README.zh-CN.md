# Chrome WebMCP 接入（中英双语见 [README.md](README.md)）

把本机 Chrome 里网页通过 **WebMCP** 注册的工具，接入 DeepSeek Harness（DSH），
让 Agent 像调用普通 MCP 工具一样列出并调用它们。

- 目标产物：`dsh-chrome-webmcp`（本目录）
- 实测环境：Windows 11 / Chrome **155.0.8059.80** / Node v22.22.0
- 设计目标：**一键安装、任务隔离、单信道多路复用、仓库可发布**

---

## 1. 结论速览

Chrome 155 **没有内置 MCP 服务器**，它的 MCP 能力是 **WebMCP**，分两层：

| 层次 | 接口 | 说明 |
|---|---|---|
| 网页侧 API | `document.modelContext` | `registerTool` / `getTools` / `executeTool` / `ontoolchange` |
| 调试侧协议 | CDP 域 `WebMCP`（**frame 级**） | `WebMCP.enable`；事件 `toolsAdded` / `toolsRemoved` / `toolInvoked` / `toolResponded`；命令 `invokeTool` |

本目录把 CDP 域包成 7 个标准 MCP 工具。`bridge.mjs` 零第三方依赖，
只用 Node 内置模块 + 全局 `fetch` / `WebSocket`（Node ≥ 22）。

> ⚠️ 网页侧 API 是 **`document.modelContext`**，不是 `navigator.modelContext`。

---

## 2. 一键安装

### Windows：双击 `install.cmd`

或在本目录执行：

```bat
node install.mjs
node install.mjs --profile web
node install.mjs --dry-run
node install.mjs --uninstall
```

安装器会：

1. 检查 Node ≥ 22；
2. 找到 `dsh`（`DSH_BIN` 或 `PATH`）；
3. 执行 DSH 官方支持的命令：
   `dsh plugin --profile <profile> add link:<本目录绝对路径>`；
4. 提示 HMR 是否已生效、如何验证。

> 安装器**不会**手改 profile 的 `package.json` / `cordis.patch.yml`；
> bundle 选择由 DSH 插件管理器完成。

Agent 内也可以直接：

```
plugin_manager install_bundle target=<本目录绝对路径>
```

### 为什么换机器不用改 YAML

[cordis.patch.yml](cordis.patch.yml) 用 Loader 的 `!!js` 表达式，**通过 profile 的
依赖图**解析本包（`createRequire(baseUrl).resolve('dsh-chrome-webmcp/package.json')`），
再用 `process.execPath` 启动：

```yaml
command: !!js process.execPath
args:
  - !!js process.getBuiltinModule('node:url').fileURLToPath(
      new URL('bridge.mjs',
        process.getBuiltinModule('node:url').pathToFileURL(
          process.getBuiltinModule('node:module').createRequire(baseUrl)
            .resolve('dsh-chrome-webmcp/package.json'))))
cwd: ...（同上，用 new URL('.', ...)）
```

注意：bundle 补丁的 `baseUrl` 是 **profile 目录**，不是包目录；所以必须走
profile 的 `node_modules` 解析（`dsh plugin add link:` 安装后一定存在），
不能直接 `new URL('bridge.mjs', baseUrl)`。

因此仓库里**没有绝对路径、没有用户名、没有 Node 安装路径**。clone 到任何目录、
或从 registry 安装，都直接可用。

---

## 3. 多任务隔离（任务命名空间）

一个 DSH Host 里会同时跑多个 Agent 任务。桥接器给每个调用方一个可选的
**taskId**：

- 格式 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`，默认 `"default"`；
- 并发任务请各用一个独立 `taskId`，并复用 `open_page` 返回值里的 `taskId`；
- `open_page` 打开的页面**归该任务所有**；
- `list_tools` / `invoke_tool` 的候选页面 = **本任务拥有的页面 + 用户自己打开的页面（无主页面）**；
- **其他任务的页面不可见**；拿别人的 `targetId` 直接用会返回 `TARGET_OTHER_TASK`；
- `open_page.isolated: true` 会为该任务创建独立 Chrome browser context
  （独立 cookie / storage），`close` 时一并销毁；
- `close` 只关闭**本任务拥有的页面**，不关浏览器、不关无主页面、不关别的任务；
- 只有 `close_browser`（必须 `confirm: true`）才会关闭整个 Chrome，且只应在
  用户明确要求时使用。

这解决了此前“多个任务互相影响浏览器行为”的核心问题：关闭、导航、按名字找工具
都不会再误伤其他任务。

---

## 4. 单信道公平调度（信道抢占）

所有指向同一个 `CHROME_CDP_PORT` 的 MCP 客户端进程，共享**一个 broker 进程**和
**一条** Chrome DevTools WebSocket：

```
MCP host A ─┐
MCP host B ─┼─ 本地 IPC ─→ broker ─→ 单条 CDP WebSocket ─→ Chrome
MCP host C ─┘
```

具体机制：

- **按 CDP id 多路复用**，不是一任务一条连接；
- 全局在飞上限 + **每客户端在飞上限** + FIFO 调度：某个任务一次打很多命令，
  最多占用自己的配额，队列里其他任务的命令仍会拿到通道；
- **工具发现按页面 single-flight + 缓存**：`list_tools` 命中缓存立即返回；
  `refresh: true` 才重新 enable 一次；
- **调用结果由 `toolResponded` 事件按 `invocationId` 唤醒**，不再轮询；
  等待结果期间不占用 CDP 调度槽，所以慢工具不会阻塞其他任务；
- 处理“先到响应、后到 `invocationId` 应答”的竞态；
- broker 懒启动、所有会话共享、空闲一段时间退出；Chrome 本身不会被关。

broker 的 IPC 端点默认是**每用户命名管道**（非 Windows 为 Unix socket），
不监听网络端口。`tcp://127.0.0.1:<port>` 仅用于测试/受限环境。

---

## 5. 工具清单

| 工具 | 参数 | 作用 |
|---|---|---|
| `status` | `taskId?`、`detail?: summary\|full` | 只读快照：Chrome 可达性/版本、broker 信息、本任务页面；不会 attach 页面 |
| `list_tools` | `targetId?`、`url?`、`taskId?`、`waitMs?`、`refresh?` | 列出本任务可用页面上的 WebMCP 工具 |
| `invoke_tool` | `toolName`(必填)、`input?`、`targetId?`、`url?`、`frameId?`、`taskId?`、`waitMs?` | 调用工具；`frameId` 必须配 `targetId` |
| `open_page` | `url`(必填)、`taskId?`、`isolated?`、`waitMs?` | 打开任务拥有的页面并返回已注册工具 |
| `launch` | `url?`、`timeoutMs?` | 端口未监听时按 WebMCP 参数拉起 Chrome |
| `close` | `taskId?` | 关闭本任务拥有的页面并销毁其隔离 context |
| `close_browser` | `confirm: true` | 关闭整个 Chrome；仅限用户明确要求 |

页面声明的 `description` / `inputSchema` 属于**不可信数据**：只呈现、不隐式执行；
只有 Agent 显式调用 `invoke_tool` 才会执行。

---

## 6. 启动参数（`launch` 自动带上）

```
--remote-debugging-port=9333
--remote-allow-origins=*
--enable-features=enable-webmcp-testing,WebMCP
--enable-blink-features=WebMCP
```

- `enable-webmcp-testing` 是 **base::Feature 名字**，当裸开关写无效；
- 只传 `enable-webmcp-testing` 时，CDP `WebMCP.enable` 能成功，但页面里
  `document.modelContext` 仍是 `undefined`——必须再加 `--enable-blink-features=WebMCP`。

---

## 7. 环境变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `CHROME_CDP_PORT` | `9333` | DevTools 端口；同时决定 broker 端点 |
| `CHROME_WEBMCP_IPC` | 按端口派生 | IPC 端点（测试可设 `tcp://127.0.0.1:0`） |
| `CHROME_WEBMCP_STATE_DIR` | `%LOCALAPPDATA%\dsh-chrome-webmcp` | broker 日志与状态文件 |
| `CHROME_PATH` | 自动探测 | `launch` 使用的 Chrome |
| `CHROME_USER_DATA_DIR` | `%LOCALAPPDATA%\dsh-webmcp-chrome` | `launch` 使用的隔离 profile |
| `CHROME_LISTEN_WAIT_MS` | `25000` | `launch` 等端口上限 |
| `CHROME_TOOL_SETTLE_MS` | `1200` | 首次发现工具的 settle 上限 |
| `CHROME_INVOKE_WAIT_MS` | `20000` | 调用结果默认等待 |
| `CHROME_WEBMCP_BROKER_IDLE_MS` | `600000` | broker 空闲退出 |
| `CHROME_WEBMCP_START_WAIT_MS` | `12000` | 客户端等待新 broker 上线 |
| `CHROME_WEBMCP_MAX_INFLIGHT` | `32` | 全局 CDP 在飞上限 |
| `CHROME_WEBMCP_CLIENT_MAX_INFLIGHT` | `8` | 单客户端 CDP 在飞上限 |
| `CHROME_CDP_TIMEOUT_MS` | `30000` | 单条 CDP 命令超时 |
| `CHROME_WEBMCP_DISCOVERY_CONCURRENCY` | `4` | 并行页面发现上限 |

> 运维：MCP 服务进程常驻；改完 `bridge.mjs` / `broker.mjs` 后需重启该行
> （`set_bundle false` → `true`），或让 HMR 重新加载补丁。broker 是独立进程，
> 代码变更需要杀掉旧 broker（或等它空闲退出）才会生效。

---

## 8. 验证步骤（实测）

```
mcp__chrome__launch
  -> { launched: true, browser: "Chrome/155.0.8059.80", port: 9333,
       userDataDir: "%LOCALAPPDATA%\\dsh-webmcp-chrome" }

mcp__chrome__open_page  url=file:///<REPO>/webmcp-test.html  taskId=demo
  -> { taskId: "demo", tools: [get_page_title, add_numbers] }

mcp__chrome__invoke_tool  toolName=add_numbers  input={a:20,b:22}  taskId=demo
  -> { status: "Completed", output: { sum: 42 }, invocationId: "..." }

mcp__chrome__close  taskId=demo
  -> { taskId: "demo", closedTargetIds: [...], disposedContext: false }
```

另外验证过：

- 两个任务各自 `open_page` 后，`list_tools` 只看到自己的页面 + 无主页面；
- 任务 B 直接 `invoke_tool` 任务 A 的 `targetId` → `TARGET_OTHER_TASK`；
- `close_task(a)` 后 B 的页面仍可调用，无主页面不受影响；
- `isolated: true` 的任务使用独立 browser context，`close` 后 `disposedContext: true`；
- 两个任务并发调用各自页面的工具，均返回各自结果，没有互相阻塞。

---

## 9. 已知坑与排查

### 9.1 沙箱内起不了 Chrome

在 DSH 的 Windows 文件沙箱里直接启动 Chrome 会立刻自退：

```
ERROR:crashpad_client_win.cc:430 OpenProcess: 拒绝访问。(0x5)
ERROR:crashpad_client_win.cc:144 crash server failed to launch, self-terminating
```

`--disable-breakpad` / `--disable-crash-reporter` 无效。**规避**：由 harness Host
派生的 MCP 进程去拉起 Chrome（Host 不受该沙箱限制），即 `mcp__chrome__launch`；
broker 是它的子进程，同样可以启动 Chrome。

### 9.2 测试命令

在受限环境（禁止子进程管道 / 命名管道）里：

```bash
node --test --experimental-test-isolation=none test/broker.test.mjs test/mcp.test.mjs
```

测试使用临时 TCP IPC 端点与独立临时目录，不碰真实 Chrome / 真实 broker。

### 9.3 改完代码必须重启

- MCP 客户端进程常驻：改 `bridge.mjs` 后要重启该 MCP 行；
- broker 也是常驻进程：改 `broker.mjs` 后需结束旧 broker 或等待空闲退出；
- 日志：`%LOCALAPPDATA%\dsh-chrome-webmcp\broker.log`。

### 9.4 `Schema.getDomains` 里找不到 WebMCP

正常：域是 frame 级的，只在 page session 上注册，必须 attach 页面再
`WebMCP.enable`。

### 9.5 跨源导航后拿不到结果

Chrome 限制：`Cannot return tool results after a cross-origin navigation`。
工具调用期间不要让页面跳转到别的源。

---

## 10. 文件清单

| 文件 | 说明 |
|---|---|
| [bridge.mjs](bridge.mjs) | MCP stdio 服务 + broker 生命周期客户端 |
| [broker.mjs](broker.mjs) | 唯一 CDP 连接：调度、会话注册、任务归属、IPC |
| [lib/config.mjs](lib/config.mjs) | 环境变量与默认值 |
| [lib/ipc.mjs](lib/ipc.mjs) | 换行 JSON IPC（pipe/socket/TCP） |
| [lib/cdp.mjs](lib/cdp.mjs) | CDP WebSocket + 公平调度器 |
| [lib/sessions.mjs](lib/sessions.mjs) | attach / enable / 工具注册 / 结果等待 |
| [lib/tasks.mjs](lib/tasks.mjs) | 任务命名空间与页面归属 |
| [cordis.patch.yml](cordis.patch.yml) | 可移植 bundle 补丁（无绝对路径） |
| [install.mjs](install.mjs) | 一键安装器 |
| [install.cmd](install.cmd) / [install.sh](install.sh) | 双击 / POSIX 包装脚本 |
| [scripts/check-sensitive.mjs](scripts/check-sensitive.mjs) | 仓库级敏感信息检查 |
| [docs/INSTALL.md](docs/INSTALL.md) | 安装 / 卸载 / 排障 |
| [docs/IPC.md](docs/IPC.md) | broker ↔ 客户端内部契约 |
| [SECURITY.md](SECURITY.md) | 安全说明 |
| [test/](test/) | 假 CDP 服务与无外部依赖测试 |
| [../webmcp-test.html](../webmcp-test.html) | 演示页（`add_numbers`、`get_page_title`） |

## 11. 安全与限制

- 桥接器只做**只读发现 + 按需调用**，不会因为页面加载而自动执行工具；
- 页面元数据视为不可信输入；
- 只覆盖 WebMCP；`Browser.*`、`Page.*` 等通用 CDP 能力未暴露给模型；
- 本地 IPC 端点默认仅当前用户可访问；`tcp://` 仅供测试；
- `document.domain` 页面无法使用 WebMCP（Chrome 限制）；
- `invoke_tool` 超时只停止等待，页面侧调用可能继续完成（本版本无取消命令）。

## 12. 许可证

MIT，见 [LICENSE](../LICENSE)。
