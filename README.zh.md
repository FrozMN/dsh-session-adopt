# dsh-session-adopt

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：查找**在当前桌面窗口之外**创建的会话（例如 VS Code 通过 ACP 创建的会话），并把它们归置到对应的工作区；同时在侧边栏提供手动同步入口，并为浏览器刷新会话目录，无需重启 Harness。

```
侧边栏
  ...
  ⚙  设置
  ⟳  同步会话   +3
```

## 为什么需要它

DeepSeek Harness 的持久会话日志由所有客户端、所有进程共享。但是运行中的 Web/Desktop Host 只在启动时建立一次 `cwd → 工作区` 索引，浏览器的会话列表也不会自行重新拉取。

因此，另一个进程创建的会话（VS Code 的 ACP、SDK 客户端、headless 运行等）虽然已经落盘，却会一直处于**未分组**状态；只有重启 Harness 才可能看到，而且仍不一定归入工作区。

本插件在运行时补齐这段缺口：

1. 通过 `ctx.sessionPersistence` 读取持久会话；
2. 把每个会话的 `cwd` 解析为规范路径，并匹配工作区；
3. 调用 `workspace.attachSession()` 把会话归入工作区；
4. 工作区变更通过现有的 `workspace.follow` 流更新侧边栏；
5. 调用 `ctx.sessions.refresh()` 刷新客户端会话目录，让新行立即出现。

## 功能

- **手动同步**：侧边栏底部按钮；点击后执行全量扫描并刷新会话列表。
- **启动扫描**：插件加载后把已经存在的会话归位。
- **定时扫描**：默认每 2 小时检查一次活跃工作区。
- **活跃窗口**：默认 6 小时，以会话日志文件的修改时间为准；新发现的会话即使还没有对应工作区，也会让其所在目录成为活跃项。
- **回到窗口扫描**：窗口重新可见时最多每分钟触发一次，覆盖“从 IDE 切回 Harness”的常见流程。
- **自动创建工作区**：新会话的规范 `cwd` 没有对应工作区时自动创建。
- **串行、幂等扫描**：单个会话失败只记录错误，不中断整次扫描。
- **中英文界面**：跟随 Harness 的语言设置。

## 前置条件

- 使用 Web 或 Desktop profile，并且该组合挂载了 Workspace 插件和 Web 侧边栏；
- 启用了会话持久化（随附的 JSONL 后端即可）；
- 插件没有 npm 依赖，只使用 Node 内置模块和 [`index.js`](index.js) 中列出的 Harness 服务：`webServer`、`connection`、`sessionPersistence`、`workspaceRegistry`。

## 安装

### 通过插件页面（推荐）

1. 把本仓库克隆到 Harness 所在机器上的某个目录，或准备好仓库地址；
2. 打开 DeepSeek Harness 的 **设置 → 插件**；
3. 使用 **安装 Bundle**，指向本地目录或仓库地址；
4. 如果未自动启用，启用 **会话归位**。

安装步骤必须同时完成“安装包”和“选中 bundle”两件事。插件页面会完成这两步；在 profile 里直接执行 `pnpm add` 不会选中 bundle。

### 通过 plugin_manager 工具

如果当前 Agent 暴露了 Host 的 `plugin_manager` 工具：

```text
plugin_manager install_bundle  <绝对路径或 Git URL>
```

然后确认 `session-adopt` 行处于 active：

```text
plugin_manager list_plugins
```

### 更新

替换包文件（或拉取仓库）后，在插件页面重启该插件即可。本插件是纯 ESM bundle，无构建步骤。

## 使用

| 操作 | 结果 |
|---|---|
| 点击 **同步会话** | 全量扫描（含较早的未归置会话），然后刷新会话列表 |
| 悬停按钮 | 显示上次同步时间、归置数量或失败原因 |
| `+N` 徽标 | 最近一次同步新归置的会话数 |

按钮注册在 `sidebar.footer.action` 槽位，位于设置入口旁边；侧边栏展开和收起为图标栏时都会显示。

## 配置

默认值写在 bundle 的 [`cordis.patch.yml`](cordis.patch.yml)。要修改时，在**当前 profile** 的 `cordis.patch.yml` 中覆盖 `session-adopt` 行：

```yaml
- id: session-adopt
  name: "dsh-session-adopt"
  config:
    pollIntervalMs: 7200000
    activeWindowMs: 21600000
    autoCreateWorkspaces: true
    includeSubagents: false
    startupScan: true
    startupDelayMs: 2500
```

行的 `config` 是整体替换，需要把要保留的键全部写出。

| 键 | 默认值 | 含义 |
|---|---|---|
| `pollIntervalMs` | `7200000`（2 小时） | 活跃工作区扫描间隔，最小 1 分钟 |
| `activeWindowMs` | `21600000`（6 小时） | 会话日志在多久内修改过，其工作区才算活跃 |
| `autoCreateWorkspaces` | `true` | 新会话的规范 `cwd` 没有工作区时自动创建 |
| `includeSubagents` | `false` | 是否把 `origin: "subagent"` 的会话也归入工作区（不建议） |
| `startupScan` | `true` | 插件加载后是否执行一次全量扫描 |
| `startupDelayMs` | `2500` | 启动扫描前的等待时间 |

修改会重启插件，同时重新建立定时器和启动扫描。

## 工作原理

### Host 侧

- [`index.js`](index.js) 导出 `apply(ctx, config)`；
- 扫描 `ctx.sessionPersistence.list()`，每个快照带有会话头部和日志位置；
- 用 `fs.realpath` 规范化 `cwd`，只考虑真实存在的目录；
- 按规范路径匹配现有工作区；策略允许时用 `ctx.workspaceRegistry.create(path)` 创建；
- 按创建时间从旧到新调用 `attachSession()`，让最新会话排在工作区最前；
- 扫描串行执行，返回 `attachedCount`、`createdCount`、`deferredCount`、`skipCounts` 和有界错误信息。

两个精确 HTTP 路由都经过组合的信任围栏（`ctx.connection.requestRejection(req)`：Host/Origin 校验 + 浏览器登录 Cookie）：

| 路由 | 方法 | 用途 |
|---|---|---|
| `/session-adopt/scan` | `POST` | 执行扫描；请求体 `{ "scope": "all" \| "active" }` |
| `/session-adopt/status` | `GET` | 读取配置、`scanning`、下次定时扫描时间和上次扫描摘要 |

请求体上限 16 KiB，必须是 `application/json`；请求中的任何字段都不会被当作文件路径。

### Client 侧

- [`client.js`](client.js) 是懒加载的浏览器模块，注册侧边栏动作；
- 先调用 Host 路由，再调用 `ctx.sessions.refresh()` 重建会话目录；
- 订阅 `workspace.follow` 推送的 Workspace 快照；当某个 Workspace 引用了目录中不存在的会话 id（后台扫描归置新会话的特征）时，带短防抖地刷新一次目录；
- 所有可见文本通过 `ctx.locale` 注册 `en` / `zh` 词典。

### 工作区创建策略

为了避免每次重启都把用户主动删除的工作区重新创建出来，定时/启动扫描只对**插件进程启动后新产生**的会话自动创建缺失工作区；显式手动同步允许为更早的历史创建。`cwd` 已有工作区的会话无论新旧都会归入。

## 安全

- 所有路由仅限同源，并在执行任何工作前经过 Harness `connection` 信任围栏；未认证请求返回 `401`，跨站请求返回 `403`。
- 路由只读写工作区成员关系；插件不读取会话消息内容、不写会话日志、不接受请求传入的路径。
- 插件没有 npm 依赖，安装不会执行第三方代码。

## 限制

- 只能发现**已持久化**的会话；另一进程刚创建、尚未落盘的会话要等下一次扫描。
- 工作区匹配是**规范 `cwd` 精确匹配**，不做父目录包含匹配。
- 默认跳过 `origin: "subagent"` 和 `migration-required` 会话。
- 不会把另一进程正在写入的会话内容实时流到已打开页面；它解决发现、归置和目录/元数据刷新，打开会话时读取的是最新持久日志。
- 两个进程同时写同一个会话仍属于 Harness 本身不支持的使用方式。
- `+N` 徽标和上次同步提示只存在于当前页面，刷新后重置。

## 文件

| 文件 | 用途 |
|---|---|
| [`index.js`](index.js) | Host 插件：扫描、工作区归置、路由、定时器 |
| [`client.js`](client.js) | 浏览器插件：侧边栏动作、目录刷新、语言词典 |
| [`cordis.patch.yml`](cordis.patch.yml) | Loader 行和默认配置 |
| [`locale/en.json`](locale/en.json)、[`locale/zh.json`](locale/zh.json) | 插件管理器的标题和描述 |
| [`icon.svg`](icon.svg) | 原创插件图标 |
| [`README.md`](README.md) | 英文文档 |

## 开发

不需要构建：

```sh
node --check index.js
node --check client.js
node -e "for (const f of ['package.json','locale/en.json','locale/zh.json']) JSON.parse(require('fs').readFileSync(f,'utf8'))"
```

在真实 profile 中测试时，把本目录作为本地 bundle 安装，修改后在插件页面重启插件。客户端代码是浏览器模块，模块更新后可能需要刷新页面。

## 许可证

[MIT](LICENSE)
