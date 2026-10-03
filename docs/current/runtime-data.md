# 运行时数据与配置

本文维护配置、路径、文件布局和资源所有权。会话事件与压缩协议见[当前记忆](memory.md)，运行代际与恢复见[运行时契约](runtime-contract.md)。

## 配置与环境

Rust [AppPaths](../../src-tauri/src/paths/mod.rs) 依据 `cfg!(debug_assertions)` 决定路径环境；前端通过 [paths.ts](../../src/services/paths.ts) 的 `getRuntimeMode()` 获取，不以 Vite 的构建模式推断。

| 环境 | 数据根 | 运行时 CONFIG |
|---|---|---|
| 开发调试构建 | `{project}/data/desk-pet/` | 工作区 `CONFIG-DEV.yaml`，不存在时用 `CONFIG.yaml` |
| 生产发布构建 | Tauri 应用标识专属 `app_local_data_dir` | `data_root/settings/CONFIG.yaml`，首次由内置默认配置初始化 |

`CONFIG-DEV.yaml` 是完整文件，不是增量覆盖层；生产忽略工作区开发配置。设置页、导入导出和运行期 getter 使用同一份配置。开发副本由用户从模板创建，不能为同步默认值而覆盖已有本地配置。

## 配置变更同步清单

[AGENTS](../../AGENTS.md#单一真相源与模块落位)要求 YAML 运行时 CONFIG 字段变更检查完整链路。新增、改名、删除，以及默认值、类型、单位或语义变化都适用；“同步”不代表各环境必须使用相同的值。环境变量、构建或测试开关按各自定义与消费者同步，不要求增加 YAML 字段或设置控件。

| 环节 | 必须核对和同步的内容 |
|---|---|
| 默认配置 | [CONFIG.yaml](../../CONFIG.yaml) 的键、类型、默认值、单位与注释；它也是首次生产初始化来源 |
| 开发模板 | [CONFIG-DEV.yaml.example](../../CONFIG-DEV.yaml.example) 的对应定义；开发端点/密钥等可保留占位值 |
| 真实开发副本 | CONFIG-DEV.yaml 是完整文件，需单独授权后更新；保留用户已有值，未同步须交付说明，不能用模板覆盖本地配置 |
| 类型与运行期读取 | [config.ts](../../src/services/config.ts) 的 Config、类型化 getter/setter 与默认/兼容逻辑；模块不复制默认值 |
| 设置显示与编辑 | 对应 [settings Tab](../../src/components/settings/) 的初值读取、ref、控件、校验和 defineExpose；检查数值范围、枚举与单位换算 |
| 保存映射 | [SettingsPanel.vue](../../src/components/settings/SettingsPanel.vue) 的 doSave/setOverrides、setOverride 或 userConfig setter；不能只在 Tab 暴露字段 |
| 落盘与生效 | serializeConfig/flushConfig 写入同一运行时 CONFIG，保存后通知及读取方刷新；声明字段是即时生效、下一 run 生效还是需重启 |
| 说明 | 对应 current 文档解释语义/单位/生效时机；影响用户操作时更新 README/DES，改变全局规则时更新 AGENTS |

新字段若按产品范围决定不提供设置控件，必须在对应文档说明用途与文件修改入口，不能把漏接 UI 当作默认豁免。改名/删除还需定义旧用户文件的兼容、迁移或忽略语义，清理旧 UI 映射与消费者；当前配置初始化不会自动把缺失字段与默认 YAML 深合并。

当前主保存路径为：Tab 控件 → defineExpose → SettingsPanel.doSave → setOverrides/userConfig setter → config 写队列 → flushConfig → deskpet-settings-saved。主窗口、角色展示与图层编辑器分别处理刷新；字段是否即时生效取决于具体消费者，不能只以事件已发出为完成依据。Profile 素材和参数有自己的保存路径，不强行塞进 CONFIG。

例如窗口冷却的 getter/CONFIG 使用毫秒，AITab 给用户显示秒，SettingsPanel 保存时换算回毫秒；日志设置读取配置值，运行期才应用 dev 的 debug 覆盖。这两类边界不能混入 getter 导致保存污染。

设置改动完成后集中核对“修改 → 保存 → 文件回读 → 运行期读取 → 关闭重开设置”的往返；涉及跨窗口、模式或重启生效时一并核对对应消费者。类型检查不能发现字符串配置键漏映射或单位错误；本清单是后续变更的验收要求，不表示本轮文档修改运行了这些验证。

模块只经类型化 getter 读取。`serializeConfig()` 保留文件头注释块，正文由 js-yaml 重排，不承诺保留正文注释或原格式。

### 对话投递字段的语义与生效时机

| 字段 | 取值 | 语义 | 生效 |
|---|---|---|---|
| `ai.conversation.defaultDelivery` | steer / followUp | 忙碌时未显式选择意图的默认投递方式（插话 / 稍后继续） | 下一次发送即读取；聊天框的单条显式选择优先 |
| `ai.conversation.steeringMode` | all / one-at-a-time | 插话在同一安全边界前一起进入下一次请求，或逐条处理 | 每个 run 开始前下发，按运行冻结；不重排已排队项 |
| `ai.conversation.followUpMode` | all / one-at-a-time | 稍后继续的后续消息集中处理或逐条保留话题边界 | 同上 |

三个字段由 [AITab](../../src/components/settings/AITab.vue) 的「对话投递」读取与回写、经 SettingsPanel 的 setOverrides 落盘，运行期只经 [config.ts](../../src/services/config.ts) 的 `conversationConfig` getter 读取；未知取值一律按保守默认（steer / all / one-at-a-time）解释，不把非法值透传给运行内核。

### 工具并行上限字段的语义与生效时机

| 字段 | 取值 | 语义 | 生效 |
|---|---|---|---|
| `ai.loop.maxParallelTools` | 1–8 的整数，默认 4 | 同时执行的只读（`shared_read`）工具数上限；效果类工具始终与其它执行互斥，不受它影响 | 每个 run 开始前下发给 Rust 许可所有者，运行期间不撤销已借出的额度 |

由 [ToolsTab](../../src/components/settings/ToolsTab.vue) 的「工具执行」读取与回写、经 SettingsPanel 的 setOverrides 落盘，保存后由 `deskpet-settings-saved` 触发的 `reloadConfig()` 生效；运行期只经 [config.ts](../../src/services/config.ts) 的 `loopConfig.maxParallelTools` 读取，并发所有权仍在 [tool_permit.rs](../../src-tauri/src/commands/tool_permit.rs)。`MIN/MAX/DEFAULT_PARALLEL_TOOLS` 与所有者的默认值和范围同值，是给设置页校验与 YAML 兜底用的 UI 校验副本，不构成第二个所有者。

非法值不静默接受：手写 YAML 的非数值按默认值、越界值收拢到最近边界（getter）；设置页保存前用 `parallelToolsError()` 拒绝越界输入；Rust 许可所有者收到 1–8 之外的下发直接报错而不夹边界（上限 0 会让所有读永久排队）。降低上限暂停新获准执行，提高会唤醒有序等待项。

### 复杂度评估字段的语义与生效时机

| 字段 | 取值 | 语义 | 生效 |
|---|---|---|---|
| `ai.plan.complexityEval` | keyword / llm，默认 keyword | 未命中关键词时是否再发一次独立模型请求自判复杂度 | 保存后下一次 `sendMessage` 即生效；`--plan` 强制触发不受它影响 |

由 [AITab](../../src/components/settings/AITab.vue) 的「计划模式 · 复杂度判定」读取与回写、经 SettingsPanel 的 setOverrides 落盘，运行期只经 [config.ts](../../src/services/config.ts) 的 `planConfig.complexityEval` 读取。`keyword` 下未命中关键词直接返回低分（不发起请求，复杂度判定只由关键词与 `--plan` 驱动）；`llm` 下未命中关键词再发一次独立请求自判，失败按跳过 Plan 处理并把原因写进判定结果。

### Bash 白名单字段的语义与生效时机

| 字段 | 取值 | 语义 | 生效 |
|---|---|---|---|
| `tools.bash.whitelist` | 命令名数组，出厂 CONFIG 18 项（getter 另留 15 项兜底，同值子集） | 命令首词命中、不含 shell 组合符且未命中危险/硬禁止模式时判 `NORMAL`、免确认；它是**免确认通道**而不是硬墙 —— 不在名单只意味着要走确认，命令仍可执行 | 每次风险分级即时读取；设置页保存后经 `deskpet-settings-saved` 触发的 `reloadConfig()` 生效 |

由 [ToolsTab](../../src/components/settings/ToolsTab.vue) 的「Bash 白名单」逐行读取与回写、经 SettingsPanel 的 setOverrides 落盘；运行期只经 [config.ts](../../src/services/config.ts) 的 `toolsConfig.bashWhitelist` 读取，分级消费点是 [pi-tools.ts](../../src/services/tool/local/pi-tools.ts) 的 `classifyBashRisk`。Rust 侧不再看白名单：[bash_policy.rs](../../src-tauri/src/commands/bash_policy.rs) 的 `enforce_bash_policy` 只有层 1 硬基线与层 2 系统路径保护，也不接收 scope / whitelist 入参，拒绝结论与名单无关。

## 路径与文件布局

```text
data_root/
├── settings/       生产 CONFIG 与默认资源初始化标记
├── memory/         memory.sqlite3（记忆库）、V1RTUAL.md（人工指令）、exports/ 与 backups/
├── sessions/       聊天正文 JSONL（JsonlSessionRepo，每会话一个文件，归属按文件头 cwd；写入以追加为主，已回收 key 的写入行由折叠清理）与 index.json 可丢弃 UI 状态
├── personality/    cards/、stages/{cardId}.json
├── profiles/       {profileId}/ 下的 Profile 与素材
├── skills/         {name}/SKILL.md（per-skill `enabled` 开关；Pi 递归遍历、根级 `.md` 也算技能、name 可缺省取父目录名）
└── logs/           运行日志
```

TS 先执行 `initPaths()`；`BaseDirs` 只给目录，需要完整路径时用 `runtimePath(scope, ...segments)` 交给 Rust 拼接和校验。业务文件名由所属模块管理。

Rust 持有 base 的命令接收域内相对路径，例如 personality 命令接收 `stages/x.json`，不能传 `personality/stages/x.json`。通用文件 API 接收绝对路径时由 runtimePath 生成。写入需校验目标/父目录与符号链接边界，不能在 canonicalize 失败后静默退回原路径。

聊天正文以 `sessions/` 的 JSONL 保存（条目 + commit 事务，JsonlSessionRepo）；启动经会话仓库列出恢复，再用 index.json 恢复标签和未回复数；丢失 index 不丢正文。会话归属按文件头 `cwd` 判定（不是按 `--<cwd>--` 目录名猜）：数据根变更或目录编码碰撞会产生不属于当前数据根的会话，列举结果里 `cwd` 与当前数据根不同的项由列举方记一次日志（去重）留证，不静默清除 index.json 里的旧 id。格式细节见[当前记忆](memory.md)。

会话 JSONL 是 append-only 日志：帧（`pi.pending.assistant_frame`）的每次流式增量都追加一行，`list/delete` 与 `value/delete` 只追加一条删除记录，被删 key 的历史写入行不会自动消失。因此会话文件会在安全时机被**纯删除式折叠**（[session-fold.ts](../../src/services/engine/harness/session-fold.ts) 的 `foldSessionFile`）：只回收已被 `list/delete` 与 `value/delete` 删除的 key 在**最后一次 delete 之前**的全部 `list/append` 与 `value/set`（key 在 namespace 内唯一标识一个地址，参考数据中删除后又被写入的形态实测出现 0 次；折叠器仍不假定这一点 —— 只丢「最后一次 delete 之前」的写入，delete 之后又被写入的 key 不会被误删，delete 行本身永远保留）；**保留行逐字不变，entryId 与 seq 不变**，entry/usage 行一个不动 —— 折叠不是删除历史。写盘前须**折叠前后重放状态摘要一致**（`sha256Text(stableSerialize(replayLogState(...)))`），不一致就放弃折叠、保留原文件（磁盘未改动）；替换走**同目录临时文件 + `rename` 原子替换**。header 不是当前支持的 v4 格式 + `storageVersion: 1` 时整文件跳过（安全降级：不抛错、不影响会话功能，首次按版本值留一条 warn）。折叠只解决体积，不改变「打开会话 = 全量读 + 逐行重放」的复杂度；成功折叠不可逆、没有回滚路径，安全防线只有摘要比对与原子替换。

触发时机：① 会话经 `releasePiSession` 关闭之后（回收主路径；先等 `session.close()` 与帧缓冲 flush 收尾再折叠，失败只留痕）；② `open` 前按需兜底（只针对未被干净关闭的会话），仅当文件超过 `FOLD_POLICY.minFileBytes` 才读全文判定。「压缩提交后」经评估不做（挂点在压缩层，需求已被前两者覆盖）。折叠失败或跳过一律不影响会话功能。

折叠阈值是源码常量 `FOLD_POLICY`（与 `foldSessionFile` 同在 [session-fold.ts](../../src/services/engine/harness/session-fold.ts)，唯一可调点），**不是** YAML 运行时 CONFIG 字段，不适用上面的配置同步清单：`minFileBytes = 512 KiB`（不超过它不探测）、`minReclaimBytes = 128 KiB` 与 `minReclaimRatio = 0.15`（可回收字节须同时达到二者），三者 AND，维持现值（用户 2026-09-28 定稿）。

Live Test 在 debug 且 `DESKPET_E2E=1` 时只接受启动脚本创建的 `test/.tmp/e2e-*` 隔离根（校验真实路径）。完整配置复制到该根的 `settings/CONFIG.yaml`，测试读写均走此副本；未提供有效根直接报错，不回退真实开发数据。退出先留存 trace/manifest/结果，再清理。隔离边界与报告位置见[测试 README](../../test/README.md)，不把测试目录当作正常用户数据位置。

## 默认资源与 Profile

[随包资源](../../src-tauri/resources/defaults/) 只作首次种子，复制后写入 `settings/.default-resources-seeded`。运行时只读写 data_root；默认和用户 Card/Profile/Skill 没有两套编辑权限。标记存在后删除资源不会自动恢复。

设置页“恢复默认资源”调用 [restore_default_resources](../../src-tauri/src/commands/resources_cmd.rs)，**覆盖运行时同名种子文件**，会丢弃这些文件的用户改动；种子之外的用户自建文件保留。同步是「种子里有的文件逐个覆盖或补齐」，不删除种子外的条目；Skill 的 per-skill `enabled` 就写在种子 SKILL.md 的 frontmatter 里，所以种子技能上的开关会随恢复一起回到种子值。

Profile 导入、复制和编辑写入 `profiles/{profileId}/`；选择保存在 `appearance.activeProfile`。效果所有权为：

| 数据 | 唯一所有者 |
|---|---|
| 展示模式 off/parallax/dof | CONFIG 的 `appearance.effectMode` |
| 灵动图层全局强度 | CONFIG 的 `appearance.parallax` |
| 全局字体（家族与字号） | CONFIG 的 `appearance.font`（系统已安装字体，不随 Profile） |
| 每层素材和参数 | 当前 Profile 的 `theme.parallax.layers` |
| 景深素材、取景和焦点参数 | 当前 Profile 的 `theme.depthOfField`（素材放 `materials/dof/` 专目录，上传与素材选择器默认落在这里） |

旧 CONFIG 的 parallax.layers/enabled 不覆盖 Profile。Profile 保存/切换通过 `deskpet-profile-updated` 通知 WebView，设置变化通过 `deskpet-settings-saved` 生效，入口见 [profile/](../../src/services/profile/)。

顶栏文案（缺省「配信中」，颜色留空跟随顶栏文字色）是窗口运行时状态，唯一真值点在 [services/titlebar.ts](../../src/services/titlebar.ts)：不随 Profile、不持久化，重启回到缺省；暂未开放界面编辑，保留接口供联动功能改写。

内置默认 Profile（`DEFAULT_PROFILE = "sugar-pink"`）禁止删除：拒绝发生在 TS 的 `deleteProfile`，文案指向「恢复默认资源」，Rust 的 `profile_delete` 只删目录、不加同名常量。删除当前活动 Profile 时会切回默认 Profile，默认不可用则回退到内存中其他 Profile，都没有时明确失败并提示重启应用或恢复默认资源。

切换活动 Profile 的唯一入口是 [profile/loader.ts](../../src/services/profile/loader.ts) 的 `switchActiveProfile()`：内存激活 + 写 `appearance.activeProfile` + 发 `deskpet-profile-updated` 一次完成，调用方不要再自行组合 `activateProfile`/`setOverride`/`flushConfig`。

导入 zip 时，归一化后指向同一路径的条目（含大小写不敏感文件系统下的同名不同大小写）按后写覆盖前者，被覆盖的条目列在导入结果的详情里。

Profile 是自包含闭包：窗口 UI 位图（`ui/windows/`）与图层素材都只从 Profile 自身目录读取，不跨 Profile 回退；缺失时窗口位图用透明占位、图层停止渲染对应层并在编辑器提示。`character.yaml` 缺失时同样走中立默认，不借其他 Profile。默认 yuki 的五层 PNG 位于 `materials/L0/bg_base.png`、`L1/rain_mid.png`、`L2/body.png`、`L3/highlights.png`、`L4/rain_front.png`，应保持相同画布与主体位置；景深素材统一放 `materials/dof/`；实际资源以[默认 Profile 目录](../../src-tauri/resources/defaults/profiles/)为准。

内存只保留当前激活 Profile（含资产目录 URL）：`activateProfile()` 与 `ensureProfileLoaded()` 都会淘汰非激活缓存；设置页列 Profile 用 `readProfileMeta()` 轻量读 meta，不进缓存。

## 浏览器缓存边界

localStorage 不保存配置、会话正文/列表、Profile 编辑结果、分割线位置或音效分配。清理已知旧缓存 key 的兼容入口已随兼容层删除（`9d44e8f`，连同 `standard-setup.ts` 的调用），不再清理历史 key —— 配置真相源只有 CONFIG 文件，缓存不构成覆盖路径；测试 keyspace 的清理由测试宿主管理。
