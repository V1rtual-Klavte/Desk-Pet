---
document_type: archived_plan
status: archived
archived_at: 2026-09-26
superseded_by: ../../plans/active/未完成工作与已知缺口.md
updated_at: 2026-09-26
reviewed_at: 2026-09-24
scope: skill-pi-migration, tool-surface, dual-mode-removal
---

> **归档（2026-09-26 完成并通过发布门禁）。** 检查点证据：dataset `2026-09-26.2`、8 份契约、`pnpm run test:release` 严格模式 + `repeat: 3` 得 **441/441 trial，0 failed / skipped / timeout**；真实本地 `CONFIG-DEV.yaml` 的同步在用户明确授权下完成。替代入口：**当前行为以源码与 `docs/current/` 为准**（运行时契约、工具系统、运行时数据等），剩余未完成工作见[未完成工作与已知缺口](../../plans/active/未完成工作与已知缺口.md)。正文与当时证据原样保留，不再作为待办入口。

# Skill 与 Tool 收敛及模式统一方案

本文是**实施前的方案 + 决策定稿 + 覆盖矩阵 + 实施工单**：决策已定，代码未动。全仓审查已完成两轮，结论已就地并入正文（不保留勘误层）。实施完成后按惯例归档到 `history/implementation/`，active 只留跳转与后续事项。当前行为仍以源码与 `docs/current/` 为准。

---

## 1. 背景与目标

三件事合并成一批：

1. **Skill 换成 Pi 的原生实现**。现在是一套自建实现（Rust 读有界 frontmatter → TS catalog/TTL/generation → 自制 `<available_skills>` 块），只用到「模型自己 read 正文」一条隐式路径；Pi 提供的 loader（`loadSkills`）、披露（`formatSkillsForSystemPrompt`）、显式调用（`setResources` + `accept({kind:"skill"})`）三层全部没用上。
2. **移除 pet/assistant 双模式**。用户裁定：现在统一成一套行为，未来另做两个差异化版本；开发阶段不保留兼容层。
3. **Tool 面优化与补齐**：read 图片处理、MCP 结果回读、时间注入、`system_info` 改写、新增窗口信息工具。

**硬约束**：Skill 与 Tool 必须**实时**——磁盘或配置一变，下一个回合就生效，不靠 TTL、不靠重启。

---

## 2. 实测证据

探针脚本见 `/tmp/deskpet-skill-probe.mjs`（用 Pi 的 `NodeExecutionEnv` 实跑，200 个合成 skill；2026-09-24 重跑复核，脚本在仓库外的临时目录，归档前需一并留存或重写）：

| 场景 | 常驻堆内存 | ExecutionEnv 调用 | 加载耗时（本地 fs） | 注入 system prompt |
|---|---|---|---|---|
| 200 × 正文 2KB | +1.15 MB | 1809 次 | 58 ms | 50.1 KB ≈ 19,438 tokens |
| 200 × 正文 8KB | +2.06 MB | 1809 次 | 57 ms | 50.1 KB ≈ 19,438 tokens |
| 200 × 正文 32KB | +5.80 MB | 1809 次 | 70 ms | 50.3 KB ≈ 19,488 tokens |
| 对照 20 × 2KB | +0.73 MB | 189 次 | 15 ms | 5.3 KB ≈ 2,018 tokens |

调用次数拆解：`fileInfo` 805 + `joinPath` 603 + `listDir` 201 + `readTextFile` 200（每个 skill 目录要探 3 个 ignore 文件、列一次目录、读一次正文）。

**三条结论**：

- **内存不是问题**：即使 200 个 32KB 正文的 skill，常驻增量也在 6 MB 以内。
- **真正的代价是每回合的清单 token**：约 97 tokens/skill，与正文大小无关，且 Pi 的格式化函数**没有上限**。
- **IPC 是放大项**：Node 本地 58 ms，换成 `TauriExecutionEnv` 时 1809 次全是 IPC 往返（**估算** 0.5–3.6 秒，未实测）；现状的 Rust 单扫只需 1 次 IPC。

现值对照：`MAX_PROMPT_CHARS = 8 * 1024`（`loader.ts:14`）只装得下约 31 个 skill，**第 32 个起静默丢弃**（`loader.ts:179` 的 `break`，无提示）。

---

## 3. 决策定稿

| # | 决策 | 要点 |
|---|---|---|
| 1 | **加载** | 用 Pi `loadSkills`；刷新由**每回合指纹核对**驱动（1 次 Rust IPC 扫 mtime/size），变了才重载 → 等价实时，稳态 1 IPC/回合 |
| 2 | **披露** | `formatSkillsForSystemPrompt` + 外层预算截断；超限 `log.warn` 报「丢了几条」，不再静默 |
| 3 | **字段** | 只留通用 `name`/`description`（+ Pi 原生 `disable-model-invocation`）；删 `invocationPolicy`、`capabilityTags`（生产零消费者）。新增自有 `enabled`：写进 SKILL.md frontmatter，由我们的 store 读取过滤（缺省 `true`） |
| 4 | **显式调用** | `{kind:"skill"}` + `/skill <name> [额外指示]` 斜杠命令。**技能正文不做请求投影**：正文按 `<skill name="…">` 形态常驻请求视图（比今天经 `read` 被 L0 缩成地址**更贴技能语义**）；代价登记为已知成本（§8.4），实测真嫌大再启用投影 |
| 5 | **模式** | 完全移除 pet/assistant；`general.mode.assistant` 全链删除 |
| 6 | **权限裁决重写** | `NOWAY→deny`；`SAFE→allow`；`NORMAL→allow`；`DANGER→safetyMode`。删 `lightweightPolicy`。**逐工具重定级**：`clipboard_read`、`agent_spawn`、**MCP 工具** 由 NORMAL 提为 **DANGER**；`pi-bash` 白名单命令保持 NORMAL（→ allow） |
| 7 | **bash 白名单** | 从「硬墙」降级为「免确认通道」：删 Rust `BashScope`/`enforce_whitelist`/`first_control_syntax`；保留层 1 硬基线 + **`enforce_no_catastrophic_write` 升为唯一层 2**（原仅 Assistant 生效）+ 凭据拦截；TS `classifyBashRisk` 继续用白名单做 NORMAL/DANGER 分级 |
| 8 | **工具与能力开关** | **内置工具不做任何开关**（read / write / edit / bash / system_info / read_session_event / window_info / app_open / clipboard_read / clipboard_write / agent_spawn 全部恒暴露），边界交给权限裁决。**能力控制面下沉到单项**：删 `tools.file.writeEnabled`、**删 `tools.mcp.enabled` 总闸**、**删 `tools.skill.enabled`**；MCP 按**每服务器 `enabled`** 控制（UI 已存在，本批只删总闸），Skill 按**每技能 frontmatter `enabled`** 控制（缺省 `true`）。「全部关掉」即为未启用。**Skill 的生效默认随之从「关」变「开」**：`tools.skill.enabled` 原默认 `false`，删除后目录里有就生效，用户逐项关闭或删目录即可 |
| 9 | **压缩摘要** | `SUMMARY_MODE_INSTRUCTIONS` 两套合并为一套（文案见 §8.1） |
| 10 | **read 图片** | 长边 ≤1568px 重编码；BMP→PNG；小图原样；失败回退原图（不再静默省略） |
| 11 | **MCP 回读** | 删 `MAX_MCP_RESULT_CHARS` 一次性截断，改走「全文落会话条目 + L0 请求投影按 eventId 缩短」；条目写盘受 `TauriExecutionEnv` 既有的 5 MB 单文件上限约束，超限的处置见 §8.8 |
| 12 | **时间** | 注入动态提示（**不做工具**）：每回合都要用的信息，不该付一次工具往返与调用额度 |
| 13 | **system_info** | 改写为「运行环境」：OS / 架构 / CPU 核数 / **总与可用内存** / bash 默认工作目录；不再重复永不变的信息。**需改 Rust**：`SystemInfoResult` 现无可用内存字段，且 `get_memory_info()` 的 macOS 分支现在只算 used，三平台口径需补齐 |
| 14 | **窗口信息** | listener 缓存最近一次 `window-changed` payload 并导出 getter → 新增只读工具；`windowMonitor.enabled=false` 时如实返回「未开启」，不编造 |
| 15 | **交付** | **一次全做完再验证**（用户裁定）。§6 的阶段划分只表达**依赖顺序**，不设独立门禁；门禁统一在 §7 |
| 16 | **子代理不派生** | 子代理禁止生成子代理：在唯一入口 `runPiSubAgent` 剥离派生型工具（现只有 `agent_spawn`），**在 `input.tools` 上过滤**，不在各调用点维护第二份白名单。子代理本身的能力面不变（`pi-read` + `local-system-info` + `pi-bash`） |

### 决策 6 是相对今天的**放宽**，不是收紧

今天 `permission.ts:98-114` 的 `standardDecision` 里，assistant 支只有两条出路：`DANGER && just_do_it` → allow，其余一律 `ask`。**NORMAL 在 assistant 下没有任何 allow 路径**。统一后 NORMAL 一律 allow，原助手用户的 `pi-bash` 白名单命令、`clipboard_read`、`agent_spawn`、MCP 工具会从「每次都问」变成「从不问」——这正是逐工具重定级（把后三者提为 DANGER）的理由。两处限定：`permission.ts:174` 的会话授权复用能让**同参重放**直接 allow；工具自己声明 `defaultDecision: "deny"` 时是 deny 而非 ask。

### 决策 7 的后果要说清

删掉 pet 层 2 后，**Rust 不再拦 Shell 组合符**。组合语法只在 TS 被判为 DANGER，`just_do_it` 下自动放行；`first_control_syntax` 随之成为死代码（阶段 0 一并删除）。`AGENTS.md:134`「Rust 保留最终路径与 Bash 安全基线，助手模式不能关闭」的措辞需据实改写为「层 1 硬基线 + 系统路径保护 + 凭据拦截不可关闭」。

### 决策 8 的必然连带（删总闸必须同时做，否则默认行为翻转）

`CONFIG.yaml` 现状是 `mcp.enabled: false`（总闸关）+ `builtin.filesystem.enabled: true`（单开，`args` 指向 `/`）+ `builtin.playwright.enabled: true`。**今天真正关住 MCP 的是总闸，不是每服务器开关。**删掉总闸后，下一次启动会自动挂载「对 `/` 的文件系统访问」与 Playwright。真实本地 `CONFIG-DEV.yaml` 同样是总闸 `false` + 两个内置服务器 `enabled: true`，处境相同。

→ 必须同时把 `CONFIG.yaml` 与 `CONFIG-DEV.yaml.example` 里 `builtin.filesystem` 与 `builtin.playwright` 的默认 `enabled` 改为 `false`，让「删总闸」保持今天**实际生效的默认**（全关）。真实本地 `CONFIG-DEV.yaml` 需单独授权后同步，未同步时在交付中说明。

### 决策 3 的连带：Skill 的 name 规则随之放宽

现状 `loader.ts` 要求 frontmatter 有 `name` 且必须等于目录名，不等就跳过。Pi 的口径是 `name = frontmatter.name || 父目录名`，且 `name !== 父目录名` 只产生一条 **diagnostic 警告**、不阻止加载（`skills.js:221-243`）。改用 Pi loader 后，**没有 `name` 的 SKILL.md 从「被跳过」变成「合法」**——目录名即技能名。这是用户可见的放宽，需同步 `runtime-data.md` 的目录布局说明。

### 明确不做（附理由）

- **`getMemo`/`setMemo` + `checkpoint: true`**：没有任何工具声明 `replay: "safe"`，无消费者；FIX-16 登记保持有效。
- **`addedToolNames`**：Pi 的实现是**持久改写 lane 的 `activeToolNames`**（`harness/runtime/drive/tool-placement.js` 里 `setValue(laneConfig(...))`），与「回合冻结工具集 + 每回合 `setActiveTools`」直接打架，机制在本仓是死的；启用等于承认工具集可被一次调用结果改写。
- **`SessionSearchService`（会话检索）**：新功能而非优化，且与 P6 记忆系统契约重叠；将来要做时采用 Pi 的接口形状并由记忆那条线统一设计。
- **`BashToolOptions.commandPrefix` / `prepare`**：当前无具体需求（cwd 显式传、shell 选择在 Rust 侧）；以后要注入 env 时再启用。
- **`entryProjectors` / `toProviderMessages`**：保持上游默认。技能正文按决策 4 不投影，本批**不需要**这两个钩子。
- 独立 `ls` / `file_search` / `http_get`（目录列举走 bash、联网走 MCP，均已有裁定）；截图与屏幕图像理解（DES 明确不具备）。

> 附注一：`lightweightPolicy: "deny"` 全仓**零生产者**，`registry.ts:78` 的过滤分支永不移除任何工具——删它是 no-op，不要当成「活的过滤逻辑」来描述（该分支本身可达：`sub-agent.ts:142`、`runtime.ts:920/1771/1858` 都会走 `m === "pet"`）。
>
> 附注二：`TOOL_POLICY_VERSION`（`types.ts:29`）自带的文档写明「策略字段含义变化时递增」。决策 6 改变了安全等级到裁决结果的映射语义，**本批把它递增到 2**。因为删 `mode` 已经让所有 `policyHash` 变化，递增不再产生额外损失。

---

## 4. 本轮不动的面（反向边界）

用于收敛爆炸半径与防止顺手扩大范围。**以下面不因本批而改**；若实施中发现必须动，先在方案里补一条决策，不要就地改：

- **Harness 驱动与收尾链路**：`driveAdmitted` → `executeDrive`（审计 flush、流收尾、队列归还、失败兜底）一行不改；技能准入同样先落盘——`admitInput` 的注释（`harness-slot.ts:1035-1037`）已写明「accept 即把用户条目提交进会话文件」，Pi 的 `lane.js:349-365` skill 分支正是在 `accept` 内部构造并提交那条 `role:"user"` 消息，符合「先落盘再投递」不变量。
- **`entryProjectors` / `toProviderMessages`**（FIX-13 前两条）：保持上游默认。
- **工具恢复的 memo 持久位**（FIX-16）：不实现。
- **会话正文真相源**：JsonlSessionRepo 的 commit 事务写入、lane 持久 inbox、`sessions/index.json` 只存可丢弃 UI 状态。
- **记忆系统（P6）与 `MemoryProvider` 边界**：压缩摘要、工具结果、主动消息、助手台词都**不得**晋升为用户事实。
- **插话双模式（steer / followUp）**：与 pet/assistant 无关。`AGENTS.md:32`、`runtime-contract.md:18/:35` 里的「双模式」指投递意图，**不是**本批要删的模式，勿误改。
- **Profile / Card / 变量池语义**：RUNTIME_DATA 剥离、`whenText` 自然语言指引、`getStagePrompt` 取文案链路（`/skill` 只**新增** key，不改既有机制）。
- **Rust 路径边界**：`AppPaths`、`runtimePath`、`runtimePath()` 校验、`is_credential_path` 共享规则文本。
- **工具并行与许可**：`execution-permit.ts`、Rust `tool_permit.rs` 许可池、`ai.loop.maxParallelTools` 语义。
- **MCP 协议本身**：stdio 传输、`includeTools`/`excludeTools`、按 run 借用/释放的生命周期。
- **外观 / 音效 / 效果模式**：`appearance.effectMode`、Profile 的取景与焦点参数。
- **同名不同义的 `mode`**（删字段时的误伤面，实施前先读这一条）：
  - `general.popup.mode`（`config.ts:62`）、`ai.safety.mode`（`:134`）、`appearance.effectMode`
  - 计划确认模式 `auto | stepByStep`（`plan-confirmation.ts:19`、`runtime.ts:1232 stepMode = decision.mode`、`runtime.ts:1203` 注释）
  - 错误覆盖层 `errorsConfig.overlay.mode`（`error/global.ts:54-56`）
  - **`agent_spawn` 的工具参数 `mode: fork | team`**（`agent-tool.ts:26-30`）——与 `ToolDef.mode` 同名字段，就在本批要改的文件里，**必须保留**
  - Rust `personality_fs_cmd.rs` 的 `resolve_personality_path(relative, mode, paths)`

---

## 5. 覆盖矩阵

**读法**：`动作` 列取 `删` / `改` / `新` / `查`（查 = 仅核对不改）。行号均已逐行核对。

### 5.1 工具与权限（生产代码）

| 文件 | 位置 | 动作 | 依据 |
|---|---|---|---|
| `src/services/tool/types.ts` | `:11` 注释（提到模式） | 改 | 决策 5 |
| | `:12` `ToolMode` | 删 | 决策 5 |
| | `:14` `LightweightPolicy` 的文档注释 | 删 | 决策 6 |
| | `:15` `LightweightPolicy` | 删 | 决策 6 |
| | `:29` `TOOL_POLICY_VERSION` → `2` | 改 | 决策 6 的语义变化（§3 附注二） |
| | `:47-48` 注释（提到 lightweightPolicy） | 改 | 注释随字段 |
| | `:81` 注释、`:82` `ToolContext.mode`（必填） | 删 | 决策 5 |
| | `:138` `lightweightPolicy` 的文档注释、`:139` 字段 | 删 | 决策 6 |
| | `:144` 注释、`:145` `ToolDef.mode` | 删 | 决策 5 |
| `src/services/tool/policy.ts` | `:25` `LIGHTWEIGHT_POLICIES` 集合 | 删 | 决策 6 |
| | `:69-71` 注释（论证 lightweightPolicy） | 改 | 决策 6 |
| | `:74` `SAFETY_LEVELS` 校验 | **保留** | 与 lightweightPolicy 同函数但不同字段 |
| | `:75-77` `lightweightPolicy` 校验 | 删 | 决策 6 |
| | `:113` `mode: tool.mode` 进入 `toolPolicyFingerprint` | 删 | **全局连带**：删后所有工具 `policyHash` 变化 → 既有授权失效（§8.5） |
| `src/services/tool/registry.ts` | `:2` 头注释「按模式注册/查询/注销」 | 改 | 决策 5 |
| | `:9` `generalConfig` 导入 | 删 | `:74` 去默认值后悬空 |
| | `:35` `log.debug(…, tool.mode)` | 改 | 字段删除 |
| | `:64-69` `actionCategoryOf` 的 `_default` 兜底 | 查 | 决策 8：`read_session_event` 仍不在注册表，兜底路径不变 |
| | `:73-83` `getToolsForMode()` 的模式过滤 | 改 | 决策 8：改为「全部已注册工具」；函数名与签名随之收敛（建议删函数、在调用点用全部已注册工具） |
| | `:74` 读 `generalConfig.assistantMode` | 删 | 决策 5 |
| | `:78` pet 的 `lightweightPolicy === "deny"` 过滤 | 删 | 决策 6（**零生产者，永不移除任何工具**） |
| | `:86` `getToolDeclarations(mode?)` | 改 | 随上 |
| | `:106-123` `registerDefaultTools`（注释「轻量模式」） | 改 | 改名/改注释为「基础工具」，并吸收助手工具的注册内容 |
| | `:126-146` `registerAssistantTools` / `unregisterAssistantTools` | 删 | 决策 8：全工具恒注册 |
| `src/services/tool/index.ts` | `:10` 导出 `ToolMode` | 删 | 决策 5（类型删除后此导出行编译失败） |
| | `:14` 导出 `TOOL_POLICY_VERSION` | 查 | 常量保留 |
| | `:46` 导出 `getToolsForMode`、`:47` 导出 `getToolDeclarations` | 改 | 随 5.1 registry |
| | `:52-53` 导出 `registerAssistantTools` / `unregisterAssistantTools` | 删 | 决策 8 |
| `src/services/tool/local/pi-tools.ts` | `:14` `toolsConfig` 导入 | 改 | 只保留 `bashWhitelist` |
| | `:27` `createEnv(mode)` | 改 | `TauriExecutionEnv` 去 mode 后变无参 |
| | `:28` `createReadTool<{env}>()` | 改 | 决策 10：接 `{ imageProcessor, autoResizeImages: true }`（processor 形状见 §6 2.1） |
| | `:33-36` `writeBaseLevel()` 读 `fileWriteEnabled` | 改 | 决策 8：改为常量 `DANGER` + 路径分级 |
| | `:39/:51/:63/:74` `ctx => createEnv(ctx.mode)` | 改 | `ToolContext.mode` 删除后改无参 |
| | `:53/:65/:76` 三处 `lightweightPolicy: "confirm"` | 删 | 决策 6 |
| | `:104` 注释、`:113` 注释（「避免落到陪伴模式的 confirm 分支」） | 改 | 注释随决策 6 |
| | `:105-115` `classifyBashRisk` | 查 | 决策 7：白名单继续用于 NORMAL/DANGER 分级，**逻辑不改** |
| `src/services/tool/local/system.ts` | `:3` 头注释、`:19` description | 改 | 决策 13 |
| | `:28` `mode: "pet"` | 删 | 决策 5 |
| | `:29` `actionCategory: "os.info"` | **保留** | `ActionCategory` 是闭合联合；新增类别会连带 `stages-prompt.md` 四处 + `stages-cache.ts:65/:382` + `validateStages`（见 §8.9） |
| | `:36-56` handler 输出字段 | 改 | 决策 13。**注意分工**：总/已用内存来自 Rust 的 `system_info`；**可用内存必须来自 Rust**（TS 侧无此字段）；bash 默认 cwd 由 TS 侧取 `TauriExecutionEnv.defaultCwd()`，不是 Rust 返回值 |
| `src/services/tool/local-extra/app.ts` | `:2` 头注释「助手模式工具」、`:21` description（含「助手模式专用」） | 改 | 决策 5（`:21` 是模型可见文案） |
| | `:32` `mode: "assistant"` | 删 | 决策 5/8 |
| `src/services/tool/local-extra/clipboard.ts` | `:2`/`:18`/`:50` 模式文案（头注释与两处 description） | 改 | 决策 5（description 模型可见） |
| | `:24` `safetyLevel: "NORMAL"`（read） | 改 | 决策 6：→ `DANGER` |
| | `:27/:61` `mode: "assistant"` | 删 | 决策 5/8 |
| `src/services/tool/local-extra/agent-tool.ts` | `:2` 头注释 | 查 | 决策 5 |
| | `:21` description「不可写文件 / 只读工具 / …HTTP」 | 改 | 决策 16：改为与**变更后**行为相符的描述（bash 去白名单后确实能写；仓库本就没有列表/搜索/HTTP 工具）。不要写死「不可写」——它取决于 `pi-bash` 的 `resolveSafetyLevel` 与 safetyMode |
| | `:26-30` `mode: fork \| team` 工具参数 | **保留** | 同名不同义，见 §4 |
| | `:34` `safetyLevel: "NORMAL"` | 改 | 决策 6：→ `DANGER` |
| | `:37` `mode: "assistant"` | 删 | 决策 5/8 |
| `src/services/tool/session-transcript.ts` | `:27-41` 策略声明 | 查 | 决策 8 的口径核对：`read_session_event` **不在注册表**，由 `createTranscriptTool` 每回合注入 |
| | `:31` `mode: "pet"` | 删 | 决策 5 |
| `src/services/tool/mcp/client.ts` | `:15-21` 注释（论证「没有回读通道所以只能截断」） | 重写 | 决策 11：整段前提反转 |
| | `:22` `MAX_MCP_RESULT_CHARS` | 删 | 决策 11 |
| | `:155` `safetyLevel: "NORMAL"` | 改 | 决策 6：→ `DANGER`（保住 `:156-157` 的不变量：MCP 不构成默认授权） |
| | `:162` `resultProjection: "reference"` | 查 | 决策 11 依赖它走 L0 投影 |
| | `:166` `mode: "assistant"` | 删 | 决策 5/8 |
| | `:175-179` 截断分支（含 `:178` 的 `details.truncated`） | 删 | 决策 11：全文落条目，走 L0 投影 |
| `src/services/tool/mcp/index.ts` | `:36` 再导出 `MAX_MCP_RESULT_CHARS` | 删 | 决策 11 |
| `src/services/tool/mcp/manager.ts` | `:25` `McpServerConfig.enabled`、`:87`/`:109` 加载时的 `enabled !== false`、`:380` 运行期门 | 查 | 决策 8：每服务器开关的既有实现，口径不变 |
| | `:260` 注释「多个 session/mode owner 借用」 | 改 | 决策 5 |
| | `:328` `registerAll()` / `:350` `listAll()+unregister()` | **改/查** | **注册表的第二写者**。删 mode 过滤后，MCP 工具一旦入库就进入**所有**回合的冻结工具集，子代理与计划步骤也会拿到（决策 16 的剥离点在 `runPiSubAgent`，不覆盖 MCP）。需按决策 8 的口径确认这是期望行为并写进 `tool-system.md` |
| `src/services/safety/permission.ts` | `:98-114` `standardDecision` | 改 | 决策 6 重写：删 `:101` 模式检查、删 `:105-110` pet 分支、`:107` 的 `lightweightPolicy` 用法 |
| | `:71` `grants`、`:72` `CONFIRM_TTL_MS` | 查 | 决策 5 的影响量级说明（§8.5）：内存 Map + 5 分钟 TTL，不落盘 |
| `src/services/safety/checker.ts` | `:7` 注释「DANGER … 助手模式可经确认执行」 | 改 | 决策 5 |
| | `:21` `BASH_DANGEROUS_PATTERNS`、`:30` `BASH_NOWAY_PATTERNS`、`:106` `resolveFilePathLevel` | 查 | 决策 7/6：分级链**不改** |
| `src/services/debug.ts` | `:73` `registeredTools` 快照类型含 `mode: string` | 改 | 决策 5 |
| | `:177` 从 registry 解构 `getToolsForMode` | **删** | 悬空解构——解构后从未使用（`:178-181` 只用 `listAll`/`toolCount`） |
| | `:180` 工具快照含 `mode` | 改 | 决策 5 |
| `src/services/tool/pi/harness-adapter.ts` | `:18` 导入 `LightweightPolicy` | 删 | 决策 6（类型删除后此导入编译失败） |
| | `:29` `lightweightPolicy?` | 删 | 决策 6 |
| | `:67` `mode: "pet"`（工厂硬编码） | 删 | 决策 5 |
| | `:71` `lightweightPolicy: metadata.lightweightPolicy` | 删 | 决策 6 |
| `src/services/tool/pi/harness-tool-adapter.ts` | `:13-14` `HarnessToolRun.mode`（必填） | 删 | 决策 5 |
| | `:43` `mode: run.mode` | 删 | 决策 5 |
| | `:67` `details.deskpetEntryId` | 查 | 决策 11 的地址来源，只在成功分支写入 |
| `src/services/tool/pi/tauri-execution-env.ts` | `:29` `ToolMode` 导入 | 删 | 决策 5 |
| | `:33` `MAX_TOOL_FILE_BYTES = 5MB` | 查 | 决策 11：**这才是「5 MB 硬上限」的定义点**，用在 `:126/:144/:156/:168` 的 `file_read`/`file_read_binary`/`file_write`/`file_append`。它在会话条目写盘链上，不在 MCP 链上 |
| | `:99` `constructor(cwd, mode)` | 改 | 决策 5/7：去 mode |
| | `:299` `policy: { scope: this.mode, whitelist }` | 改 | 决策 7：`bash_exec` 去 `policy` 入参 |

### 5.2 运行时与上下文（生产代码）

| 文件 | 位置 | 动作 | 依据 |
|---|---|---|---|
| `src/services/engine/pi/runtime.ts` | `:288` `TurnKernel.mode` | 删 | 决策 5 |
| | `:345` `TurnKernelOptions.mode` | 删 | 决策 5 |
| | `:409` `toolSchemas[].policyHash` 进 PromptSnapshot | 查 | 决策 5 的持久落点（§8.5） |
| | `:481-486` `cache.prefixHash` | 查 | 只哈希 `layer === "static"` 的块；决策 12 的时间注入不受影响（static 成分未变） |
| | `:513-514` `createCompactionHook({ mode })` | 删 | 决策 5；调用点在 `:740-743` |
| | `:539 / :702 / :741` `mode` 透传 | 删 | 随字段 |
| | `:881` `const mode = …assistantMode` | 删 | 决策 5（全文件仅此一处 + 续跑 `:1740` + 压缩 `:1834`，共**三处**） |
| | `:916-918` `prepareRunCapabilities(mode, …)` | 改 | 决策 5：签名去 mode；**决策 1 的指纹核对挂在这里** |
| | `:920` `getToolsForMode(mode)` | 改 | 决策 8 |
| | `:922` / `:1772` `createTranscriptTool` 注入 | 查 | **不在注册表**，两处注入；确认决策 8「恒暴露」表述与之不冲突 |
| | `:929` `toolRun.mode` | 删 | 决策 5 |
| | `:954` `if (mode === "assistant" && planConfig.enabled)` | 改 | 决策 5：门禁只看 `planConfig.enabled`。**这是本批最大的隐式行为翻转**，见 §8.6 |
| | `:1024` `getSkillsPromptBlock({ mode })` | 改 | 决策 2：改无 mode |
| | `:1025` `getSkillCatalogFingerprint()` | 查 | 决策 1 的指纹已存在，确认语义扩展 |
| | `:1030` `buildPrompt({ …, mode })` | 删 | 决策 5 |
| | `:1049` `createTurnKernel({ mode })` | 删 | 决策 5 |
| | `:1170` `getToolsForMode("assistant")` | 改 | 决策 5 |
| | `:1203` 注释、`:1232` `stepMode = decision.mode` | **勿动** | 计划确认模式，同名不同义（§4） |
| | `:1525-1535` Plan 恢复路径 | 改 | **硬编码 `prepareConversationCapabilities("assistant", requestId)`**，去 mode 后必须改；配对释放 `:1563-1564 releaseMcpOwner(requestId)`。决策 1 的指纹核对也要在这条路径生效 |
| | `:1740/:1753/:1771/:1777/:1782/:1787` 续跑链 | 改 | 决策 5（`continueInterruptedRun`） |
| | `:1834/:1845/:1858` 压缩链 | 改 | 决策 5（`compactActiveSession`） |
| | `:1883-1903` `runPiSubAgent`（`:1889` `toolRun.mode: "pet"`、`:1903` `mode: "pet"`） | 改 | 决策 5 + **决策 16 的剥离点** |
| | `:1981-1988` `projectToolResultMessage` | 查 | **已知坑**：超预算时结果被重建成纯文本，**非文本 part 丢失**。决策 10 的图片不能指望它在这条路上存活；MCP 结果走同一条路径（§8.7） |
| `src/services/engine/pi/session-repo.ts` | `:40` 注释、`:88-89` 注释「mode 固定 pet 是最小权限基线」 | 改 | 决策 5 |
| | `:93` `new TauriExecutionEnv(cwd, "pet")` | 改 | **生产代码里 `TauriExecutionEnv` 的第二个构造点**（另一个是 `pi-tools.ts:27`），去 mode 后编译失败 |
| `src/services/engine/pi/harness-slot.ts` | `:40` 再导出 `HarnessToolRun` | 查 | 类型删除后此导出面对齐 |
| | `:187-193` `HarnessAdmitSpec` | 改 | 决策 4：现有 5 个字段（`model`/`thinkingEffort`/`tools`/`toolRun`/`prompt`），**无 kind/skill**，需扩展 |
| | `:1039-1069` `admitInput`（`:1056` `accept`） | 改 | 决策 4：按 kind 构造 request。**`/skill` 时 `prompt` 必须传空**，否则一条命令落两条用户正文（`:1073` 的注释警告过同类事故） |
| | `:1250` `assembleLane` 的 `Pick<HarnessAdmitSpec, …>` | 改 | 现 Pick 为 `"model" \| "thinkingEffort" \| "tools" \| "toolRun"`，**不含 `prompt`**；加 `{kind:"skill"}` 时必须同时扩 Pick，否则 `assembleLane` 拿不到 |
| | `:1250-1265` `assembleLane` | 改 | 决策 1/2：加 `setResources({ skills })`，**必须早于 `accept`**（否则 `UnknownSkill`）。内部现有 `setTools`/`syncCompactionSettings`/`syncRetryPolicy`/`syncQueueModes`/`syncToolPermitLimit`/`retryBorrowerAttachIfPending`/`flushPendingReleases`/`lane.setModel`(`:1262`)/`setThinkingLevel`(`:1263`)/`setActiveTools`(`:1264`)，**确无任何 resources 调用** |
| | `:1264` `setActiveTools(spec.tools.map(t => t.name))` | 查 | 「回合冻结工具集」的现有实现，不改 |
| `src/services/context/builder.ts` | `:7` 从 registry 深路径导入 `getToolDeclarations` | 改 | 绕过 barrel；函数收敛时该 import 一并断 |
| | `:31` `BuildContextInput.mode` | 删 | 决策 5（**可选**字段，非必填） |
| | `:99-103` `composeDynamicPrompt` | 改 | **决策 12：时间注入点**（落 dynamic 层） |
| | `:106` `runtimeDynamicPrompt` | 查 | `composeDynamicPrompt` 的生产调用点之一 |
| | `:111` `getToolDeclarations(input.mode)` | 改 | 决策 5 |
| | `:116` `input.mode ?? "assistant"` | 删 | 决策 5 |
| | `:126` `getSkillsPromptBlock({ mode })` | 改 | 决策 2；注意现有前置：**仅在 `tools.length` 时披露** |
| | `:136` `static:skill-catalog` 块、`:139` `dynamic:runtime` 块 | 查 | 决策 12 的层级落点 |
| `src/services/context/kernel.ts` | `:46` `isCore()`、`:101-103` `staticPrefix` | 查 | 决策 12：`staticPrefix` 只拼 `static:card`/`static:candy`/`static:tool-protocol`，时间注入不进它、不进 `prefixHash`。dynamic 块是核心块，装不下抛 `ContextBudgetError` 而非被淘汰 |
| `src/services/engine/compactor.ts` | `:18-21` `SUMMARY_MODE_INSTRUCTIONS`（两套） | 改 | 决策 9：合并为一套（文案见 §8.1） |
| | `:32` `CompactionSummaryInput.mode` | 删 | 决策 9 |
| | `:81-82` `SUMMARY_MODE_INSTRUCTIONS[input.mode]` | 改 | 决策 9：删索引写法，勿留成 `undefined` |
| `src/services/engine/planner.ts` | `:428-441` `allowedTools` 不存在时的硬失败 | 改 | **决策 16 的行为翻转**：剥离 `agent_spawn` 后，计划步骤显式列它会从「能跑」变成「该步不执行 + `missing_tools` 通知」 |
| | `:442-447` 未限定工具 → `getToolsForMode("assistant")` | 改 | 决策 8/16：含 `local-agent-spawn` 的放大必须消失；`:445` 的 `unbounded_tools` notice 断言随之变化 |
| | `:449/:453` `runPiSubAgent({ tools })` | 查 | 决策 16 剥离点在下游，调用点不改 |
| `src/services/agent/sub-agent.ts` | `:29-30` 自述注释、`:38` systemPrompt「不要修改文件」 | 改 | **第二份行为声明**，与 `agent-tool.ts:21` 同类；决策 5/7 后失真 |
| | `:133-138` fork 白名单（`pi-read`/`local-system-info`/`pi-bash`） | 查 | 决策 16：剥离点在 `runPiSubAgent`，**不在这里维护第二份** |
| | `:142` `getToolsForMode("pet")` | 改 | 决策 5 |
| `src/services/engine/runtime/types.ts` | `:220` `skillsFingerprint?: string` | 改 | 决策 1：能力上下文的第二个定义点（另一个是 `runtime.ts:1025` 的写入） |

### 5.3 初始化、配置与 UI（生产代码）

| 文件 | 位置 | 动作 | 依据 |
|---|---|---|---|
| `src/services/init.ts` | `:8` `registerAssistantTools`/`unregisterAssistantTools` 导入 | 删 | 决策 8 |
| | `:49`/`:93` `registerDefaultTools()` | 查 | 调用点保留（`:93` 在 `prepareConversationCapabilities` 内） |
| | `:53` 启动日志含 `assistantMode` / `computeMcpEnabled()` / `skillEnabled` | 改 | 决策 5/8 |
| | `:87-90` 文档注释「调用方必须在 run 结束后才以 pet 调用本函数」 | 改 | 决策 5 |
| | `:92-115` `prepareConversationCapabilities(mode, owner)` | 改 | 决策 5/8：去 mode；MCP 段改为「遍历所有服务器，跳过未启用者」（总闸已删）。`:99-101` 的服务器合并口径要与 `computeMcpEnabled()` 同源 |
| | `:96` `registerAssistantTools()`、`:154` `unregisterAssistantTools()` | 删 | 决策 8 |
| | `:110-113` `toolsConfig.skillEnabled` 门 + `ensureSkillCatalog()` | 改 | **决策 1**：替换为指纹核对入口；决策 8 删开关 |
| | `:121-128` `prepareRunCapabilities(mode, …)` | 改 | 决策 5：签名去 mode |
| | `:130-144` `pendingCapabilityMode` + `requestConversationCapabilityMode` | 删 | 决策 8：注册-释放舞蹈消失后无消费者 |
| | `:146-162` `applyPendingConversationCapabilities` | 删 | 同上；连带 `:156` `invalidateSkillCatalog("mode-change")`、`:158` `releaseMcpOwner("runtime")` |
| `src/services/config.ts` | `:60` `mode: { assistant: boolean }` 类型 | 删 | 决策 5 |
| | `:136-145` `tools` 类型块（`:138` `file`、`:139-143` `mcp`、`:144` `skill`） | 改 | 决策 8：删 `file` 整块、`mcp.enabled`、`skill` 整块 |
| | `:401` `assistantMode` getter | 删 | 决策 5 |
| | `:530` `planConfig.enabled`（默认 `true`） | 查 | 决策 5 的门禁翻转依据（§8.6） |
| | `:592` `fileWriteEnabled` getter | 删 | 决策 8 |
| | `:593` 注释「读写值：设置页勾选框的初值与回写都读它…」 | 删 | 决策 8 |
| | `:594` `mcpEnabled` getter | 删 | 决策 8 |
| | `:595` `mcpServers`、`:596` `builtinMcpServers` | **保留** | 每服务器控制面（决策 8） |
| | `:597-598` Skill 两行注释、`:599` `skillEnabled` getter | 删 | 决策 8 |
| | `:602-606` 「派生值不回写设置页」注释、`:607-609` `computeMcpEnabled()` | 改 | 决策 8：派生值改为「**至少一个服务器启用**」；保留「派生值不回写设置页」的分工。谓词要与 `init.ts:99-101` 同源，否则两处判定分叉 |
| `src/services/skill/loader.ts` | 全文 | 重写 | 决策 1/2/3：删 catalog / TTL / generation / `parseFrontmatter` / `parseSkillSource` / `SkillMetadata` / `SkillMode` / `SkillInvocationPolicy` / `SkillSource` / `MAX_DESCRIPTION_CHARS` / `MAX_CAPABILITY_TAGS` / `CATALOG_TTL_MS` / `SKILL_NAME_PATTERN` / `FRONTMATTER_PATTERN`；**保留** `MAX_SKILL_BYTES`（`:188`，512KB）与预算常量 `MAX_PROMPT_CHARS` |
| | `:113` name 必须等于目录名 | 改 | 决策 3 的连带：校验真相源改 Pi loader（§3） |
| | `:141` `invalidateSkillCatalog` 的 `"dispose"` 分支 | 删 | 无调用者的死分支 |
| | `:147-150` `refreshSkills` | **改/查** | **唯一外部消费者是 `profile/io.ts:240-241`**（Profile 切换后重种子技能目录）；指纹模型下它的语义要重新定义 |
| | `:169` `if (!toolsConfig.skillEnabled \|\| !catalog?.entries.length) return ""` | 删 | **决策 8 的真正实现点**，「Skill 默认关」就落在这行 |
| | `:187-200` `upsertSkill`（含 `:194` 路径拼装、`:197` `file_write_atomic`） | 改 | 决策 3：校验真相源改为 Pi loader；`:197` 的原子替换语义保留 |
| | `:204` `deleteSkill` | 查 | 决策 3 |
| `src/services/skill/store.ts` | — | **新** | 决策 1：持有 `Skill[]` + 目录指纹 + `diagnostics[]` + 每技能 `enabled` 过滤 |
| `src/services/skill/index.ts` | `:11-22` 导出面（`refreshSkills`(`:12`)、`ensureSkillCatalog`(`:13`)、`listSkills`(`:14`)、`getSkillsPromptBlock`(`:15`)、`getSkillCatalogFingerprint`(`:16`)、`invalidateSkillCatalog`(`:17`)、`parseSkillSource`(`:18`)、`upsertSkill`(`:19`)、`deleteSkill`(`:20`)、类型 `:22`） | 改 | 随上；`parseSkillSource` 的去留在此定 |
| `src/services/engine/slash/types.ts` | `:12` `category` 闭合联合（`general`/`session`/`memory`/`easteregg`） | 改/查 | 决策 4：无 skill 值 → 要么复用既有值，要么扩联合（扩则连带 `/help` 分组 `help.ts:16` 与 `runtime-contract.md:20`） |
| | `:21` `busyPolicy` 取值（`immediate`/`coordinated`/`exclusive`） | 改 | 决策 4：`/skill` 建议 `coordinated` |
| | `:23` `execute: () => Promise<string \| null>` | **改** | **决策 4 的通路缺口**：signature 零参数，`/skill <name> [额外指示]` 的参数无处接收（§6 1.8） |
| `src/services/engine/slash/registry.ts` | `:31-33` `find(name)` 整串精确匹配 | **改** | 同上：`cmdText = "skill foo 额外指示"` 时返回 `undefined` |
| | `:41` 起 `search(partial)` | 改 | 下拉框提示；`/help` 也消费 `listAll` |
| `src/services/engine/slash/commands/index.ts` | `:14-25` 命令注册表 | 改 | 决策 4：注册 `/skill` |
| `src/services/engine/slash/commands/help.ts` | `:6` `listAll`、`:16` 分组 | 查 | 决策 4 的连带（是否新增分组取决于 `category` 裁决） |
| `src/services/engine/preprocessor.ts` | `:36-40` `busyRejection` | 查 | 决策 4：`immediate`/`coordinated` 放行、其余拒绝；`/skill` 若选 `coordinated` 则忙碌期可过 |
| | `:57-85` 注册命令一律 `handled: true` | 改 | **决策 4 的通路**：`/skill` 不能被短路，需要携带「启动一次 skill 准入」的出口 |
| `src/services/agent/runner.ts` | `:32` 导入、`:323`/`:519`/`:569` 的 `applyPendingConversationCapabilities()` | 删 | 决策 8（`sendMessage` finally、`sendActiveMessage` finally 等四处） |
| | `:417-432` `handled` 分支直接 return（`:424` 调用、`:425-431` return 早于 `:434` `harnessSlots.begin()`） | 改 | **决策 4 的通路**：`/skill` 必须走到 `harnessSlots.begin()` |
| `src/services/profile/io.ts` | `:232-241`（`:240-241` 动态 import + 调 `refreshSkills()`） | 改 | 决策 1：Profile 切换后的技能刷新入口，走动态 import，从 barrel 反查不到 |
| `src/App.vue` | `:688-711` 设置保存监听（`:689` `previousAssistantMode`、`:702` 判断、`:704` `requestConversationCapabilityMode("pet")`、`:710` 错误文案含 `assistantMode`） | 改 | 决策 5/8 |
| | `:698-699` `invalidateSkillCatalog("config")` | 查 | 决策 1：指纹核对取代显式失效，确认是否仍需保留 |
| | `:741` `disconnectAllMcpServers()` | 查 | 决策 8 的连带核对 |
| `src/components/settings/GeneralTab.vue` | `:11` `// ── 模式 ──`、`:12` `assistantMode` ref | 删 | 决策 5 |
| | `:117` defineExpose | 删 | 决策 5 |
| | `:135-139` 「⚙️ 模式」整块（label + checkbox + hint） | 删 | 决策 5；顺带清掉 hint 里的「需重启」（与实际即时收敛不符） |
| `src/components/settings/AITab.vue` | `:66-77`/`:445-455` 诊断 `memStatus` 的 `mode` 字段（`助手(LLM)/轻量(去重)`） | **删** | 决策 5。该字段**从不渲染**（`:734` 只读 count/projectCount/sessionTurns/lastConsolidation），「改」会留下死字段 |
| | `:44-49` `windowMonitor.enabled` UI 初值 | 查 | 决策 14 |
| `src/components/settings/ToolsTab.vue` | `:11-12` `assistantMode` prop（模板 `:327` 也用它） | 删 | 决策 5 |
| | `:18` `fileWriteEnabled` ref、`:280` expose、`:301` 控件 | 删 | 决策 8 |
| | `:26` `mcpEnabled` ref、`:282` expose、`:327` 复选框 | 删 | 决策 8 |
| | `:41` `skillEnabled` ref、`:285` expose、`:369` 复选框 | 删 | 决策 8（改为每技能开关，见 5.4） |
| | `:42` `skillList` 类型、`:193-228` `loadSkillConfig`/`removeSkill`/`uploadSkillMd` | 改 | 5.4：列表要喂出 `enabled` 状态并支持切换 |
| | `:248-251` 第二注册表实例（`registerDefaultTools` + `registerAssistantTools`，**从不释放**；`registerDefaultTools` 有 `defaultToolsRegistered` 幂等位） | 改 | 决策 8：只需 `registerDefaultTools()`；它从不释放，需说明新口径 |
| | `:255` `audience: tool.mode === "pet" ? "两模式" : "仅助手"` | 删 | 决策 5 |
| | `:159-190` `testMcpConnection` 直接调 `connectMcpServer` | 查 | 决策 8：这条路径**绕过总闸与 `server.enabled`**；删总闸后设置窗口的「测试连接」仍会 spawn 子进程并注册工具 |
| | `:296`/`:301`/`:324-328`/`:369-370` 用户可见文案（「两个模式均可用」「启用 MCP（仅助手模式）」「需重启」「按声明支持轻量或助手模式」「首回合只列名称…」） | 改 | 决策 5/8（AGENTS.md：用户可见文案随行为同步）。`:326` 的「需重启」需单独裁定——MCP 已是按 run 借用/释放，且 `SettingsPanel` 的 `setOverride` 立即生效 |
| | `:334` `toggleBuiltinMcp` | 查 | 决策 8：每服务器开关的既有写入面 |
| `src/components/SettingsPanel.vue` | `:43` `assistantMode` ref、`:127` `"general.mode.assistant"` 映射 | 删 | 决策 5 |
| | `:128` `"ai.safety.mode"` 映射 | **保留** | 同名不同义（§4） |
| | `:133` `"tools.file.writeEnabled"`、`:134` `"tools.mcp.enabled"`、`:135` `"tools.skill.enabled"` 映射 | 删 | 决策 8 |
| | `:139-159`/`:162-178` 每服务器 `enabled` 的写入面（builtin 走 `setOverride("tools.mcp.builtin", …)`，自定义走 `setMcpServers`） | 查 | 决策 8：**MCP 的每服务器控制面在 UI 上已经存在，本批只删总闸** |
| | `:198` 错误文案提到 `assistantMode`、`:313` 传 `:assistant-mode` | 改 | 决策 5 |
| `src/components/settings/AppearanceTab.vue` | `:22`/`:206` `restore_default_resources` | 查 | 决策 3 的连带：这是种子恢复覆盖的唯一 UI 入口；Pi loader 改成递归遍历后，`sync_seed_directory`（`paths.rs:417-447`）的覆盖范围需核对 |

### 5.4 每技能开关与设置页（新增能力）

| 项 | 落位 | 动作 |
|---|---|---|
| frontmatter 字段 | `SKILL.md` 的 `enabled: true \| false`（缺省 `true`） | **新**：Desk-Pet 自有字段，由 `skill/store.ts` 读取过滤；**不**交给 Pi（Pi 只认 `name`/`description`/`disable-model-invocation`） |
| 过滤点 | `store.ts` 决定哪些 skill 进 `setResources` 与披露块 | **新**：关闭的技能既不披露也**不可显式调用**（与 Pi 的 `disable-model-invocation` 语义明确分开：后者是「不披露但仍可显式调用」——`lane.js` 的 skill 分支只查 `resources.skills`，不查 `disableModelInvocation`） |
| 写入路径 | 设置页切换时写文件 | **新**：读原文 → 只改 `enabled` 行 → `invoke("file_write_atomic", { path, content, maxBytes })`（同 `upsertSkill` 的原子替换语义）。**不能从 Pi 的 `Skill` 对象重建文件**——它只有解析后的 `content` 与 `filePath`，没有原始 frontmatter 文本 |
| 种子 | `src-tauri/resources/defaults/skills/*/SKILL.md`（3 份） | **新**：当前 frontmatter 只有 `name`/`description`，`enabled` 字段在此是新写 |
| 设置页 UI | Skill 列表逐项开关 | **新**：`ToolsTab.vue` 的 Skill 区现状是「总开关 + 上传/删除」，本批改为逐项启用/关闭 |
| 文档 | `docs/current/runtime-data.md`（Skill 目录）、`tool-system.md`（Skill 渐进披露） | 改：写明 frontmatter 字段与语义；核对「Pi 递归遍历、根 `.md` 也算 skill、name 可缺省取目录名」与现布局说明是否相符 |

### 5.5 Rust

| 文件 | 位置 | 动作 | 依据 |
|---|---|---|---|
| `src-tauri/src/commands/bash_policy.rs` | `:1-17` 模块头注释（「层 2 按 scope 叠加」整段） | 改 | 决策 7 |
| | `:27-34` `BashScope` 枚举（含文档注释） | 删 | 决策 7 |
| | `:36-45` `BashPolicy` 结构（含「`scope` 必填」文档） | 删 | 决策 7 |
| | `:51-73` `enforce_bash_policy(command, scope, whitelist)` | 改 | 决策 7：去 scope/whitelist 参数，固定执行「层 1 + `enforce_no_catastrophic_write`」 |
| | `:213` 文档注释（引用 `first_control_syntax`） | 改 | 决策 7 |
| | `:232-254` `enforce_whitelist` | 删 | 决策 7 |
| | `:256-277` `enforce_no_catastrophic_write` | 改 | 决策 7：从 Assistant 专属升为唯一层 2，**逻辑不变**，但 `:271` 的**模型可见错误串**「助手模式禁止操作系统路径: {}」与 `:256-257`/`:293`/`:298` 注释全部失真 |
| | `:688-704` `first_control_syntax` | 删 | 决策 7：唯一调用点是 `:237`（已随 `enforce_whitelist` 删） |
| | `:786-1136` 测试模块 | 重写 | 决策 7：**四个测试助手**（`whitelist()` `:790-798`、`pet()` `:800-802`、`assistant()` `:804-806`、`denied_both()` `:808-811`）全部消失，受影响用例远超点名的五个——`denied_both` 一个就被 8 个用例调用，另有 `:1020` 的「层 2：Assistant」段注释与 `:1122` 的前端载荷契约用例整体作废 |
| `src-tauri/src/commands/tool_exec.rs` | `:6` 导入、`:92` `bash_exec` 的 `policy: BashPolicy`、`:99` 转发、`:112` `run_bash`、`:117` `enforce_bash_policy(&command, policy.scope, &policy.whitelist)` | 改 | 决策 7：去 `policy` 入参 |
| | `:79-80` 文档「`policy` 必填…scope 只能叠加层 2 规则」、`:260-262` 注释「且助手模式整段跳过」 | 改 | 决策 7 |
| | `:1083-1097` `system_info()`、`:1100-1103` 注释与 `rename_all`、`:1104-1112` `SystemInfoResult`（`os`/`arch`/`cpu_count`/`mem_total`/`mem_used`） | 改 | 决策 13：新增可用内存字段；`:1100-1103` 的注释说明漏 `rename_all` 会让字段全变 `undefined` |
| | `:1112-1209` `get_memory_info()` | 改 | **决策 13 的第三处必改点**。Windows 分支已有 `ullAvailPhys`（`:1176/:1184`，当前只用来算 used）、Linux 分支已有 `MemAvailable`（`:1206`），**macOS 分支（`:1113-1159`）现在只算 used（active+wired+compressed），没有 available** → 只改结构体与字面量会得到 0，必须补 macOS 口径 |
| | `:1631-1647` `system_info_payload_uses_camel_case` | 改 | 决策 13：`:1632-1639` 的结构体字面量与 `:1640` 的字段清单同步 |
| | `:1924` `use crate::commands::bash_policy::BashScope;` | 删 | 决策 7 |
| | `:1948-1953` `assistant_policy()` 测试助手 | 删 | 决策 7 |
| | `:1988 / :2013 / :2041 / :2068` 构造 scope 载荷 | 改 | 决策 7：**三个用例、四个调用点**（`bash_cancel_lands_before_spawn` `:1975` 的正/负对照两处、`bash_policy_reject_leaves_no_pool_entry` `:2033`、`bash_invalid_cwd_leaves_no_pool_entry` `:2056`） |
| `src-tauri/src/commands/skill_cmd.rs` | `:19` `MAX_CATALOG_ENTRIES: 128` | 改 | 决策 1：退化为计数上限 |
| | `:20` `MAX_SCAN_ENTRIES: 4096` | **保留** | 决策 1：`:64-69` 的 readdir 上限仍需要 |
| | `:21` `MAX_FRONTMATTER_BYTES`、`:153-193` `read_frontmatter()`、`:104-107` 调用处、`:114-119` fingerprint 入参 | 删 | 决策 1：校验真相源改 Pi loader |
| | `:23-40` `SkillCatalogEntry`（`:28` `frontmatter: String`）/ `SkillCatalogResult` | 改 | 决策 1：收敛为 `{fingerprint, count, truncated}` |
| | `:86` `directory_count = scanned_entries` | 改 | 决策 1：现有口径计的是**所有 readdir 条目（含文件）**；新契约暴露 `count` 前必须先定义口径 |
| | `:47` `skill_list_metadata` 命令名 | 改 | 决策 1：**如实改名**——不再返回逐条 metadata。建议 `skill_catalog_fingerprint`，并在方案/实现里写死 |
| `src-tauri/src/lib.rs` | `:23`/`:27` 导入、`:389`/`:398`/`:421`/`:422` 注册 | 改 | 命令改名同步 |
| `src-tauri/src/commands/mod.rs` | `:16` 声明、`:34`/`:35` 再导出、`:41` `system_info` | 改 | 同上 |
| `src-tauri/src/commands/resources_cmd.rs` | `:33-42` `skill_delete` | 查 | 决策 3 |
| | `:44-57` `resolve_skill_dir`（`:49-52` 只允许 `[a-z0-9-]`，否则 `PathEscape`） | 改 | **决策 3 的真实风险点**：Pi loader 从 frontmatter 取名 + 递归 + 含根 `.md`，于是「目录名与服务名不一致、嵌套目录、根级 `.md`、含大写/下划线/点的目录」一律删不掉或删错。需定新语义（按目录名还是按 frontmatter 名索引） |
| `src-tauri/src/paths.rs` | `:417-447` `sync_seed_directory` | 查 | 决策 3：按**目录名**递归复制、从不删多余项，与 frontmatter 名无关 → **「种子覆盖」不构成风险**，只有「按名删除」才是 |

### 5.6 配置与 YAML

| 文件 | 位置 | 动作 | 依据 |
|---|---|---|---|
| `CONFIG.yaml` | `:12-13` `general.mode.assistant` | 删 | 决策 5 |
| | `:86` `ai.plan.enabled: true` | 查 | 决策 5 的门禁翻转依据（§8.6） |
| | `:129` `tools.bash.whitelist` | 查 | 决策 7：语义从硬墙变免确认通道，键与默认值保留 |
| | `:133-134` `tools.file.writeEnabled` | 删 | 决策 8 |
| | `:136` 起 `mcp.enabled` 一行 | 删 | 决策 8 |
| | `builtin.filesystem.enabled` / `builtin.playwright.enabled` | 改 → `false` | **决策 8 连带**（见 §3） |
| | `:168-170` `tools.skill` 整块（含注释） | 删 | 决策 8 |
| `CONFIG-DEV.yaml.example` | `:6` `general.mode` | 删 | 决策 5 |
| | `:44` `ai.plan.enabled` | 查 | §8.6 |
| | `:67` `tools.bash.whitelist` | 查 | 决策 7 |
| | `:68` `file.writeEnabled` | 删 | 决策 8 |
| | `:69` 起 `mcp.enabled` 行 + `:73`/`:75` 的 `filesystem`/`playwright` 的 `enabled` | 删 / 改 `false` | 决策 8 |
| | `:78-79` `tools.skill` 整块 | 删 | 决策 8 |
| `CONFIG-DEV.yaml`（真实本地，gitignore） | 同上（`:7-8`、`:79`、`:113`、`:133-134`、`:135`、`:139`/`:156`、`:180-181`） | 改 | **需单独授权**；未同步时在交付中说明。注意 `:139`/`:156` 的 `filesystem`/`playwright` 均为 `enabled: true`，与生产同处境 |

### 5.7 契约（8 份，全部 STALE）

`sourceHash` 只覆盖契约自己声明的 `sourceFiles`（**无 glob、无依赖闭包**），由 `scripts/live-test.mjs:63-87` 计算（`:73-78` 是核心：正则读出 `sourceFiles` 数组 → `sort()` → 逐个 `readFileSync` → sha256）。**不得只刷 hash**：行为变了必须重新 analyze → generate。

| 契约 | 因哪些文件 STALE（真实原因） | 处置 |
|---|---|---|
| `tool-execution` | `runtime.ts`、`harness-slot.ts`、`tool/{types,policy,registry,session-transcript}.ts`、`local/pi-tools.ts`、`pi/{harness-adapter,harness-tool-adapter,tauri-execution-env}.ts`、`mcp/client.ts`、`skill/loader.ts`、`skill_cmd.rs`、`tool_exec.rs` | analyze → generate；**`sourceFiles` 需新增 `src/services/skill/store.ts`、`src/services/agent/sub-agent.ts`** |
| `safety` | `bash_policy.rs`、`permission.ts`、`tool/{types,policy}.ts`、`local/pi-tools.ts`、`mcp/client.ts`、`runtime.ts`、`harness-slot.ts` | analyze → generate |
| `agent-runtime` | `runtime.ts`、`harness-slot.ts`、`agent/runner.ts`、`debug.ts`、`engine/preprocessor.ts` | analyze → generate（注意 `engine/runtime/types.ts` 也在其 `sourceFiles` 里，改 `skillsFingerprint` 会命中） |
| `planner` | `runtime.ts`、`planner.ts` | analyze → generate |
| `harness-storage` | `tool/pi/tauri-execution-env.ts` | analyze → generate |
| `memory` | `runtime.ts`、`harness-slot.ts`、`engine/compactor.ts`、`tool/policy.ts`、`context/builder.ts`、`debug.ts` | analyze → generate（`mm-11` 关于 `policyHash` 的措辞需重审，见 §8.5） |
| `personality-card` | `tool/registry.ts`、`personality/stages-cache.ts`、`personality/stages-file.ts`、`personality/stages-prompt.md` | analyze → generate（`/skill` 新增 `CommandReplies` key 会同时动这三份） |
| **`variable-pool`** | **`runtime.ts`**（它的 `sourceFiles` 第一项）、`personality/stages-file.ts` | analyze → generate。**它不在上一版方案的 7 份里，但必然 STALE** |

**零契约覆盖、本批会改的生产文件**（改动不受 hash 门禁保护，需靠场景或人工核对）：`src/services/init.ts`、`config.ts`、`skill/index.ts`、`engine/slash/{types,registry}.ts`、`engine/slash/commands/index.ts`、`tool/local/system.ts`、`tool/local-extra/{app,clipboard,agent-tool}.ts`、`tool/index.ts`、`tool/mcp/manager.ts`、`agent/sub-agent.ts`、`profile/io.ts`、`services/window/*`、`App.vue` 与四个 settings 组件、三份 YAML、`lib.rs`/`commands/mod.rs`/`resources_cmd.rs`。

### 5.8 场景

`LIVE_DATASET_VERSION`（`dataset.ts:10`，`:18` 有格式校验）递增；消费点还有 `live-test-main.ts:8/:154`。

**A. 必改（会编译失败或断言失效）**

| 文件 | 位置 | 动作 |
|---|---|---|
| `scenes/agent-runtime/输入先落盘.scene.ts` | `:69` 类型字段、`:80`/`:88`/`:117`/`:126`/`:167` | 删 `general.mode.assistant` 快照/还原/翻转（`setOverride` 会写进真实运行时 CONFIG，删键前必须先删这些调用） |
| `scenes/agent-runtime/计划步骤变量写入.scene.ts` | `:115`/`:215`/`:217` | 同上 |
| `scenes/planner/计划生产闭环.scene.ts` | `:22` 头注释、`:113`/`:179`/`:214`/`:308`/`:333`/`:383` | 同上；门禁改为只看 `planConfig.enabled` |
| `scenes/safety/子代理授权范围.scene.ts` | `:104`/`:107`/`:144`/`:220`/`:233`/`:282`/`:321`/`:323` | 删 mode 开关与 `lightweightPolicy`；决策 16 后再核 |
| `scenes/safety/权限策略冻结.scene.ts` | `:24`/`:32`/`:35`/`:65`/`:66` | 删 `lightweightPolicy` 探针与模式开关 |
| `scenes/safety/确认通道.scene.ts` | `:8` 注释 | 改：`pi-bash` 不再是唯一 confirm 通道 |
| `scenes/tool-execution/工具结果存档边界.scene.ts` | `:72-74`/`:78`/`:119` | 删「靠助手模式绕开白名单」的前提；场景存在理由消失，改为直接跑 |
| `scenes/safety/安全等级边界.scene.ts` | `:9`/`:31`/`:48`/`:110` | 重写为统一裁决断言（NORMAL→allow 单分支） |
| `scenes/safety/PermissionKernel.scene.ts` | `:7`/`:27`/`:52` 注释、`:53-56` 断言 | **`sf-12` 断言「NORMAL 在助手模式下是 ask」必须重写** |
| `scenes/agent-runtime/恢复能力准备.scene.ts` | `:5`/`:14`/`:35`/`:47`/`:48`/`:49`/`:61`/`:65`/`:80`/`:88` | 用 `invocationPolicy: pet` + `capabilityTags` + `getSkillsPromptBlock({mode:"pet"})` + `tools.skill.enabled` → 全部失效 |
| `scenes/agent-runtime/用量分列.scene.ts` | `:8`/`:66` | `getToolsForMode("assistant")` |
| `scenes/planner/计划评估与执行.scene.ts` | `:5`/`:111`/`:128`/`:205-208` | `getToolsForMode("assistant")` + `unbounded_tools` notice 断言（决策 16 会改放大集合） |
| `scenes/memory/提示文案.scene.ts` | `:39-42`/`:54-56`/`:61` | 断言 `composeDynamicPrompt` 输出（决策 12 会改）；`:56` 传 `mode` |
| **`scenes/personality-card/阶段文案链路.scene.ts`** | `:7-29` `PROBE_STAGES` | **`CommandReplies` 9 个 key 全部必填**：`/skill` 加 key 后探针 Card 缺 key → **TS 编译失败**；即便补了类型，运行期 `validateStagesForCard` 会判过期 → `:64-65` 的 `getCommandReply` 断言失败。同目录 `阶段文案失效.scene.ts:110-121` 用 `COMMAND_KEYS` 动态构造，**不需要改** |
| `scenes/harness-storage/执行环境文件树.scene.ts` | `:9` | `new TauriExecutionEnv(…, "pet")` → 去参 |
| `scenes/harness-storage/会话重启恢复.scene.ts` | `:31`/`:85` | 同上 |
| `scenes/tool-execution/执行许可.scene.ts` | `:19`/`:69`/`:70`/`:90`/`:91`/`:115`/`:122` | `ToolDef.mode` + `ToolContext.mode` |
| `scenes/tool-execution/工具取消.scene.ts` | `:13`/`:24` | 同上 |
| `scenes/tool-execution/工具超时判定.scene.ts` | `:19`/`:58`/`:72` | 同上 |
| `scenes/tool-execution/工具结果恢复.scene.ts` | `:23`/`:45`/`:47` | 同上 |
| `scenes/tool-execution/工具结果投影.scene.ts` | `:22` | `ToolDef.mode` |
| `scenes/tool-execution/工具构造门禁.scene.ts` | `:21` | `ToolDef.mode` |
| `scenes/tool-execution/工具策略门禁.scene.ts` | `:12` | `ToolDef.mode`（te-15 的 `lightweightPolicy` 校验自述未被本场景断言，需补） |
| `scenes/tool-execution/许可释放补偿.scene.ts` | `:24` | `ToolDef.mode` |
| **`scenes/agent-runtime/手动压缩排队守卫.scene.ts`** | `:64` | `ToolDef.mode`（注意：在 `agent-runtime/`，不在 `tool-execution/`） |
| `scenes/agent-runtime/停止无新工具结束.scene.ts` | `:125` | `ToolDef.mode` |
| `scenes/memory/保留守卫.scene.ts` | `:90` | `ToolDef.mode` |
| `scenes/memory/地址完整性.scene.ts` | `:90` | `ToolDef.mode` |
| `scenes/memory/摘要投影口径.scene.ts` | `:96` | `ToolDef.mode` |
| `scenes/safety/凭据路径.scene.ts` | `:14`/`:63`/`:66-70`/`:76`/`:77` | 决策 7：`{scope, whitelist}` 载荷与「两种 scope」措辞；`sf-16` 的理由需重新推导 |
| `scenes/tool-execution/取消竞态.scene.ts` | `:73`/`:77`/`:94`/`:98` | 决策 7：`policy: { scope: "assistant", whitelist: [] }` |
| `scenes/tool-execution/Skill渐进加载.scene.ts` | `:2`/`:9-10`/`:26`/`:35-61`/`:71`/`:78`/`:89-96` | `te-11` + `te-12` 双点重写：`invocationPolicy`/`capabilityTags` 构造失效、「正文不进缓存」前提反转（Pi 的 `Skill.content` 就是全文）、mode 过滤断言删除。**该场景会读写真实 `data_root/skills/`**（`upsertSkill`→`file_write_atomic`、`deleteSkill`→`skill_delete`），跑前先备份运行时数据 |
| `scenes/tool-execution/MCP配置保留.scene.ts` | `:27`/`:47` | **查**：只动 `tools.mcp.builtin`（每服务器配置，保留），删总闸不影响 |
| `scenes/tool-execution/工具联动.scene.ts` | `:5`/`:8-11` | **查**：用户文本点名「操作系统和内存情况」，只断言调用成功与非空回复，不绑字段名 → 决策 13 不影响它，但**别把「总内存」删掉**（决策 13 明确是「总与可用」） |
| `scenes/memory/P0快照.scene.ts` | `:23`/`:83-96` | **查**：用 `system_info` 当探针工具名（`:23` 的 `policyHash: "policy-hash"` 是手写假值，不受 hash 变化影响） |
| `scenes/memory/审计闭环.scene.ts` | `:70`/`:76`/`:114` | **查**：同上 |
| `__tests__/live/blocking-tool.ts` | `:32` | `ToolDef.mode` |
| `__tests__/live/standard-setup.ts` | `:14`/`:38`（registry 深路径导入与调用）、`:91-111` | **改钉，不是删除**：`:94-99` 的 pet 基线注释自己写明了「计划入口由 `assistantMode && planConfig.enabled` 双重把守，钉住助手模式就走不到计划段；`ai.plan.enabled` 不在钉住之列：pet 模式下它不生效」。模式移除后这个前提消失，而 `ai.plan.enabled` 出厂即 `true` → **基线必须改钉 `ai.plan.enabled: false`**，否则计划段对所有 production 场景默认打开（§8.6）。另注意 `:14/:38` 是 Live 宿主唯一的工具注册入口，`registerDefaultTools` 吸收助手工具后**每个场景的基线工具集 +4** |
| `__tests__/live/dataset.ts` | `:10` | `LIVE_DATASET_VERSION` 递增；`live-test-main.ts:8/:154` 是第二个消费点 |

**B. 新建**

| 场景 | 覆盖 | 依据 |
|---|---|---|
| Skill 渐进披露（Pi loader + 预算截断） | te-11 重写 | 决策 1/2 |
| `/skill` 显式调用（参数解析 + 条目落盘 + 正文进对话 + 未知名报错） | 新 | 决策 4 |
| 每技能 `enabled` 两态（披露与显式调用同时受控） | 新 | 决策 3 |
| 技能目录指纹刷新（改文件 → 下一回合生效，无 TTL） | 新 | 决策 1 |
| 图片缩放与 BMP（长边 1568 / BMP→PNG / 失败回退原图） | 新（`live/` 对 `image`/`bmp`/`1568` **零命中**） | 决策 10 |
| MCP 大结果回读（超过旧 50,000 后仍可 `read_session_event` 取回） | 新（te-13 自述未被场景断言） | 决策 11 |
| 权限统一裁决（NORMAL 放行 + 重定级三工具走 DANGER） | 新 | 决策 6 |
| 时间注入（date/time 出现在 dynamic 层，static 前缀 hash 不变） | 新 | 决策 12 |
| 窗口工具两态（`windowMonitor.enabled` 开/关） | 新（`window/*` 不在任何 `sourceFiles`） | 决策 14；**可验证性缺口见 §8.10** |
| 子代理工具面（无 `agent_spawn`） | 新 | 决策 16：`sub-agent.ts` 既不在任何契约的 `sourceFiles`，也无任何场景引用它 → 行为变更本批无门禁无断言，需一并加进 `sourceFiles` |
| MCP 单项开关（全关 = 不连接） | 新（**回归场景**：每服务器开关的 UI 与运行期门已存在，本批不新建机制） | 决策 8 |

### 5.9 文档

| 文件 | 位置 | 动作 |
|---|---|---|
| `AGENTS.md` | `:135-136` | 改：两条 skill 不变量（正文经 read 按需读取 → Pi loader + 显式调用；启动不加载正文） |
| | `:134` | 改：Bash 基线措辞（层 1 硬基线 + 系统路径保护 + 凭据拦截不可关闭；去掉「助手模式不能关闭」） |
| | `:31`/`:97` | 查：skill 路由行与种子语义 |
| `docs/current/tool-system.md` | `:5` 标题「执行链与模式」 | 改 |
| | `:14-22` 模式列表格 | 重写为单一面 |
| | `:17` 「配置关闭时硬拒绝」 | 改：`writeEnabled` 已删 |
| | `:30` `lightweightPolicy` 条目 | 删 |
| | `:70`/`:75` | 改：权限与 bash 新口径 |
| | `:79-86` Skill 渐进披露整段（含 `:84` `invocationPolicy`、`:85` 「catalog 由 TTL…/**模式**变化等失效」） | 重写（决策 1/2/3 + 每技能 `enabled`） |
| | `:90` 「按助手运行 owner 借用」 | 改 |
| | `:92` MCP 截断 | 改：决策 11 |
| | MCP 工具可见性 | 改：决策 8 下 MCP 工具进入所有回合（`mcp/manager.ts` 的注册通路） |
| `docs/current/system-design.md` | `:19`/`:28`/`:36`/`:37`/`:62` | 改：模式相关措辞。模块地图是**目录级**（`:19` 只列 `[skill/](src/services/skill/)`），新增 `store.ts` 不必改地图 |
| `docs/current/runtime-contract.md` | `:16`「放大到全部助手工具」 | 改 |
| | `:20` 命令 `busyPolicy` 声明 | 改：`/skill` 需声明（若扩 `category` 联合，此处同步） |
| | `:22` 能力准备描述 | 改：决策 1 指纹核对 + 决策 8 无总闸 |
| | `:47` `skillsFingerprint` 语义 | 改 |
| `docs/current/memory.md` | `:19` `resources.skills` 保持上游默认 | 改：**不再成立**（本批注册 `setResources`），FIX-13 该成员撤销 |
| | `:25` 陪伴/助手双模式摘要 | 改：决策 9 |
| | `:41` 「schema/Skill 清单计入 tools」 | 查：披露变化后预算归属 |
| `docs/current/personality.md` | `:31` `getCommandReply` 行 | 改：补 `/skill` |
| | 阶段文案机制 | 改：新增 `CommandReplies` key 的全链要求 |
| `docs/current/runtime-data.md` | `:78` `skills/ {name}/SKILL.md` 布局、`:92` 种子与恢复覆盖语义 | 改：补 per-skill `enabled`；核对「Pi 递归遍历、根 `.md` 也算 skill、name 可缺省取目录名」与现布局说明 |
| | 配置变更同步清单（`:16-29`） | 改：按清单逐项落；新增 `tools.bash.whitelist` 的「说明」行（语义从硬墙变免确认通道） |
| `docs/current/testing.md` | `:26` 「Live Test 恒以 pet 模式运行…助手模式下」 | 改：前提消失 |
| `docs/current/development.md` | — | 查：已确认无模式相关描述（只命中「跨端对齐」） |
| `README.md` | `:3`/`:15`/`:16`/`:21`（`## 两种模式`）/`:23-29`（对照表）/`:27`/`:31`/`:68`/`:70` | 改：删模式对照表；`/skill` 补进命令说明 |
| `docs/DES.md` | `:7`/`:14`/`:88-95`（命令表）/`:117-125`（`## 7. 助手能力与安全呈现`，含 `:119`/`:121` Plan 说明）/`:129` | 改：`:123`/`:129` 不含模式措辞、删模式后仍成立，可只做核对 |
| `docs/INDEX.md` | `:43` 本方案入口 | 改：归档后更新指针 |
| `docs/plans/active/未完成工作与已知缺口.md` | `:36`/`:62`/`:14` FIX-13 | 改：撤销登记并改批次批注 |
| | `:74` FIX-61 | 改：**理由错位**——其原文理由是「Live 宿主无法构造 MCP 借不到的运行」，与模式无关；结论「无法由现有场景直接验证」保留，理由改为**前提不可构造**（待重放工具须为 `mcp_*` 且服务器借不到，Live 无真实 stdio MCP 连接），不要写成「只存在于界面呈现 / 宿主不渲染 UI」：提示经 `appendAssistantMessage` 落成助手条目并作为 `reply` 返回，会话文本可断言。真正失效的是 `testing.md:26` 的旧模式前提（该条本身保留） |
| | `:70` 「UI 未经人工查看」清单（含「工具策略声明区」） | 改：本批改了 ToolsTab 的 `audience` 列与三个开关，该清单不再准确 |

---

## 6. 实施工单

> **阶段之间不设独立门禁**（用户裁定「一次全做完再验证」）。阶段只表达**依赖顺序**：阶段 0 是纯删除，让后面所有新代码能在「mode 已不存在」的世界里一次写对。

### 阶段 0：编译面收敛（只删不加）

目标：让 mode 相关的字段与类型从全仓消失，`pnpm run test:types` 与 `test:rust` 能过。**本阶段不做语义决策**，只把「删掉之后必须立刻补上」的地方补成最保守的等价形态（例如权限裁决先落成决策 6 的统一形态），语义重定级放到阶段 3。

| ID | 位置 | 动作 |
|---|---|---|
| 0.1 | `tool/types.ts` | 删 `ToolMode`、`LightweightPolicy`、`ToolContext.mode`、`ToolDef.mode`、`ToolDef.lightweightPolicy` 及相关注释；`TOOL_POLICY_VERSION` → 2 |
| 0.2 | `tool/policy.ts` | 删 `LIGHTWEIGHT_POLICIES` 与 `:75-77` 校验（**保留 `:74`**）；从 `toolPolicyFingerprint` 移除 `mode`；改 `:69-71` 注释 |
| 0.3 | `tool/registry.ts` + `tool/index.ts` | 去模式过滤；`getToolsForMode`/`getToolDeclarations` 收敛（建议删函数、在调用点用全部已注册工具）；删 `registerAssistantTools`/`unregisterAssistantTools`；`registerDefaultTools` 吸收其注册内容并改注释；`tool/index.ts` 的 `:10/:46/:47/:52-53` 五个断点同步 |
| 0.4 | `tool/pi/harness-adapter.ts`、`harness-tool-adapter.ts` | 删 `:18` 的 `LightweightPolicy` 导入、`lightweightPolicy` 选项、工厂硬编码的 `mode: "pet"`、`HarnessToolRun.mode` |
| 0.5 | `tool/pi/tauri-execution-env.ts`、`tool/local/pi-tools.ts`、**`engine/pi/session-repo.ts`** | `TauriExecutionEnv` 去 mode 字段与构造参数（**两个生产构造点**：`pi-tools.ts:27`、`session-repo.ts:93`）；`createEnv` 改无参；四处 `ctx.mode` 收敛；`session-repo.ts:88-89` 注释同改 |
| 0.6 | Rust `bash_policy.rs` + `tool_exec.rs` | 删 `BashScope`/`BashPolicy`/`enforce_whitelist`/`first_control_syntax`；`enforce_bash_policy` 去 `scope`/`whitelist` 参数，固定执行「层 1 + `enforce_no_catastrophic_write`」；`tool_exec.rs` 去 `policy` 入参；重写两侧测试（四个测试助手全删，受影响用例逐个改写） |
| 0.7 | `safety/permission.ts` | 重写 `standardDecision`：`NOWAY→deny` / `SAFE→allow` / `NORMAL→allow` / `DANGER→safetyMode`；删 `:101` 模式检查与 `:105-110` pet 分支；删 `lightweightPolicy` 用法 |
| 0.8 | `engine/pi/runtime.ts` | 删 `TurnKernel.mode` / `TurnKernelOptions.mode` / `createCompactionHook` 的 `mode` 与全部透传；删**三处** `const mode = generalConfig.assistantMode`（`:881`/`:1740`/`:1834`）；`prepareRunCapabilities` / `buildPrompt` / `createTurnKernel` 调用点去参；**`:1525-1535` 的 Plan 恢复能力准备**同步 |
| 0.9 | `context/builder.ts` | 删 `BuildContextInput.mode`、`:111` 的 `getToolDeclarations(input.mode)`、`:116` 默认值；`:7` 的深路径导入随函数收敛 |
| 0.10 | `engine/planner.ts`、`agent/sub-agent.ts` | `:442-447` 与 `:142` 的 `getToolsForMode(...)` 收敛；`agent-tool.ts:21` 描述改为与变更后行为相符；`sub-agent.ts:29-30/:38` 自述同改 |
| 0.11 | `services/init.ts` | 删 `pendingCapabilityMode`/`requestConversationCapabilityMode`/`applyPendingConversationCapabilities`；`prepareConversationCapabilities`/`prepareRunCapabilities` 去 mode；`:110-113` 的 skill 门暂时移除（阶段 1 补指纹核对） |
| 0.12 | `App.vue`、`debug.ts`、四个 settings 组件、`profile/io.ts` | 去 mode 相关的 ref/expose/映射/控件/文案（逐一对照 §5.3；`ToolsTab` 的第二注册表实例一并简化；`runner.ts` 的**四处** `applyPendingConversationCapabilities` 全删） |
| 0.13 | 全部 live 场景与 `__tests__/live/*.ts` | **只保证编译**：删 `ToolDef.mode`/`ToolContext.mode`/`TauriExecutionEnv(…, mode)`/`getToolsForMode`/`buildPrompt({mode})`/`setOverride("general.mode.assistant", …)`（**16 处**）；语义重写放阶段 4。**`standard-setup.ts` 的基线在这一步就把快照里的 `general.mode` 段换成 `ai.plan.enabled: false`**——净效果与今天的 pet 基线一致（计划段不因基线而打开），也避免留下指向已删键的悬空 override |

**完成判据**（两个都要满足）：

```bash
# 1. 目标符号全清（docs/history 除外）
rg -n 'assistantMode|general\.mode|getToolsForMode|getToolDeclarations|lightweightPolicy|LightweightPolicy|ToolMode|SkillMode|SkillInvocationPolicy|BashScope|BashPolicy|enforce_whitelist|first_control_syntax' src src-tauri scripts

# 2. 残留的 mode 命中全部落在 §4 的「同名不同义」白名单里
rg -n '\bmode\b' src/services src-tauri/src
```

第 1 条漏掉了 `builder.ts`、`compactor.ts`、`session-transcript.ts`、`local-extra/*`、`session-repo.ts`、`harness-slot.ts`、`mcp/client.ts`、`loader.ts` 等文件里的裸 `mode` 字面量，所以**必须配第 2 条**才闭合。

### 阶段 1：Skill 换 Pi 三层

| ID | 位置 | 动作 |
|---|---|---|
| 1.1 | `src/services/skill/store.ts`（新） | 持有 `Skill[]` + 目录指纹 + `diagnostics[]`；`syncSkillCatalog()` = 先做 1 次指纹 IPC，变了才 `loadSkills(new TauriExecutionEnv(await TauriExecutionEnv.defaultCwd()), [skillsDir], BACKGROUND_CONTEXT)`；按 frontmatter `enabled` 过滤 |
| 1.2 | Rust `skill_cmd.rs` + `lib.rs` + `commands/mod.rs` | 改为只回 `{fingerprint, count, truncated}` 的轻量扫描（mtime/size）；命令**如实改名**（建议 `skill_catalog_fingerprint`）；`MAX_SCAN_ENTRIES` 保留、`MAX_CATALOG_ENTRIES` 退化为计数上限；`count` 的口径先定义（现有 `directory_count` 计的是所有 readdir 条目含文件） |
| 1.3 | `src/services/skill/loader.ts` | 重写：删 catalog/TTL/generation/`parseFrontmatter`/`parseSkillSource`/`MAX_*`（保留 `MAX_SKILL_BYTES` 与 `MAX_PROMPT_CHARS`）/类型；**保留** `upsertSkill`（校验真相源 = Pi loader）、`deleteSkill`、种子与恢复覆盖语义；删死分支 `"dispose"`；**处理 `refreshSkills` 与 `profile/io.ts:240-241` 的消费者**；删 `:169` 的 `skillEnabled` 硬门（决策 8 的落点） |
| 1.4 | `src/services/skill/index.ts` | 导出面随 1.3 收敛 |
| 1.5 | `getSkillsPromptBlock` | 内部换 `formatSkillsForSystemPrompt` + 外层预算（超限 `log.warn` 报「丢了几条」，不再静默）；拼装位置仍在 `builder.ts:136` 的 `static:skill-catalog` 块 |
| 1.6 | `harness-slot.ts:1250` `assembleLane` | 加 `setResources({ skills })`——**per-harness 配置，必须早于 `accept`**，否则 `UnknownSkill`；**同时扩 `Pick`**（现不含 `prompt`，也不含任何 skill 字段） |
| 1.7 | `harness-slot.ts:1039` `admitInput` + `:187` `HarnessAdmitSpec` | 支持 `{ kind: "skill", name, additionalInstructions }`，按 kind 构造 lane request；**`kind: "skill"` 时 `prompt` 传空**，避免一条命令落两条用户正文 |
| 1.8 | `engine/slash/{types,registry}.ts` + `preprocessor.ts` + `runner.ts` + `runtime.ts` + `commands/index.ts` | **决策 4 的通路，三件事必须一起做**：① `SlashCommand` 加参数通道（`execute` 现为 `() => Promise<string \| null>` 零参）；② `find()`（现为整串精确匹配）要为声明了「可带参数」的命令做最长前缀匹配并把余下文本作为参数传入——注意 `name` 可以含空格（`win open`），精确匹配要优先；③ `preprocessor` 的 `handled: true` 短路要携带「启动一次 skill 准入」到 `harnessSlots.begin()`。连带 `search()`（下拉框）与 `/help` 分组。参数通道的具体形状见 §8.2 |
| 1.9 | `personality/stages-file.ts` + `stages-cache.ts` + `stages-prompt.md` | **AGENTS.md 硬不变量**：在 `CommandReplies` 加 `/skill` 的终态句 key → 同步 `FALLBACK_COMMANDS`(`:46`)、`COMMAND_KEYS`(`:164`)、`normalizeCommands`(`:312-316`)、`validateStages`(`:194`)、**`validateStagesForCard`(`:206`)**、**`:491` 的全覆盖判定**、`stages-prompt.md`；**旧缓存必须判过期重生成**（`stageSourceHash`），否则新 key 永远取不到 Card 文案。同时改 `阶段文案链路.scene.ts` 的 `PROBE_STAGES` |
| 1.10 | `store.ts` + `ToolsTab.vue` | 每技能 `enabled`：frontmatter 读取过滤 + 设置页逐项开关 + 切换时「读原文 → 改 `enabled` 行 → `file_write_atomic` 写回」；`:42` 的 `skillList` 类型与 `:193-228` 的加载/删除/上传三段一并改 |
| 1.11 | `services/init.ts:110-113` | 挂上每回合指纹核对（`prepareRunCapabilities` 内，主回合 `runtime.ts:918`、续跑 `:1753`、**Plan 恢复 `:1535`** 三处都会走到） |
| 1.12 | 文案 | `/skill` 的成功与失败句（未知名、无正文、被关闭）全部走 `getCommandReply` / `getFallbackReply`，源码不留硬编码台词 |

### 阶段 2：Tool 优化与补齐

| ID | 位置 | 动作 |
|---|---|---|
| 2.1 | 新 `ReadImageProcessor` + `pi-tools.ts:28` | WebView canvas 缩放（长边 ≤1568px）+ BMP→PNG，接进 `createReadTool({ imageProcessor, autoResizeImages: true })`。**形状必须照 Pi 的类型**：4 参 `(bytes, mimeType, {autoResizeImages}, context)`，返回判别式联合 `{ok:true, data, mimeType, hints} \| {ok:false, message}`。**「失败回退原图」只能由 processor 自己 base64 编码原图并返回 `{ok:true}`**——Pi 在 `{ok:false}` 时只输出一段文本，图片 part 完全不出现。另注意 `runtime.ts:1981-1988` 的投影在超预算时丢弃非文本 part |
| 2.2 | `mcp/client.ts:15-22/:175-179` + `mcp/index.ts:36` | 删 `MAX_MCP_RESULT_CHARS` 与截断分支，重写 `:15-21` 的论证注释；确认全文落条目 + L0 投影（`context/tool-output.ts:48-70`）可用；**上限的真实位置是 `tauri-execution-env.ts:33 MAX_TOOL_FILE_BYTES`**（会话条目写盘链），超限处置见 §8.8 |
| 2.3 | `context/builder.ts:99-103` | `composeDynamicPrompt` 注入当前日期与时间，落 dynamic 层（`builder.ts:139` 的 `dynamic:runtime` 核心块）；确认 `runtime.ts:481-486` 的 `cache.prefixHash` 只哈希 `layer === "static"`，`staticPrefix` 也不含它 |
| 2.4 | `tool/local/system.ts` + Rust `tool_exec.rs:1083-1112` + `:1112-1209` + `:1631-1647` | `system_info` 改写：OS / 架构 / CPU 核数 / 总与可用内存 / bash 默认工作目录（后者 TS 侧取 `TauriExecutionEnv.defaultCwd()`）。Rust 新增可用内存字段 → **三处**：结构体、构造字面量、`get_memory_info()`（**含 macOS 分支新增 available 口径**）；同步 camelCase 契约测试 |
| 2.5 | `window/listener.ts` + 新工具 | listener 缓存最近一次 `window-changed` payload（`{title, content, is_pet_visible}`，**线上不带时间戳**，`observedAt` 由宿主补）并导出 getter；新增只读工具（建议 `window_info`，`actionCategory` **必须复用既有闭集**，用 `os.info`，策略照 `local/system.ts:30-35`）；`windowMonitor.enabled=false` 时如实返回「未开启」。**缓存必须放在 `listener.ts:29` 的 enabled 早退之后**，否则关闭时仍会拿到有效 payload。命名与字段见 §8.3 |
| 2.6 | `engine/pi/runtime.ts:1883-1903` `runPiSubAgent` | 在 `input.tools` 上剥离派生型工具（现只有 `agent_spawn`）；**不**在 `planner.ts`/`sub-agent.ts` 维护第二份白名单。同步评估 `planner.ts:428-441` 的硬失败翻转 |

### 阶段 3：配置与语义收尾

| ID | 位置 | 动作 |
|---|---|---|
| 3.1 | `services/config.ts` | 删 `assistantMode`(`:401`)/`fileWriteEnabled`(`:592`)/`mcpEnabled`(`:594`)/`skillEnabled`(`:599`) 四个 getter 与 `:60`/`:136-145` 的类型声明（**`:595`/`:596` 的 `mcpServers`/`builtinMcpServers` 保留**）；`computeMcpEnabled()` 改为「至少一个服务器启用」的派生值，保留「派生值不回写设置页」的分工，谓词与 `init.ts:99-101` 同源 |
| 3.2 | `services/init.ts:92-115` | MCP 段改为「遍历全部服务器，跳过未启用者」；无总闸 |
| 3.3 | `GeneralTab.vue` / `AITab.vue` / `ToolsTab.vue` / `SettingsPanel.vue` | 逐一对照 §5.3：删模式块、`AITab` 的死 `mode` 字段、四处映射、`fileWriteEnabled`/`mcpEnabled`/`skillEnabled` 控件与 `audience` 列；`ToolsTab` 的 Skill 区改为逐项开关；**用户可见文案随行为同步**（`:296`/`:301`/`:324-328`/`:369-370`） |
| 3.4 | `App.vue:688-711` | 删 `previousAssistantMode` 与 `requestConversationCapabilityMode` 分支；核对 `:698-699` 的 `invalidateSkillCatalog("config")` 在新指纹模型下是否仍需保留 |
| 3.5 | `CONFIG.yaml` + `CONFIG-DEV.yaml.example` | 删 `general.mode`、`tools.file` 整块、`mcp.enabled`、`tools.skill` 整块；**`builtin.filesystem` 与 `builtin.playwright` 的 `enabled` 改 `false`** |
| 3.6 | `engine/compactor.ts:18-21/:32/:81-82` | 合并 `SUMMARY_MODE_INSTRUCTIONS` 为一套（文案见 §8.1） |
| 3.7 | `clipboard.ts:24` / `agent-tool.ts:34` / `mcp/client.ts:155` | 权限重定级：NORMAL → **DANGER**（决策 6） |
| 3.8 | `mcp/manager.ts:328/:350` | 按决策 8 的口径确认「MCP 工具进入所有回合/子代理/计划步骤」是期望行为，并写进 `tool-system.md` |

### 阶段 4：验证收口

见 §7。**本阶段不含新功能**，只做契约重生成、场景重写/新建、门禁与文档同步。

---

## 7. 验证与门禁

### 7.1 静态门禁

```bash
pnpm run test:types   # Vue 类型 + Rust 编译
pnpm run test:rust    # Rust 单测（bash_policy.rs 与 tool_exec.rs 均已改写）
```

### 7.2 契约重新 analyze → generate（**8 份**）

`tool-execution`、`safety`、`agent-runtime`、`planner`、`harness-storage`、`memory`、`personality-card`、**`variable-pool`**。

- `tool-execution.contract.ts` 的 `sourceFiles` 需新增 `src/services/skill/store.ts` 与 `src/services/agent/sub-agent.ts`。
- **不得只刷 `sourceHash`**：`sourceHash` 只覆盖声明的字面路径，无 glob、无依赖闭包。行为变了必须重新 analyze → generate。
- 契约**正文描述**也要改，不能只动 hash：`safety` 的 sf-02/sf-03/sf-04/sf-12/sf-16、`tool-execution` 的 te-11/te-13/te-15、`memory` 的 mm-11 都在正文里写了双模式或旧机制。

### 7.3 场景

- **改写**：§5.8 A 节全部，重点是四个 memory/agent-runtime 侧的探针场景与 `standard-setup.ts` 的基线改钉。
- **新建**：§5.8 B 节 11 项。
- **`LIVE_DATASET_VERSION`**（`dataset.ts:10`）递增；`:18` 有格式校验；`live-test-main.ts` 是第二个消费点。
- `entry: production` 场景必须经 `sendMessage()`；fake 只替换 Provider，工具与 IPC 行为仍需场景断言。**本批 44 个 production 场景的计划门禁会随决策 5 由关变开**（§8.6），必须靠基线改钉收住。

### 7.4 发布门禁

```bash
pnpm run test:release   # 类型/编译 + Rust 单测 + 严格 Contract + ≥3 trial
```

严格 Contract 与至少三次 trial；跳过/超时**不得**报通过。

### 7.5 Windows 分支必须走 CI

`bash_policy.rs`、`tool_exec.rs`、`TauriExecutionEnv` 的改动两端都跑。本机 macOS check **不证明** Windows 分支，现有本机交叉构建也不能替代 Windows job。决策 13 的 `get_memory_info()` 是 Windows/macOS/Linux 三条件编译分支，**尤其必须等 Windows job**。

### 7.6 文档同步（在门禁之后、交付之前）

按 §5.9 全表执行。重点是三处**前提消失**的登记：`未完成工作与已知缺口.md:36/:62`（FIX-13）、`:70`（UI 清单）、`testing.md:26`（恒 pet 前提）。

### 7.7 交付必须说明的未验证项

- 真实本地 `CONFIG-DEV.yaml` 未同步（需单独授权）。
- 技能正文常驻请求视图的 token 成本（§8.4）只有静态核算，无实测。
- `policyHash` 全量失效的真实量级与影响面（§8.5）。
- UI 入口（模式块删除、Skill 逐项开关、`/skill` 返回文案）Live Test 宿主不渲染 UI，只有协议级证据。
- 决策 14 的窗口工具在 Live 宿主里拿不到 payload（§8.10），两态场景只有「未开启」一侧可断言。
- 决策 16 的子代理工具面在契约与场景里都没有门禁（§5.7/§5.8 B），只有新建场景后才有断言。

---

## 8. 未定项与风险

### 8.1 压缩摘要指令（决策 9，已定）

现值（`compactor.ts:19-20`）是两套：`pet` 走「称呼、用户明确偏好、关系连续性、最近纠正、未完成话题；事实和角色扮演分开」，`assistant` 走「目标、约束、决定、工具实际结果、文件路径、未完成任务；未知副作用明确标记」。

**合并为一套**——两个口径的并集（一边都没删），功能性那半在前、人格那半用「同时保留」接住：

> 优先保留目标、约束、决定、工具实际结果、文件路径、未完成的任务与话题，未知副作用明确标记；同时保留称呼、用户明确偏好、关系连续性与最近纠正，把事实与角色扮演分开。

**为什么这个顺序**：功能性那半（工具实际结果、文件路径、未知副作用）丢了，模型会忘记自己刚做过什么、基于错前提往下走——是当场出错的类型；人格那半（称呼、关系连续性）丢了是体验漂移。第一段读起来优先级更高，所以把会出错的放前面。

### 8.2 `/skill` 的参数通道形状（决策 4，已定）

`SlashCommand.execute` 现在零参、`find()` 整串精确匹配，参数无处接收。**采用「扩 `SlashCommand`」：**

- 加一个「可带参数」标志，`execute` 接受余下参数文本。
- `find()` **先精确匹配**（保住 `win open` 这类含空格的命令名），未命中再只对**声明了可带参数**的命令做最长前缀匹配，把余下文本作为参数传入。
- 连带 `search()`（下拉框）与 `/help` 分组（`help.ts:6/:16`、`runtime-contract.md:20`）。

被否掉的「按技能目录动态注册独立命令」：目录一变就要重注册，与决策 1 的指纹驱动刷新耦合，下拉框会被技能名塞满。

### 8.3 窗口工具的命名与字段（决策 14，已定）

工具名 `window_info`，`window_` 作为窗口族的命名前缀（后续窗口类工具沿用）。返回 `{ title, content, observedAt }`。`observedAt` 由宿主在收到 payload 时打时间戳（Rust 侧线上载荷只有 `{title, content, is_pet_visible}`，不带时间）。`safetyLevel: "SAFE"`，`actionCategory: "os.info"`（**不新增类别**，见 §8.9），策略照 `local/system.ts:30-35`。

### 8.4 已知成本：技能正文常驻请求视图（决策 4）

`accept({kind:"skill"})` 在 Pi 侧固定造成一条 `role: "user"` 消息（`lane.js:349-365` → `formatSkillInvocation`），宿主无法改变它的角色；落盘的正文是 `<skill name="…" location="…">…</skill>` 整块（含技能文件的**绝对路径**）加额外指示，不是用户敲的 `/skill name` 原文。按决策 4 不做投影，正文会留到被压缩覆盖。相比今天经 `read` 取回（`pi-read` 是 `resultProjection: "reference"`，会被 L0 缩成 eventId 地址），这是**为技能黏性付出的 token 成本**。已登记为已知成本；实测真嫌大时再启用投影（那需要扩大 `createProjectionHook` 的作用域，**不需要**动 `entryProjectors` / `toProviderMessages`）。

### 8.5 已知连带：`policyHash` 全量失效（量级已核实）

`toolPolicyFingerprint` 把 `mode` 算进策略身份（`policy.ts:113`，fingerprint 共 12 个字段）。删 `mode` 并递增 `TOOL_POLICY_VERSION` 后，**所有工具**的 `policyHash` 变化。

真实影响面分两层：

- **会话内授权**：`permission.ts:71` 的 `grants` 是**模块级内存 Map**、`CONFIRM_TTL_MS = 5 * 60 * 1000`，不落盘、不过进程。所以失效范围只是「当前进程内、5 分钟内、同 session/generation 的同参授权」——用户会看到原本不再弹确认的操作重新弹一次。**不是**跨重启的持久失效。
- **审计落盘**：`tool/router.ts:23` 把 `policyHash` 写进工具结果条目的 `details.audit`，`runtime.ts:409` 写进 PromptSnapshot，两者都随会话条目落进 JSONL。改完 hash 后历史条目与新条目不同——不破坏任何判定，但 `memory.contract.ts` 的 mm-11 把「策略任一维度变化都会改变快照身份」当成断言点，**契约正文需重审**。注意 `policyHash` 有**三个计算点**（`harness-tool-adapter.ts:49`、`router.ts:20/:23`、`runtime.ts:409`），改 `toolPolicyFingerprint` 会同时改三处输出。

`tool_permit.rs` 的许可池**不存策略身份**（只认 `PermitKind`/`Borrower`/`request_id`），不受影响。

### 8.6 已知翻转载荷：计划门禁（决策 5）

`runtime.ts:954` 从 `mode === "assistant" && planConfig.enabled` 改成只看 `planConfig.enabled`；而 `planConfig.enabled` **默认 `true`**（`config.ts:530`）、出厂即 `true`（`CONFIG.yaml:86`、`CONFIG-DEV.yaml.example:44`、真实 `CONFIG-DEV.yaml:79`）。

现状之所以安全，全靠 `standard-setup.ts:94-99` 钉住了 `general.mode.assistant: false`——那段注释自己写明了这个机制，并刻意**不**钉 `ai.plan.enabled`。

删掉模式后，**所有 production 场景的计划门禁默认打开**：用户文本命中复杂度关键词（阈值 3）就会走进真实计划段（`planner.ts:68-72`、`runtime.ts:967`）。当前 44 个 production 场景里只有计划类会命中关键词，所以这一批不会立刻炸；但这是隐式行为翻转，任何含「分析/整理/重构/修复/审查/合并/总结/生成/创建项目」字样的场景文本都会静默进入计划段。

→ **`standard-setup.ts` 的处置是改钉 `ai.plan.enabled: false`，不是删除基线。**

### 8.7 已知坑：投影会丢非文本 part

`runtime.ts:1981-1988` 在结果超预算时把内容重建成 `[{type:"text", text: projected}]`——**非文本 part 被丢弃**。今天因为被投影的都是长文本结果所以无害，但两个决策踩在这条路上：决策 10 的图片、决策 11 的 MCP 结果（同一个 `projectToolResultMessage`）。实施 2.1/2.2 时需实测确认（图片结果通常走不到超预算分支，但不默认它成立）。

### 8.8 MCP 结果超过条目写盘上限时的兜底（决策 11，已定）

删掉 50,000 截断后，唯一的物理上限是 `tauri-execution-env.ts:33` 的 `MAX_TOOL_FILE_BYTES = 5 MB`，它作用在 `file_write`/`file_append` 上——也就是**会话条目的写入上限**。超过它时写盘会失败，而不是被截断。

**裁定：如实报错。** 工具调用失败，并把真实原因（写盘超限）交给用户，不做静默截断——静默截断正是决策 11 要删掉的东西。交付里要说明「超大 MCP 结果会失败而不是被悄悄砍掉」，并实测常见 MCP 工具（尤其 Playwright 截图、filesystem 大文件读取）的真实返回体量，确认这个上限不会在日常使用中频繁触发。

### 8.9 连带约束：不要新增 `ActionCategory`

`ActionCategory`（`types.ts:70-77`）是**闭合联合**：`fs.read`/`fs.write`/`os.exec`/`os.info`/`net.fetch`/`app.launch`/`clip.read`/`clip.write`/`agent.call`/`_default`。新增一个类别会同时触发第三条全链：`stages-prompt.md:13/:70/:86/:98`、`stages-cache.ts:65/:382` 的 keys 数组、`validateStages`。决策 14 的 `window_info` 与决策 13 的 `system_info` 都**复用 `os.info`**，本批不需要新类别。

同理，`mcp/client.ts:167` 的 MCP 工具用 `_default`，MCP 提级到 DANGER 不改这一项。

### 8.10 可验证性缺口：窗口工具在 Live 宿主里没有 listener

`initWindowListener` 只在 `App.vue:613` 被调用；Live 宿主（`live-test-main.ts` 的 `initPaths`/`initConfig` + `standard-setup.ts:34-41` 的 `bootstrapOnce`）**不挂 listener**。Rust 侧 `spawn_monitor_thread`（`lib.rs:361`）却是无条件启动的，会 emit 到没有监听者的窗口。

→ §5.8 B 的「窗口工具两态」场景在宿主里**拿不到 payload**，只有「`enabled=false` 如实返回未开启」这一侧可断言。要么在宿主补挂 listener，要么把这一项登记为「只有协议级证据」，不要写成完整覆盖。

### 8.11 风险：一次全做完再验证

用户已裁定「一次全做完再验证」。代价要说清：本批改动面跨 **8 份契约、约 35 个场景、2 份 Rust 测试模块、约 20 份文档**；若最终严格门禁失败，需要在**一个很大的 diff** 上定位。§6 的阶段划分刻意让阶段 0 是纯删除、阶段 4 不含新功能，就是为了在这种模式下缩小定位面。**若中途出现难以定位的失败，建议就地插入一次 `test:types` + `test:rust` 的局部检查**（不等于分段门禁）。

### 8.12 交接

实施完成后：正文与证据归档到 `docs/history/implementation/Skill与Tool收敛及模式统一方案-<日期>基线.md`；`docs/INDEX.md:43` 与 `未完成工作与已知缺口.md:14` 改指针；本页从 `plans/active/` 移除。
