# dsh-session-adopt

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：查找**在当前桌面窗口之外**创建的会话（例如 VS Code 通过 ACP 创建的会话），并把它们归置到对应的工作区；同时在侧边栏提供手动同步入口，并为浏览器刷新会话目录，无需重启 Harness。

在此之上，它还能**检测本机其他 Agent Harness 的会话**（首个适配器为 [pi](https://github.com/badlogic/pi-mono)），并把这些会话**导入为 DSH 原生会话**，按工作目录归入对应工作区。点击侧边栏的 **导入会话** 会打开选择窗口；同样的能力也通过同源 JSON 路由提供给脚本调用。

```
侧边栏
  ...
  ⚙  设置
  ⟳  同步会话   +3
  ⬇  导入会话
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
- **跨 Harness 检测**：发现其他本机 Agent Harness 的会话存储（内置 `pi`；为 Claude Code、Codex、Gemini CLI、OpenCode 预留适配器位置）。外部存储只读，绝不修改。
- **导入窗口**：侧边栏底部第二个入口，弹窗列出检测到的会话（Harness 徽标、标题、工作目录、消息数、模型、目标工作区），可多选一键导入，逐行显示结果，中英文文案。
- **原生会话合成**：把外部对话转换为经过校验的 DSH v4 持久会话（turn/step、工具调用与结果、标题）；导入过程中不调用模型。
- **创建工作区并归入**：导入会话按规范 `cwd` 归入已有工作区；显式导入时缺失的工作区会被创建。
- **幂等导入**：确定性会话 id，同一外部会话重复导入会报告“已导入”，不会产生重复会话。
- **可脚本化 API**：带鉴权围栏的 `/session-import/*` 路由，既服务弹窗，也可由本机脚本调用。
- **中英文界面**：跟随 Harness 的语言设置。

## 前置条件

- 使用 Web 或 Desktop profile，并且该组合挂载了 Workspace 插件和 Web 侧边栏；
- 启用了会话持久化（随附的 JSONL 后端即可）；
- 插件没有 npm 依赖，只使用 Node 内置模块和 [`index.js`](index.js) 中列出的 Harness 服务：`webServer`、`connection`、`sessionPersistence`、`workspaceRegistry`、`sessions`；
- 跨 Harness 导入还需要：本机存在可读取的外部会话存储。内置适配器支持 pi（默认 `~/.pi/agent/sessions`，可用 `PI_CODING_AGENT_SESSION_DIR` / `PI_CODING_AGENT_DIR` 覆盖）；其他 Harness 需要在 [`import/adapters/`](import/adapters/) 下提供适配器模块。

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

### 通过 dsh CLI

本包的 `package.json` 声明了 `dsh.bundle` manifest，因此可以用 profile 包管理器一条命令完成安装与
bundle 选择：

```sh
dsh plugin --profile web add https://github.com/FrozMN/dsh-session-adopt
```

安装后重启 profile（或桌面应用）即可加载新 bundle。同一个命令也接受本地目录，便于开发，例如
`dsh plugin --profile web add /绝对路径/dsh-session-adopt`。目录安装会以链接方式装入 profile，
之后的修改只需要重载插件。

### 更新

替换包文件（或拉取仓库）后，在插件页面重启该插件即可。本插件是纯 ESM bundle，无构建步骤。

## 使用

| 操作 | 结果 |
|---|---|
| 点击 **同步会话** | 全量扫描（含较早的未归置会话），然后刷新会话列表 |
| 悬停按钮 | 显示上次同步时间、归置数量或失败原因 |
| `+N` 徽标 | 最近一次同步新归置的会话数 |

按钮注册在 `sidebar.footer.action` 槽位，位于设置入口旁边；侧边栏展开和收起为图标栏时都会显示。

## 跨 Harness 会话导入

### 在侧边栏中使用

1. 点击 **导入会话**（第二个底部入口，位于 **同步会话** 下方）；
2. 弹窗按 Harness 分组列出所有检测到的外部会话：Harness 徽标、标题、工作目录、消息数、模型以及将落到的目标工作区（`→ 已有工作区`，或 `→ 新工作区: /path`）；
3. 勾选一个或多个会话（或 **全选**），点击 **导入选中**；
4. 每一行会显示结果：已导入（新 DSH 会话 id 与工作区）、已导入过，或失败原因。会话目录会刷新，工作区快照通过 Harness 的 `workspace.follow` 流更新，无需刷新页面。

重复导入按会话身份（而不是标题）跳过，因此同一外部会话导入多次也不会重复。

### 通过脚本/其他工具使用

所有路由与 Harness 其他接口一样，受 Host/Origin 围栏与浏览器会话 Cookie 保护；只接受 `application/json`，且**不接受任何文件系统路径**（选择项是扫描返回的不透明 key）：

| 路由 | 方法 | 用途 |
|---|---|---|
| `/session-import/sources` | `GET` | 适配器清单：id、标题、可用性、根目录 |
| `/session-import/scan` | `POST` | 扫描外部存储；body `{}` 或 `{ "adapterIds": ["pi"] }` |
| `/session-import/import` | `POST` | 导入选中候选；body `{ "selections": ["<candidateKey>", …], "workspace": "auto" }` |
| `/session-import/status` | `GET` | 配置、进行中标记、最近一次扫描/导入摘要 |

`workspace` 也可以是 `{ "kind": "existing", "workspaceId": "…" }` 或 `{ "kind": "new", "cwd": "/abs/path" }`；默认 `"auto"` 按规范 `cwd` 匹配已有工作区，必要时创建。一个请求是一批选择，HTTP 返回 200，并在 `imported` / `skipped` / `errors` 数组中给出逐项结果；Host 进程内串行执行。

### 适配器

适配器是 [`import/adapters/`](import/adapters/) 下的零依赖 ESM 模块，导出 `id`、`title`、`available(ctx)`、`listSessions(ctx)` 与 `readSession(ctx, key)`。`listSessions` 只返回元数据（扫描阶段绝不读取对话内容）；`readSession` 返回规范化对话（`user` / `assistant` / `tool` 消息，`text`、`reasoning`、`tool-call` 内容块），由 Host 转换为原生会话日志。内置 `pi` 适配器覆盖 pi 会话格式 v1–v3，包括分支选择（取活跃叶子路径）、token 用量与工具结果；本版本中图片会降级为 `[image]` 占位文本。新增适配器无需改动 Host。

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
    importEnabled: true
    maxMessages: 4000
    maxCandidates: 500
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
| `importEnabled` | `true` | 是否挂载跨 Harness 导入路由与侧边栏弹窗 |
| `maxMessages` | `4000` | 单个导入会话允许的规范化消息上限；超出会以明确的逐项错误拒绝 |
| `maxCandidates` | `500` | 每次扫描返回给弹窗的候选上限（Host 缓存仍保留全部） |

修改会重启插件，同时重新建立定时器和启动扫描。导入路由是 Host Web 服务器上的精确路径，不随 loader 行 id 变化。

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

### 导入侧

1. **检测**：每个适配器报告根目录并列出候选会话（只读头部行和文件状态；扫描阶段绝不读取消息内容）。Host 规范化候选、规范化 `cwd`、匹配现有工作区，并以不透明 key 缓存全部候选。
2. **选择**：弹窗回传不透明候选 key；导入路由只从该缓存解析，请求体不包含文件系统路径。
3. **转换**：`import/events.js` 由规范化对话合成 v4 事件日志：每条用户消息一个 turn，每个 assistant 响应一个 step，`tool/call` 与 `tool/result` 成对出现；首个 surface 事件是受保护的空 `system/message`（否则会话首次恢复会不可读）；追加 `session/title`；对外部已宣告但没有结果的工具调用补一条 `TOOL_OUTCOME_UNKNOWN` 修复结果。
4. **写入前校验**：候选日志先经过已安装 `Session` 的恢复路径（`ctx.sessions.prepare()` + 生成的 seed）校验，运行中的 Harness 会拒绝的转换永远不会落盘。
5. **持久化**：通过 `ctx.sessionPersistence.create() / append() / flush()` 写入，会话 id 是由 `(harness, 外部会话 id)` 推导出的确定性 `session-<uuid5>`；这正是无需额外台账即可幂等导入的关键。
6. **归置**：把会话规范 `cwd` 与 `ctx.workspaceRegistry.list()` 匹配；显式导入时缺失的工作区会被创建，然后 `workspace.attachSession(id)` 通过常规 Workspace follow 流发布变更。
7. **刷新**：弹窗在导入完成后调用客户端会话目录刷新。

导入后的会话就是普通 DSH 持久会话：可以打开、重命名，也可以在 Harness 中继续对话（恢复后的 agent loop 会自行追加 turn/step 与 request header）。

### 工作区创建策略

为了避免每次重启都把用户主动删除的工作区重新创建出来，定时/启动扫描只对**插件进程启动后新产生**的会话自动创建缺失工作区；显式手动同步允许为更早的历史创建。`cwd` 已有工作区的会话无论新旧都会归入。

## 安全

- 所有路由仅限同源，并在执行任何工作前经过 Harness `connection` 信任围栏；未认证请求返回 `401`，跨站请求返回 `403`。
- 发现阶段不读取外部会话内容，也绝不修改外部会话存储；只有显式导入才会读取一个外部会话，并通过 `ctx.sessionPersistence` 写出一份**新的 DSH 原生会话日志**。任何请求都不接受文件系统路径。
- 导入路由同样经过该围栏：`ctx.connection.requestRejection(req)` 在执行前完成 Host/Origin 与浏览器登录 Cookie 校验；请求体有上限（扫描 16 KiB、导入 64 KiB），必须是 `application/json`，且只携带适配器 id 与不透明候选 key。
- 外部会话存储以只读方式打开；扫描只读元数据（头部行、文件状态），只有显式导入才读取对话并在本地转换、写出新的 DSH 会话。导入路径不发起任何网络请求，也不改写任何外部文件。
- 导入只写工作区成员关系和新创建的会话日志；失败信息逐项、有界，Host 日志不包含消息文本。
- 插件没有 npm 依赖，安装不会执行第三方代码。

## 限制

- 只能发现**已持久化**的会话；另一进程刚创建、尚未落盘的会话要等下一次扫描。
- 工作区匹配是**规范 `cwd` 精确匹配**，不做父目录包含匹配。
- 默认跳过 `origin: "subagent"` 和 `migration-required` 会话。
- 不会把另一进程正在写入的会话内容实时流到已打开页面；它解决发现、归置和目录/元数据刷新，打开会话时读取的是最新持久日志。
- 两个进程同时写同一个会话仍属于 Harness 本身不支持的使用方式。
- `+N` 徽标和上次同步提示只存在于当前页面，刷新后重置。

跨 Harness 导入还有以下边界：

- **导入的是快照。** 外部会话只读取一次；之后外部 harness 追加的轮次不会同步。同一外部会话重复导入是幂等的（确定性 DSH id），会返回 `already-imported`；“刷新导入”属于后续能力。
- **恢复（继续对话）导入会话会追加 Harness 事件。** 首次恢复会以写方式打开日志、写入恢复种子标记（未打标签的 `session/end-seed {}`）、记录当前模型/预设/权限/沙箱状态、开启下一轮，并记录当前 system prompt（`in-history` 路由追加在导入历史之后，其它路由重写受保护的首个 system 节点）。导入事件不会被改写。后续每次冷恢复可能再追加一个未打标签的 `session/end-seed {}`；这些标记无害（只有 `{ inherited: true }` 才定义 fork 切点），也不会进入模型上下文。
- **Harness 没有删除/修复会话的 API。** 导入器会在首次 append 之前把完整产物走 Harness 恢复路径校验，并以单个批次写入；写入前的失败不会留下任何东西。一旦写入即为持久日志：若导入后来被证明不可读，无法原地修复——必须先删除该会话目录/工作区归属（或由用户工具删除会话）再重新导入，因为确定性 id 会让普通重导入按 `already-imported` 跳过。
- **外部记录是规范化转换，不是逐字复刻。** 没有结果的工具调用会补一条中断错误结果（`TOOL_OUTCOME_UNKNOWN`）；没有对应调用的孤立工具结果会被丢弃（计入统计）；图片降级为文本；导入的 assistant reasoning 不携带 provider replay 元数据——模型能看到内容，但对导入轮次的 provider 流/前缀重放只是尽力而为；当前 DSH 预设未定义的导入工具名会渲染成通用工具卡片。
- **导入会话按当前 DSH 配置继续**：首次恢复使用默认 Agent 预设和当前默认模型（除非会话自带选择）；system prompt、可用工具、权限/沙箱策略均来自 Harness，而不是原 harness。
- **导入时外部 `cwd` 必须可解析**（工作区匹配使用规范化路径）；工作目录已不存在的会话会被拒绝，而不会错误归入无关工作区。
- 导入事件保留外部时间顺序（截断到当前时间、单调不减）；只有 `header.createdAt` 是导入时间，侧边栏排序依据它。标题取自外部标题/首条提示，最多 60 个码点。
- 外部存储只读打开；发现阶段不读取对话内容；所有导入路由都是同源、带鉴权围栏的 JSON 路由，且不接受任何路径参数。

## 文件

| 文件 | 用途 |
|---|---|
| [`index.js`](index.js) | Host 插件：归位扫描、导入路由、工作区归置、定时器 |
| [`import/index.js`](import/index.js) | 跨 Harness 导入编排：扫描 → 转换 → 持久化 → 工作区 |
| [`import/events.js`](import/events.js) | 规范化对话 → 经校验的 DSH v4 事件日志 |
| [`import/ids.js`](import/ids.js) | 确定性会话 id（UUIDv5），支撑幂等导入 |
| [`import/registry.js`](import/registry.js) | 适配器扫描、候选缓存、工作区提示 |
| [`import/adapters/`](import/adapters/) | 适配器契约与内置 `pi` 适配器 |
| [`client.js`](client.js) | 浏览器插件：侧边栏动作（同步 + 导入弹窗）、语言词典 |
| [`test/`](test/) | 事件构建与导入编排的自包含测试 |
| [`cordis.patch.yml`](cordis.patch.yml) | Loader 行和默认配置 |
| [`locale/en.json`](locale/en.json)、[`locale/zh.json`](locale/zh.json) | 插件管理器的标题和描述 |
| [`icon.svg`](icon.svg) | 原创插件图标 |
| [`README.md`](README.md) | 英文文档 |

## 开发

不需要构建：

```sh
npm run check   # 对所有 host/client 模块执行 node --check
npm test        # node --test test/*.test.mjs import/adapters/*.test.mjs
node -e "for (const f of ['package.json','locale/en.json','locale/zh.json']) JSON.parse(require('fs').readFileSync(f,'utf8'))"
```

`pi` 适配器测试会读取真实的 `~/.pi/agent/sessions`（只读），不存在时自动跳过。

在真实 profile 中测试时，把本目录作为本地 bundle 安装
（`plugin_manager install_bundle /绝对路径`）。目录安装会以链接方式装入 profile，因此修改 Host 代码后
只需把插件行/bundle 关开一次（无需重启应用）；客户端代码是浏览器模块，更新后刷新页面（或等待
client HMR 帧）即可。导入器在信任任何转换之前会用已安装的 `Session` 恢复路径校验整份候选日志，
仓库测试则固定事件不变量。

## 许可证

[MIT](LICENSE)
