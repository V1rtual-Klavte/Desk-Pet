# 运行时数据与配置

本文维护配置、路径、文件布局和资源所有权。会话事件与压缩协议见[当前记忆](memory.md)，运行代际与恢复见[运行时契约](runtime-contract.md)。

## 配置与环境

Rust [AppPaths](../../crates/native-host/src/paths/mod.rs) 依据 `cfg!(debug_assertions)` 决定路径环境；Node 通过 [paths.ts](../../src/services/paths.ts) 的 `getRuntimeMode()` 获取（值来自 `get_runtime_paths` 回执，与 `ServerWelcome.runtimeMode` 同源），不以任何前端构建模式推断。

**开发（debug 构建）与生产（release 构建）的五维区分**：

| 维度 | 开发（debug） | 生产（release） |
|---|---|---|
| 数据根 | `{工作区}/data/desk-pet/`（工作区根由 debug 宿主注入，release 路径不经过它） | 宿主解析的应用数据目录：macOS `~/Library/Application Support/com.v1rtual.deskpet`；Windows `%LOCALAPPDATA%\com.v1rtual.deskpet` |
| 运行时 CONFIG | 工作区 `CONFIG-DEV.yaml`，不存在时用工作区 `CONFIG.yaml` | `data_root/settings/CONFIG.yaml`，首次启动由编译期嵌入的 `CONFIG.yaml` 模板初始化 |
| 随包资源根 | 工作区 `packaging/dist`（存在时；`dev:prepare` 摆出 node/harness/defaults 三件套），否则打包布局资源目录 | 打包布局资源目录：macOS `.app/Contents/Resources`；Windows 安装目录（可执行文件同级） |
| 随包 Node | `packaging/dist/node`（`dev:prepare` 按 [node-runtime.json](../../packaging/node-runtime.json) 锁定版本 22.22.3 暂存，版本一致则跳过） | 安装目录 `resources/node`（release CI 按同一锁定版本暂存并校验 SHASUMS） |
| Harness 产物 | `packaging/dist/harness/main.mjs`（`dev:prepare` 触发 `pnpm run build:harness`） | 安装目录 `resources/harness/main.mjs`（release CI 在 Ubuntu 构建一次、双平台打包共用） |

两种环境下运行的都是**随包 Node（锁定版本）**，不是用户机器的全局 Node；监督器握手时核对 Node 自报版本，不一致拒绝并杀进程，随包 Node 或 harness 产物缺失即宿主启动失败，不静默回落。E2E 隔离模式（debug + `DESKPET_E2E=1`）另有独立数据根与合成 CONFIG，见下文。

`CONFIG-DEV.yaml` 是完整文件，不是增量覆盖层；生产忽略工作区开发配置。原生设置窗、导入导出和运行期 getter 使用同一份配置。开发副本由用户从模板创建，不能为同步默认值而覆盖已有本地配置。

## 配置变更同步清单

[AGENTS](../../AGENTS.md#单一真相源与模块落位)要求 YAML 运行时 CONFIG 字段变更检查完整链路。新增、改名、删除，以及默认值、类型、单位或语义变化都适用；“同步”不代表各环境必须使用相同的值。环境变量、构建或测试开关按各自定义与消费者同步，不要求增加 YAML 字段或设置控件。

| 环节 | 必须核对和同步的内容 |
|---|---|
| 默认配置 | [CONFIG.yaml](../../CONFIG.yaml) 的键、类型、默认值、单位与注释；它也是首次生产初始化来源 |
| 开发模板 | [CONFIG-DEV.yaml.example](../../CONFIG-DEV.yaml.example) 的对应定义；开发端点/密钥等可保留占位值 |
| 真实开发副本 | CONFIG-DEV.yaml 是完整文件，需单独授权后更新；保留用户已有值，未同步须交付说明，不能用模板覆盖本地配置 |
| 类型与运行期读取 | [config.ts](../../src/services/config.ts) 的 Config、类型化 getter/setter 与默认逻辑；模块不复制默认值 |
| 设置显示与编辑 | 原生设置窗的字段 schema：[ui/settings/schema.rs](../../crates/native-host/src/ui/settings/schema.rs)（key = CONFIG 路径、类型/范围/枚举/字体/选择项；提交值不合法即拒绝），管理面字段在 [panels.rs](../../crates/native-host/src/ui/settings/panels.rs)；检查数值范围、枚举与单位换算 |
| 保存映射 | Node 侧 [host-requests.ts](../../src/services/native-ui/host-requests.ts) 的 `settings_commit`：`setOverride`/`normalizeSettingValue` → 一次 `flushConfig()` 原子写盘 → `reapplyRuntimeSettings`（按变更键重应用）→ `pushNativeUiState`（原生状态推送）。人格卡与激活 Profile 走各自唯一入口（`switchPersonality` / `switchActiveProfile`），不是普通 setOverride |
| 落盘与生效 | serializeConfig/flushConfig 写入同一运行时 CONFIG；声明字段是即时生效、下一 run 生效还是需重启，需要即时生效的加入 `reapplyRuntimeSettings` 或推送面 |
| 说明 | 对应 current 文档解释语义/单位/生效时机；影响用户操作时更新 README/DES，改变全局规则时更新 AGENTS |

新字段若按产品范围决定不提供设置控件，必须在对应文档说明用途与文件修改入口，不能把漏接 UI 当作默认豁免。改名/删除还需定义旧用户文件的兼容、迁移或忽略语义，清理旧 UI 映射与消费者；当前配置初始化不会自动把缺失字段与默认 YAML 深合并。

当前主保存路径为：原生设置窗控件（Rust 草稿）→ `SettingsPort`（[ui/ports.rs](../../crates/native-host/src/ui/ports.rs) 的 `settings_commit` 请求）→ Node `settingsCommit` → setOverrides → config 写队列 → `flushConfig` → `reapplyRuntimeSettings` → `pushNativeUiState`（快捷键/字体/主题/舞台/聊天列/图片预览/摆位/尺寸/自动呼出/音效十条推送，逐项口径见 [pushes.ts](../../src/services/native-ui/pushes.ts) 头部）。字段是否即时生效取决于具体消费者，不能只以事件已发出为完成依据。Profile 素材和参数有自己的保存路径，不强行塞进 CONFIG。

例如窗口冷却的 getter/CONFIG 使用毫秒，原生设置窗按各自 schema 的单位换算显示（换算点在宿主草稿边界：`ui/settings/mod.rs` 的毫秒键表，读入除 1000、提交乘 1000；schema 只声明显示单位与按显示单位收口的范围）；日志设置读取配置值，运行期才应用 dev 的 debug 覆盖。这两类边界不能混入 getter 导致保存污染。

设置改动完成后集中核对“修改 → 保存 → 文件回读 → 运行期读取 → 关闭重开设置”的往返；涉及跨窗口、模式或重启生效时一并核对对应消费者。类型检查不能发现字符串配置键漏映射或单位错误；本清单是后续变更的验收要求，不表示本轮文档修改运行了这些验证。

模块只经类型化 getter 读取。`serializeConfig()` 保留文件头注释块，正文由 js-yaml 重排，不承诺保留正文注释或原格式。

### 已退役字段

| 字段 | 状态 | 说明 |
|---|---|---|
| ~~`general.desktop.pollingIntervalMs`~~ | **已删除（不再存在该键）** | 窗口观察改为原生事件驱动（前台切换／锁屏／睡眠唤醒／会话切换触发采样），不再存在轮询间隔输入。[config.ts](../../src/services/config.ts) 无 getter、[monitor.ts](../../src/services/window/monitor.ts) 的 `setMonitorEnabled` 不再接收该值、Rust 侧无 interval 状态。**钥匙已从 [CONFIG.yaml](../../CONFIG.yaml) 与 [CONFIG-DEV.yaml.example](../../CONFIG-DEV.yaml.example)、本文件的类型定义、原生设置窗 schema（[schema.rs](../../crates/native-host/src/ui/settings/schema.rs)）一并移除**；不建兼容读取，用户文件里若残留该键按未知键忽略 |

### 对话投递字段的语义与生效时机

| 字段 | 取值 | 语义 | 生效 |
|---|---|---|---|
| `ai.conversation.defaultDelivery` | steer / followUp | 忙碌时未显式选择意图的默认投递方式（插话 / 稍后继续） | 下一次发送即读取；聊天界面的单条显式选择优先 |
| `ai.conversation.steeringMode` | all / one-at-a-time | 插话在同一安全边界前一起进入下一次请求，或逐条处理 | 每个 run 开始前下发，按运行冻结；不重排已排队项 |
| `ai.conversation.followUpMode` | all / one-at-a-time | 稍后继续的后续消息集中处理或逐条保留话题边界 | 同上 |

三个字段由原生设置窗「AI → 会话」区读取与回写、经 settings_commit 落盘，运行期只经 [config.ts](../../src/services/config.ts) 的 `conversationConfig` getter 读取；未知取值一律按保守默认（steer / all / one-at-a-time）解释，不把非法值透传给运行内核。

### 工具并行上限字段的语义与生效时机

| 字段 | 取值 | 语义 | 生效 |
|---|---|---|---|
| `ai.loop.maxParallelTools` | 1–8 的整数，默认 4 | 同时执行的只读（`shared_read`）工具数上限；效果类工具始终与其它执行互斥，不受它影响 | 每个 run 开始前下发给宿主许可所有者，运行期间不撤销已借出的额度 |

本字段不提供设置窗控件（按「设置页瘦身」边界撤下界面）：值只在 CONFIG/getter，运行期只经 [config.ts](../../src/services/config.ts) 的 `loopConfig.maxParallelTools` 读取（1–8 整数，值域与宿主所有者同口径），并发所有权仍在 [tool_permit.rs](../../crates/native-host/src/commands/tool_permit.rs)。`MIN/MAX/DEFAULT_PARALLEL_TOOLS` 与所有者的默认值和范围同值，是 YAML 兜底与校验副本，不构成第二个所有者。

非法值不静默接受：手写 YAML 的非数值按默认值、越界值收拢到最近边界（getter）；宿主许可所有者收到 1–8 之外的下发直接报错而不夹边界（上限 0 会让所有读永久排队）。降低上限暂停新获准执行，提高会唤醒有序等待项。

### 设置窗不提供的技术参数（瘦身边界）

以下键曾在原生设置窗有控件，已按「设置页瘦身」边界撤下界面（`ui/settings/schema.rs` 无对应字段，有源码级守卫）：**值保留在 CONFIG/getter，运行内核照常消费**；修改入口是运行时 CONFIG 的 YAML（或 getter 里的缺省值），不建兼容读取、不恢复控件。`ai.auxModel` 保持界面控件，不在本表。

| 字段 | 用途 | 运行期消费点 |
|---|---|---|
| `ai.contextMaxTokens` | 上下文窗口（低于 65536 在模型解析处报错，压缩按同一预算规划） | [context/builder.ts](../../src/services/context/builder.ts)、[compactor.ts](../../src/services/engine/compactor.ts)、[model-gateway.ts](../../src/services/engine/harness/model-gateway.ts) |
| `ai.thinking.effort` | 思考强度默认值（会话级覆盖走聊天侧 `chat_set_thinking_effort`） | [debug.ts](../../src/services/debug.ts) 的思考强度解析 |
| `ai.loop.maxRetry` | 生成级重试次数（0 = 关闭重试） | [harness-slot.ts](../../src/services/engine/harness/harness-slot.ts) 的 RetryPolicy 下发 |
| `ai.loop.maxToolCallsPerTurn` | 单回合工具调用上限（子代理回合规格） | [sub-agent.ts](../../src/services/agent/sub-agent.ts) |
| `ai.loop.maxParallelTools` | 只读并行上限 | 见上一节（宿主许可所有者） |
| `ai.memory.coreTokenBudget` / `ai.memory.recallTokenBudget` | 核心画像 / 召回预算（tokens） | [memory/provider.ts](../../src/services/agent/memory/provider.ts)、[harness/runtime.ts](../../src/services/engine/harness/runtime.ts) |
| `ai.memory.maxSessions` | 会话标签保留上限 | [session/store.ts](../../src/services/session/store.ts) |

### 复杂度评估字段的语义与生效时机

| 字段 | 取值 | 语义 | 生效 |
|---|---|---|---|
| `ai.plan.complexityEval` | keyword / llm，默认 keyword | 未命中关键词时是否再发一次独立模型请求自判复杂度 | 保存后下一次 `sendMessage` 即生效；`--plan` 强制触发不受它影响 |

本字段不提供设置窗控件（设置 schema 无该字段）：值只在 CONFIG／getter，运行期只经 [config.ts](../../src/services/config.ts) 的 `planConfig.complexityEval` 读取。`keyword` 下未命中关键词直接返回低分（不发起请求，复杂度判定只由关键词与 `--plan` 驱动）；`llm` 下未命中关键词再发一次独立请求自判，失败按跳过 Plan 处理并把原因写进判定结果。

### Bash 白名单字段的语义与生效时机

| 字段 | 取值 | 语义 | 生效 |
|---|---|---|---|
| `tools.bash.whitelist` | 命令名数组，出厂 CONFIG 18 项（getter 另留 15 项兜底，同值子集） | 命令首词命中、不含 shell 组合符且未命中危险/硬禁止模式时判 `NORMAL`、免确认；它是**免确认通道**而不是硬墙 —— 不在名单只意味着要走确认，命令仍可执行 | 每次风险分级即时读取；设置保存后经重应用路径生效 |

由原生设置窗「工具 → Bash」区的「命令白名单」字段读取与回写（多行文本 ↔ 标量数组的互逆换算在 `normalizeSettingValue`）、经 settings_commit 落盘；运行期只经 [config.ts](../../src/services/config.ts) 的 `toolsConfig.bashWhitelist` 读取，分级消费点是 [pi-tools.ts](../../src/services/tool/local/pi-tools.ts) 的 `classifyBashRisk`。Rust 侧不再看白名单：[bash_policy.rs](../../crates/native-host/src/commands/bash_policy.rs) 的 `enforce_bash_policy` 只有层 1 硬基线与层 2 系统路径保护，也不接收 scope / whitelist 入参，拒绝结论与名单无关。

### 陪伴控制字段

| 字段 | 默认 | 唯一来源与生效 |
|---|---|---|
| 主动消息 enabled | true | Rust SQLite `proactive_control`，不写 CONFIG；当前用户入口是 `/proactive on` / `/proactive off`（slash 命令 → Node `setEnabled` → `proactive_control` 命令），关闭即时取消 |
| `ai.humanizer.enabled` | true | 设置窗保存 CONFIG，下个回合冻结；关闭不加协议、不变换、不调度，已提交多段历史仍逐泡展示；保存后立即揭示未展示分泡（`revealAll`） |
| `ai.silentAccess.enabled` | true | 直接替换原窗口监控域，不兼容读取旧键；配置刷新后停止旧观察代际并重启许可内的观察 |
| `ai.silentAccess.staySeconds / settleMs / cooldownMs / samePageCooldownMs` | 60 / 2000 / 5000 / 7800 | 沿用窗口来源的停留、防抖和冷却，AI 设置可编辑，后两个界面以秒显示、保存毫秒 |

节奏参数归 `humanizer` 模块；主动额度、静默时段和观察预算归各领域协议／常量。配置模板、getter、原生设置窗 schema、保存映射与保存后的重应用/推送保持同步；真实 CONFIG-DEV.yaml 与已有运行时数据未在本批同步。

图片条目只保存 `deskpetImagePaths` 原路径：用户发图与 `screenshot` 工具 `show_to_user` 的截图共用这一字段（用户图片的请求视图临时读取、经当前图片处理链处理，见[工具系统](tool-system.md)的 read 边界；截图是工具结果本身带图片块、原图另存 `screenshots/`，两者都不写 CONFIG、不建图片副本）。原文件变化即体现为下一次读取的内容；路径失效明确显示不可用，不从缓存恢复副本。

### 界面主题字段的语义与生效时机

| 字段 | 取值 | 语义 | 生效 |
|---|---|---|---|
| `appearance.theme` | `brushed` / `chrome` / `verdigris`，默认 `brushed` | 产品级界面主题（拉丝金属 / 铬 / 铜绿），覆盖舞台、聊天面板、顶栏、设置窗与图层编辑器。**预设不可调**：不开放改色值，也不跟随系统深浅色（主题自己就是外观，`brushed` 与 `verdigris` 是暗、`chrome` 是浅面板 + 深紫舞台） | 保存即写回同一 cfg 并随 `flushConfig` 落盘；宿主在启动与设置保存后经桥命令 `apply_theme` 收到新值并立即重绘（命令登记在 [src/services/host/types.ts](../../src/services/host/types.ts)，收到前宿主用默认主题） |

**主题与 Profile 正交**：换 Profile 不换主题，换主题不换 Profile。Profile 不保存任何颜色或图标（见下文「Profile 是自包含闭包」）。

读取只经 `userConfig.theme`（唯一默认值 `DEFAULT_THEME` 在 [config.ts](../../src/services/config.ts)，设置窗 schema 与宿主都不复制默认值）；非法值按读取期规则收拢为默认并记一条中性诊断、**不写盘**，也不为旧取值建兼容映射。设置窗字段在 [schema.rs](../../crates/native-host/src/ui/settings/schema.rs) 的「外观 → 角色展示」区（选项与 `ui::theme::ThemeId::ALL` 有对账测试钉住）。**色值真相只在宿主** [ui/theme/tokens.rs](../../crates/native-host/src/ui/theme/tokens.rs)，Node 只传 id，不复制任何 token。视觉基准是 [theme-candidates.html](../../docs/history/design/theme-candidates.html)。

**只加载选中的主题**：token 表是三份编译期常量（没有"加载"这一步）；有代价的是**纹理**，按需程序化生成（磁盘零图片资源），同一时刻只驻留当前主题用到的那张，切主题时释放旧的（`ui::theme::release_unused_textures`）。本批未同步真实 `CONFIG-DEV.yaml`。

### 聊天图片自动预览字段的语义与生效时机

| 字段 | 取值 | 语义 | 生效 |
|---|---|---|---|
| `appearance.chatImagePreview` | 布尔，默认 false | 聊天历史的内联图片呈现：关闭（默认）时历史/滚动/切会话/初次加载只显示占位（序号/文件名/可用状态），**不读取图片字节、不解码、不生成缩略图**，点击占位仍可打开独立查看器；开启时只为当前可见消息按需加载内联预览，离开视口、切会话、收起或关闭聊天视图即释放（晚到结果按 owner/viewGeneration 丢弃） | 保存即写回同一 cfg 并随 `flushConfig` 落盘；原生聊天窗在启动与设置保存后经桥命令 `configure_chat_image_preview` 收到新值并立即生效（命令登记在 [src/services/host/types.ts](../../src/services/host/types.ts)，收到前宿主按关闭处理） |

读取只经 `appearanceConfig.chatImagePreview`（唯一默认 false 在该 getter，设置窗 schema 与消费方都不复制默认值），设置窗字段在 [schema.rs](../../crates/native-host/src/ui/settings/schema.rs) 的「外观 → 角色展示」区、保存映射走 settings_commit；宿主侧落点是 [crates/native-host/src/images/inline.rs](../../crates/native-host/src/images/inline.rs) 的 `InlinePreviewManager`（关闭零预读、只按可见集合加载）。该开关只影响聊天历史的内联呈现：模型看图（`hydrateImageMessages`/`loadRequestImage` 的请求投影）、图片选择/发送、截图、`read` 图片工具与 JSONL 里的原路径都不受它影响；独立查看器有自己的 owner/关闭动作，不依赖本开关。本批未同步真实 `CONFIG-DEV.yaml`。

## 路径与文件布局

```text
data_root/
├── settings/       生产 CONFIG 与默认资源初始化标记
├── memory/         memory.sqlite3（记忆与主动链状态库）、V1RTUAL.md（人工指令）、exports/ 与 backups/
├── sessions/       聊天正文 JSONL（JsonlSessionRepo，每会话一个文件，归属按文件头 cwd；写入以追加为主，已回收 key 的写入行由折叠清理）与 index.json 可丢弃 UI 状态
├── personality/    cards/、stages/{cardId}.json
├── profiles/       {profileId}/ 下的 Profile 与素材
├── skills/         {name}/SKILL.md（per-skill `enabled` 开关；Pi 递归遍历、根级 `.md` 也算技能、name 可缺省取父目录名）
├── screenshots/    桌宠截图（`<时间戳>.png`，用户可直接查看/删除；只保留最新 200 个，按 mtime 淘汰，无长期留存）
├── updates/        应用内更新的 staging 与安装状态（不替换数据根）
└── logs/           运行日志
```

开发构建的**运行时 CONFIG 不在数据根内**（见上表的五维区分），其余目录布局与生产一致。

Node 先执行 `initPaths()`（取 `get_runtime_paths`）；`BaseDirs` 只给真正被外部读取的目录，需要完整路径时用 `runtimePath(scope, ...segments)` 交给宿主拼接和校验。业务文件名由所属模块管理。

Rust 持有 base 的命令接收域内相对路径，例如 personality 命令接收 `stages/x.json`，不能传 `personality/stages/x.json`。通用文件 API 接收绝对路径时由 runtimePath 生成。写入需校验目标/父目录与符号链接边界，不能在 canonicalize 失败后静默退回原路径。

聊天正文以 `sessions/` 的 JSONL 保存（条目 + commit 事务，JsonlSessionRepo）；启动经会话仓库列出恢复，再用 index.json（宿主命令 `read_session_ui_state`/`write_session_ui_state`）恢复标签和未回复数；丢失 index 不丢正文。会话归属按文件头 `cwd` 判定（不是按 `--<cwd>--` 目录名猜）：数据根变更或目录编码碰撞会产生不属于当前数据根的会话，列举结果里 `cwd` 与当前数据根不同的项由列举方记一次日志（去重）留证，不静默清除 index.json 里的旧 id。格式细节见[当前记忆](memory.md)。

会话 JSONL 是 append-only 日志：帧（`pi.pending.assistant_frame`）的每次流式增量都追加一行，`list/delete` 与 `value/delete` 只追加一条删除记录，被删 key 的历史写入行不会自动消失。因此会话文件会在安全时机被**纯删除式折叠**（[session-fold.ts](../../src/services/engine/harness/session-fold.ts) 的 `foldSessionFile`）：只回收已被 `list/delete` 与 `value/delete` 删除的 key 在**最后一次 delete 之前**的全部 `list/append` 与 `value/set`；**保留行逐字不变，entryId 与 seq 不变**，entry/usage 行一个不动 —— 折叠不是删除历史。写盘前须**折叠前后重放状态摘要一致**（`sha256Text(stableSerialize(replayLogState(...)))`），不一致就放弃折叠、保留原文件（磁盘未改动）；替换走**同目录临时文件 + `rename` 原子替换**。header 不是当前支持的 v4 格式 + `storageVersion: 1` 时整文件跳过（安全降级：不抛错、不影响会话功能，首次按版本值留一条 warn）。折叠只解决体积，不改变「打开会话 = 全量读 + 逐行重放」的复杂度；成功折叠不可逆、没有回滚路径，安全防线只有摘要比对与原子替换。

触发时机：① 会话经 `releasePiSession` 关闭之后（回收主路径；先等 `session.close()` 与帧缓冲 flush 收尾再折叠，失败只留痕）；② `open` 前按需兜底（只针对未被干净关闭的会话），仅当文件超过 `FOLD_POLICY.minFileBytes` 才读全文判定。「压缩提交后」经评估不做（挂点在压缩层，需求已被前两者覆盖）。折叠失败或跳过一律不影响会话功能。

折叠阈值是源码常量 `FOLD_POLICY`（与 `foldSessionFile` 同在 [session-fold.ts](../../src/services/engine/harness/session-fold.ts)，唯一可调点），**不是** YAML 运行时 CONFIG 字段，不适用上面的配置同步清单：`minFileBytes = 512 KiB`（不超过它不探测）、`minReclaimBytes = 128 KiB` 与 `minReclaimRatio = 0.15`（可回收字节须同时达到二者），三者 AND，维持现值（用户 2026-09-28 定稿）。

Live Test 在 debug 且 `DESKPET_E2E=1` 时只接受启动脚本创建的 `test/.tmp/e2e-*` 隔离根（宿主校验真实路径），完整配置复制到该根的 `settings/CONFIG.yaml`，测试读写均走此副本；宿主在启动前还会核对私有测试通道声明的 dataRoot/configPath/结果路径与实际加载环境一致，不一致直接失败，不回退真实开发数据。退出先留存 trace/manifest/结果，再清理。隔离边界与报告位置见[测试 README](../../test/README.md)，不把测试目录当作正常用户数据位置。

## 默认资源与 Profile

[随包资源](../../resources/defaults/) 只作首次种子：宿主启动时复制到运行时目录并写入 `settings/.default-resources-seeded` 标记。运行时只读写 data_root；默认和用户 Card/Profile/Skill 没有两套编辑权限。标记存在后删除资源不会自动恢复。

设置页“恢复默认资源”调用宿主的 `restore_default_resources`（[resources_cmd.rs](../../crates/native-host/src/commands/resources_cmd.rs)），**覆盖运行时同名种子文件**，会丢弃这些文件的用户改动；种子之外的用户自建文件保留。同步是「种子里有的文件逐个覆盖或补齐」，不删除种子外的条目；Skill 的 per-skill `enabled` 就写在种子 SKILL.md 的 frontmatter 里，所以种子技能上的开关会随恢复一起回到种子值。

Profile 新建（`createProfile` 写带五层空壳 `theme.parallax.layers` 的 `profile.yaml`，并经宿主 `dir_create`（绝对路径由 `runtimePath()` 解析校验）预建 `materials/L0`…`L4` 五个空素材目录；层参数取五层缺省灵敏度表、素材为空。空壳不能省——图层编辑器按 `profile.yaml` 的层列表建层，缺 layers 时整窗无层可编辑、素材无处插入；id 取最小未占用序号）、重命名（改 `meta.name`，id 与素材不动）、导入和编辑都写入 `profiles/{profileId}/`；选择保存在 `appearance.activeProfile`。效果所有权为：

Card 管理（设置页「人格」节）走同一条运行时路径：新建以运行时 `cards/_template.md` 为骨架生成 `cards/{id}.md`（id 由显示名清洗而来，撞名加后缀，绝不覆盖已有卡）、重命名只改 frontmatter 的 `name`、编辑写回同一份文件、删除同时移除 `cards/{id}.md` 与 `stages/{id}.json`、导入按 frontmatter 的 id 落 `cards/{id}.md`（同名覆盖）、导出是这份 markdown 的原样另存；选择保存在 `ai.personality.active`。`_template.md` 被 loader 的 `_` 前缀规则排除在 Card 列表之外，只作作者模版——它同样是运行时文件，用户改过就以运行时为准，删了则「模版」面板如实报错并提示用「恢复默认资源」找回。

| 数据 | 唯一所有者 |
|---|---|
| 界面主题（三套预设） | CONFIG 的 `appearance.theme`（产品级，不随 Profile） |
| 展示模式 off/parallax | CONFIG 的 `appearance.effectMode` |
| 灵动图层全局强度 | CONFIG 的 `appearance.parallax.intensity` |
| 全局字体（家族与字号） | CONFIG 的 `appearance.font`（系统已安装字体，不随 Profile） |
| 聊天图片自动预览开关 | CONFIG 的 `appearance.chatImagePreview`（默认关闭；不随 Profile） |
| 每层素材和参数 | 当前 Profile 的 `theme.parallax.layers` |

`appearance.effectMode` 只认 `off | parallax`。手写 YAML 的其它取值（含已删除的景深 `dof`）按同一读取期规则收拢为 `off` 并记一条中性诊断，不为某个旧取值写专项兼容映射；读取只收拢内存值、不写盘，最终有效值只在设置窗「外观 → 角色展示」明确保存时落盘。

旧 CONFIG 的 parallax.layers/enabled 不覆盖 Profile。Profile 保存/切换经 `deskpet-profile-updated` 信号（Node 内）重推舞台；设置变化经 settings_commit 的保存路径生效，入口见 [profile/](../../src/services/profile/) 与 [native-ui/](../../src/services/native-ui/)。

顶栏文案（缺省「就绪」——无 owner = 空闲的中性文案，不用在线口吻；颜色留空跟随顶栏文字色）是窗口运行时状态：仲裁（owner/优先级/序列）唯一在 [services/titlebar.ts](../../src/services/titlebar.ts)，宿主只持文本快照（[ui/titlebar.rs](../../crates/native-host/src/ui/titlebar.rs)）；不随 Profile、不持久化，重启回到缺省（宿主未收到推送时保持缺省）；暂未开放界面编辑，保留接口供联动功能改写。运行过程状态（阶段提示 + 工具过程文案，Card 文案）也走这个 owner（priority 20，首条揭示 / 回合收尾释放）：过程文案的唯一显示位是顶栏，聊天窗底部只显示中性通知（用户规则 2026-10-05）。

内置默认 Profile（`DEFAULT_PROFILE = "sugar-pink"`）禁止删除：拒绝发生在 Node 的 `deleteProfile`，文案指向「恢复默认资源」，宿主的 `profile_delete` 只删目录、不加同名常量。删除当前活动 Profile 时会切回默认 Profile，默认不可用则回退到内存中其他 Profile，都没有时明确失败并提示重启应用或恢复默认资源。

切换活动 Profile 的唯一入口是 [profile/loader.ts](../../src/services/profile/loader.ts) 的 `switchActiveProfile()`：内存激活 + 写 `appearance.activeProfile` + 通知一次完成，调用方不要再自行组合 `activateProfile`/`setOverride`/`flushConfig`。设置窗对 `appearance.activeProfile` 的提交也走它（见 `settingsCommit`）。

导入 zip 时，归一化后指向同一路径的条目（含大小写不敏感文件系统下的同名不同大小写）按后写覆盖前者，被覆盖的条目列在导入结果的详情里。

Profile 是自包含闭包：图层素材只从 Profile 自身目录读取，不跨 Profile 回退；缺失时对应层停止渲染并在编辑器提示。Profile 不保存颜色或图标：界面主题是产品级三套预设（CONFIG `appearance.theme`，实现在 [ui/theme/](../../crates/native-host/src/ui/theme/)），不随 Profile。内置 Profile 共四个：`sugar-pink`（默认，`appearance.activeProfile`）、`yuki`、`profile1`（黍）与 `profile2`（void）。各自启用哪几层由它自己的 `profile.yaml` 决定，本文件不逐个复述层配置——那些值随用户在编辑器里的调整而变，实际资源与配置以[默认 Profile 目录](../../resources/defaults/profiles/)为准；同一 Profile 的各层素材应保持相同画布与主体位置。

内存只保留当前激活 Profile（含资产目录 URL）：`activateProfile()` 与 `ensureProfileLoaded()` 都会淘汰非激活缓存；设置页列 Profile 用 `readProfileMeta()` 轻量读 meta，不进缓存。

## 本地存储边界

产品运行在 Node 进程里，没有浏览器存储层：不存在 localStorage / sessionStorage 或等价的第二持久层，也不存在需要兼容清理的历史存储 key。配置真相源是 CONFIG 文件，会话真相源是 `sessions/` 的 JSONL，Profile 编辑态只存在于内存草稿（关闭窗口即丢），窗口几何与呼出状态只存在于宿主进程内存。测试 keyspace 的清理由测试宿主管理。
