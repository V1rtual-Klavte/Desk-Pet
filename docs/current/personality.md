# 人格、变量与回复

用途：修改 Card、角色状态、阶段文案或回复效果时核对边界。Card 定义与 UI 玩法见 [DES](../DES.md#2-cardprofile-与用户记忆)，文件位置见[运行时数据](runtime-data.md)。

## 所有权

| scope | 值的来源 | 存储表示 | LLM 能否写入 |
|---|---|---|---|
| system | 时间、活动 Card 等运行时派生数据 | 原始值 | 否 |
| card | Card 的 variableDefs 注册表 | VariableState | 仅 updateBy=llm 的已注册字段 |
| interaction | 系统维护的互动状态 | VariableState | 否 |

精确类型见 [types.ts](../../src/services/personality/types.ts) 的 `CardVariableDef`、`VariableState`。VariableState 保存 value/type/updatedAt/updatedBy；重置游标（`lastDailyResetKey`/`sessionKey`）随 Card 的 `variables` 段持久化，不逐变量记账；会话级重置（`reset: session`）的判定键是当前会话的 `createdAt`（`getSessionCreatedAt`，来自 `SessionMeta`，读不到则不做判定），游标随变量区持久化。

card/interaction 状态保存在 `personality/stages/{cardId}.json` 的变量区，两段由 [stages-file.ts](../../src/services/personality/stages-file.ts) 单一读写：段级合并，两个生产者互不抹除；`vars.json` 不再写入。用户长期事实不存入角色变量。

## Card 加载与切换

[loader.ts](../../src/services/personality/loader.ts) 从运行时 cards 目录读取和解析 Card，包内 defaults 只作首次初始化种子。[registry.ts](../../src/services/personality/registry.ts) 的 `switchPersonality()` 先准备阶段文案与变量池，成功后改变活动 Card；失败恢复旧 Card、变量池（含变量注册表）与阶段缓存。设置页展开 Card 只构建局部预览快照，不改动全局变量池所有权。

设置页「人格」节的 Card 管理面（新建/编辑/重命名/导入/导出/删除/模版）与切换同属一条链：动作对象是**草稿里选中的卡**，不是「当前已激活的卡」；新建与重命名先经原生输入框取名字，id 由 Node 从显示名推导（沿用 `saveUserCard` 的清洗规则，撞名加后缀，绝不覆盖已有卡）。**重命名只改 frontmatter 的 `name`** —— 文件名、`stages/{id}.json` 与变量归属都挂在 id 上，改名不该牵连它们；**删除连带删掉该卡的 stages 文件**，激活中的卡拒删（先切到别的卡）；**导入以「能解析出有效 id」为唯一准入**（解析不出就整份拒绝，不写坏文件），同名即覆盖。列表刷新后若草稿选中项已消失（刚被删），宿主回落到运行时仍在激活的卡，避免保存时拿一个不存在的 id 去切换。`_template.md` 是模版面板的**唯一正文来源**（运行时文件，可被「恢复默认资源」覆盖），面板首行引导语由宿主定义、与正文拼成同一段文本 —— 面板显示什么，复制就是什么。

随包种子提供 `default`（本体卡）、`yuki`、`angelkawaii` 与 `shu` 四张 Card；没有可用 Card 时允许无活动 Card 降级运行。默认卡的名字由用户起：frontmatter `name` 只是产品标签（「默认」），`nameVar: 名字` 声明承载名字的 Card 变量——用户在对话里起名或改名时由模型经 RUNTIME_DATA 写入（进 Card 身份、随卡持久化，不进用户长期记忆），聊天气泡的说话人标签优先显示它；未起名时返回空串交界面兜底（ChatPanel 显示「桌宠」），不回落到卡标签；未声明 `nameVar` 的 Card 仍显示卡 `name`。`whenText` 是自然语言语气指引；mustRules 参与 Prompt 构建，不是一套任意执行脚本。

阶段文案先读持久化缓存，缺失时可经模型生成；任一 Card 首次激活或角色设定/语言风格变化时会重新生成一次（一次 LLM 调用/卡）。失效判定键是生成输入 `sourceHash`（`SHA-256(roleSetting + "\n" + languageStyle)`），`version:` 只作元数据、不参与判定；重新生成只覆写 stages 段，不清空变量区。

**用户可见的阶段与兜底文案只有 Card 一个来源**，取用点如下：

| getter | 覆盖面 | 消费点 |
|---|---|---|
| `getStagePrompt(stage, category)` | `executing` / `done` / `blocked` 的工具类别映射 | 顶栏运行状态（工具过程文案） |
| `getSimpleStage(key)` | `thinking` / `planning` / `error` / `retry` 状态行 | 同上（`thinking` 来自每轮 `turn_start`，`planning` 来自计划阶段入口，`retry` 来自 Harness `retry_start`） |
| `getCommandReply(key)` | `commands` 段的 slash 命令输出 | `/clear`、`/memory clean`、`/compact`、`/skill` |
| `getFallbackReply(key)` | `fallbacks` 段的异常兜底正文 | 运行内核各失败出口 |
| `getPresenceStage(key)` | `presence.idle/working/resting` | 有 owner 和到期时间的有限展示与顶栏 |

引擎只经 `deskpet-stage-hint { sessionId, stage }` 发语义 key，文案由界面按当前 Card 取 —— 与 `tool-executing` 同一条口径，引擎不持有第二份台词。`commands` 里带计数、错误原因与技能名的明细保持中性：插值内容是诊断事实，角色化会让用户分不清「真的排了几条」和「角色在说话」——`/compact` 的排队计数与失败原因、`/skill` 的三个失败句（`skillUnknown` / `skillEmpty` / `skillDisabled`）后附的技能名都按这条口径处理（技能名与原因不写进 Card 的终态 key）。系统消息与错误诊断同样保持中性（角色台词会掩盖故障）。

新增一个用户可见场景的联动清单：`StageMap` / `FallbackReplies` / `CommandReplies` 加 key → `stages-prompt.md` 补说明与 JSON 模板 → `validateStages` 把它列为必需（旧缓存判过期才会重生成，否则新 key 永远取不到 Card 文案）→ 接消费点。`CommandReplies` 的新 key 还有两处固定的代码坐标要同改：[stages-file.ts](../../src/services/personality/stages-file.ts) 的 `CommandReplies` 类型与 [stages-cache.ts](../../src/services/personality/stages-cache.ts) 的 `COMMAND_KEYS`（判过期的依据，缺它旧缓存不会重生成）和 `FALLBACK_COMMANDS`。`FALLBACK_STAGES` / `FALLBACK_FALLBACKS` / `FALLBACK_COMMANDS` 只是 Card 完全不可用时的中性兜底，不是第二份产品文案。

`typing` / `thinking` / `planning` / `retry` 是顶栏运行状态的语义 key，不是对话回复，`error` 供工具错误前缀；超时使用 `fallbacks.turnTimeout`。presence 的 idle/working/resting 是有限展示状态，独立于过程状态；顶栏过程 owner 优先级高于 presence，退出时释放自己的 owner。新增 presence 和主动控制命令 key 都进入缓存完整性校验，缺 key 的旧缓存会重新生成。

主动机会只消费已提交的 Card 变量变化；初始化、重置、interaction/system 变化和 `proactive_response` 写回不产生变量机会。主动回复先拆出文本与变量 patch，拿到真实助手条目与 SQLite 回执后，核对冻结 Card id/hash 与变量池 owner，再保存 patch；失败不会把已经送达的表达改成未送达。

## 拟人表达与关系档位

拟人协议与节奏是全局引擎能力，不写入 Card；Card 只提供人设、语言风格与阶段台词。`typing` 与 `silentRejected` 纳入阶段缓存完整性校验，缺 key 的缓存重新生成。合法沉默保留原生已提交空助手条目与宿主语义元数据，但不产生空气泡、通知或主动成功计数；同会话连续沉默被拒并取当前 Card 的极短兜底。

可选数值变量声明 `proactiveBands`（有限、严格递增且覆盖 min）；只有已提交 Card 数值跨过显式档位才形成机会，不按变量名写死规则。默认 Card 好感度 0–100，档位 0/10/30/60/85；有分量时按分量增加，不按消息数涨、不因沉默降低，亲密感不接采样 temperature。

提交前先剥离 RUNTIME_DATA，再把 SPLIT 标记转为同一助手条目的多个 text part，原文留底与最终落盘文本精确配对；变量仍从原始正文解析。实时推送与重载共享分段，标记不进入下一次请求或压缩正文。

## 回复与写入

```text
模型完整回复
  → parseRuntimeData：解析并剥离内部块
  → generateReply：解析 RUNTIME_DATA、变量写入落盘、显示文本处理
  → batchWriteVars：注册/写权限/类型/范围校验
  → savePoolToDisk：保存 Card 状态
```

入口见 [reply/generator.ts](../../src/services/reply/generator.ts) 和 [personality/index.ts](../../src/services/personality/index.ts)。模型不能新增变量、写 system 变量、通过字符串绕过类型与边界限制。

主 run 捕获 Card ID、版本和 hash；返回时若当前 Card 已变，旧文本仍可保存到所属会话，但旧 RUNTIME_DATA 不写入新角色变量。流式增量和工具中间消息不直接写入 Card 变量。

结算只解析**结算正文**自己的 RUNTIME_DATA：结算取 `state.finalPlainAssistant ?? state.finalAssistant`（本回合最后一条无 toolCall 的助手消息；没有它时才退回最后一条助手消息），再用 Harness 的 afterResponse 留底的「原始正文 ↔ 剥离后正文」配对取回原始正文（剥离先于提交，提交的条目里已经没有协议块）。因此本回合其他助手消息（含带 toolCall 的过程消息）里的 RUNTIME_DATA 只被剥离、不写变量。计划步骤的子代理（`runPiSubAgent`）不解析变量：其原始正文随父会话的 `deskpet.plan_step_result` 条目留证（PLAN-09），变量解析入口只有主回合的 `generateReply` 一处。

结算同时判定协议缺失并安排下一回合提醒：具备写入资格（Card 未过期且非主动表达）的完成回合，若结算原始正文不含 `<RUNTIME_DATA>…</RUNTIME_DATA>` 区块、而本回合冻结 Card 又声明了 `scope=card 且 updateBy=llm` 的变量，结算记一条 warn 并给该会话挂起提醒（[reply/reminder.ts](../../src/services/reply/reminder.ts) 的会话级 mark/clear/has：进程内存、不落盘、按会话隔离，重启后由新回合按缺失结果重新判定）。挂起期间下一回合的请求 system prompt 追加 `ephemeral:runtime-data` 块，文案取 `RUNTIME_DATA_REMINDER_TEXT`；该回合结算时含区块（含空区块）或已无可写变量就清除，仍缺区块则继续挂起并再记一条 warn。取消与中断的回合走不到结算，既不挂起也不清除；主动表达不参与判定、也不注入提醒。

## 验证入口

相关 Contract：`personality-card`、`variable-pool`；运行命令见[测试 README](../../test/README.md)。格式解析的确定性断言与模型是否主动写入变量是不同验证目标，不能相互代替。

计划回合的写入路径（主回合写入、步骤子代理只留证）由 `agent-runtime` 的 `runtime-plan-step-variable-write` production 场景承接；该场景 2026-09-24 首跑（dataset `2026-09-24.4`）的结论是**原断言不成立**：它读的是 production 入口不透出的 `runtimeData`（观测面缺陷，不是产品丢失变量），离线探针证明结算取值正常，场景已改按可观测的写入事实断言。
