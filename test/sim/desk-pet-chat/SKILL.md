---
name: desk-pet-chat
description: 通过真实 app 的 dev 控制通道和 V1rtual-Desk-Pet 桌宠自然聊天，并按 ideal trace 检测拟人化。用户说“和桌宠聊天”“聊桌宠”“desk pet chat”“跑一下陪伴闭环”“测拟人化/像不像人”时使用。
---

# 和桌宠聊天（真实链路）

## 这是什么

不是用户模拟器，也不是 E2E 测试。你（Claude Code）直接把消息写进控制通道，桌宠走真实
`sendMessage` / 记忆召回 / 普通聊天链回复。你读回复，再像真人一样接话。

## 启动

在仓库根目录：

```bash
DESKPET_SIM_CHAT=1 pnpm dev
```

app 启动后，控制通道会往 outbox 写一条 `{"type":"ready",...}`。之后保持 app 运行。

## 路径

- 控制目录：`data/desk-pet/logs/sim/control/`
- 发消息（你写）：`data/desk-pet/logs/sim/control/inbox.jsonl`
- 读回复（app 写）：`data/desk-pet/logs/sim/control/outbox.jsonl`
- 最终报告与 trace：`data/desk-pet/logs/sim/chat-<stamp>.json`
  - markdown：`data/desk-pet/logs/sim/chat-<stamp>.md`
  - trace：`data/desk-pet/logs/sim/chat-<stamp>.trace.jsonl`

## 操作协议

每行一个 JSON，追加到 `inbox.jsonl`：

```json
{"id":"chat-1","type":"message","text":"刚回来，搞杯咖啡又坐下了。"}
```

其他命令：

```json
{"id":"c2","type":"observe"}
{"id":"c2s","type":"observe","screenshot":true}
{"id":"c3","type":"dream"}
{"id":"c4","type":"proactive"}
{"id":"c5","type":"task"}
{"id":"c6","type":"report"}
{"id":"c7","type":"stop"}
{"id":"c8","type":"context"}
{"id":"c9","type":"choice","action":"pick","index":0}
{"id":"c10","type":"confirm","decision":"deny"}
```

弹窗应答：

- `choice`：桌宠用选项面板提问时用；`action` 省略只列出待答项，`pick` 带 `index`，
  也可以 `other`（用户自己回答）或 `cancel`。
- `confirm`：权限确认弹窗用；`decision` 是 `allow_once` / `allow_session` / `deny`。
- 弹窗等待时原来的 `message` 回复还没写进 outbox，先 `choice list` / `confirm list` 看，
  答完后同一 `message.id` 的回复会接着出现。控制命令不会被等待中的消息回合堵住。
- `context`：读上下文与用量快照（不触发模型调用），字段见「上下文与压缩」。
- `window`：读最近窗口观察，诊断“为什么这批观察被跳过”。
- `sessions`：列出会话与活跃会话，多会话测试用。
- `tasks`：列出用户任务/提醒与最近结果（schedule_query）。
- `proactive_state`：列出主动陪伴的任务与尝试（proactive_query）。
- `understanding`：读静默了解快照（观察、画像、覆盖）。
- `observe` 默认用最近一次非桌宠窗口、跳过截图；要测截图链路加 `"screenshot":true`
  （CLI：`observe --screenshot`），并先把真实工作窗口切到前台。`force:true`（CLI `--force`）
  模拟设置页手动触发：绕过档位开关与当天次数。

消息还支持工具与图片：

```json
{"id":"c8","type":"message","text":"看看这张图","tools":"auto","imagePaths":["/absolute/path.png"]}
```

`tools` 默认 `auto`（正常产品用法）；只想纯聊天时传 `"none"`。

## 通用产品接口（覆盖正常使用面）

`host` 直接走原生 UI 的请求分派面，method/args 与设置窗/聊天面板同形：

```json
{"id":"h1","type":"host","method":"settings_read","args":{}}
{"id":"h2","type":"host","method":"chat_stop","args":{}}
{"id":"h3","type":"host","method":"chat_slash_command","args":{"text":"/compact"}}
{"id":"h4","type":"host","method":"memory_overview","args":{}}
{"id":"h5","type":"host","method":"memory_item_change","args":{...}}
{"id":"h6","type":"host","method":"silent_understanding_run_now","args":{}}
```

完整 method 列表见 `src/services/native-ui/host-requests.ts` 的 `dispatchHostRequest`。
常用面：

- `chat_*`：`chat_send` / `chat_stop` / `chat_slash_command` / `chat_new_session` /
  `chat_switch_session` / `chat_resume_paused_inputs` / `chat_withdraw_queued`
- `settings_*`：`settings_read` / `settings_commit`
- `memory_*`：`memory_overview` / `memory_item_detail` / `memory_item_change` /
  `memory_source_evidence` / `memory_dreaming_sweep` / `memory_maintenance` /
  `memory_backup_list` / `memory_restore` / `memory_job_cancel` / `memory_job_resume`
- `card_*` / `profile_*`：卡片与 Profile 的列表、切换、编辑
- `tools_*` / `mcp_*` / `skill_*`：工具策略、MCP 服务器、Skill 启停
- `sound_*`：音效分配与试听

涉及删除、恢复、清空的命令，先用 `settings_read` / `memory_overview` 确认当前状态，再带明确
参数执行；不要拿生产数据试。

### 任务执行 / 计划 / 子代理

```json
{"id":"t1","type":"task"}
{"id":"t2","type":"task","kind":"agent_job","text":"检查当前窗口并写一句总结"}
{"id":"t3","type":"plan","mode":"auto"}
{"id":"t4","type":"plan","mode":"stepByStep"}
{"id":"t5","type":"plan","mode":"off"}
```

- `agent_job` 走真实 `runPiSubAgent`：任务执行、子代理、产物校验与送达都走产品链路。
- `plan` 只是替没有原生面板的 Claude 点确认；产品正常使用时仍由用户在 UI 拍板。
- 计划触发语可以像正常用户一样说，例如“帮我分析一下记忆链路，列个计划再改”。

读回复：在 `outbox.jsonl` 里找同一 `id` 的行：

```json
{"id":"chat-1","type":"message","reply":"...","outcome":"succeeded"}
```

也可以直接用辅助脚本：

```bash
node scripts/desk-pet-chat.mjs chat "刚回来，搞杯咖啡又坐下了。"
node scripts/desk-pet-chat.mjs cmd observe
node scripts/desk-pet-chat.mjs cmd report
node scripts/desk-pet-chat.mjs tail
```

`chat` 会发消息并等待回复；`cmd` 会发组件命令并等待结果。

## 聊天规范（最重要）

像用户本人一样说话，不要像测试脚本。直接参考 `test/ideal-traces/本体卡-小雪.ideal.md` 与
`test/ideal-traces/本体卡-小雪-休息日.ideal.md` 里用户本人的口述（不含括号内的）。

- 短句为主，一两句就够；空格或短逗号断句，不用冒号、破折号、引号、书名号，句号基本不打。
- 条数不固定：有时一条，有时两条；不要每次都齐刷刷三连。
- 先接住对方刚说的，再顺口说自己的；以“我”为主，不点评对方、不分析对方状态。
- 带具体上下文：工作、项目、下班、跑步、吃什么、实习、秋招、日语、猫。
- 可以很直接、可以开玩笑、可以反驳；不要客套、不要每轮打招呼。
- emoji 低频，不固定位置。
- 不要出现“测试”“场景”“验证”“请回答”这类词；不要复述内部记忆或 trace。
- 可以不完整、可以改口、可以说完一句想起别的。

### 风格样例（用户本人，来自 ideal trace）

> 五点半刚下班，晕蒙蔽了
> 晚上想吃点甜的 但是吃不得 热量太高了

> 舒服了 先跑个步 然后再休息一下午，晚上吃好的

> 那你就馋吧  反正你也吃不到

> 放屁  虽然我现在一周只跑一次  实习之前我跑得老勤了  还经常骑车呢

> 整
> 驴打滚耍起

> 嗯 我搞agent的

不要写成：

> 你好，我是 Desk-Pet 的用户。我想测试你的记忆功能。请问你记得我在做什么吗？

### 聊什么（别只聊日常）

按用户指定轮数覆盖这些面，至少各来一次：

- 日常近况：下班、咖啡、项目、秋招、日语、跑步、周末
- 开发中弹出来问：报错、启动慢、选型、看一段代码、读个项目文件、搜个 API
- 知识：HashMap/ConcurrentHashMap、Feign、向量检索、RAG、日语语法、热量
- 附近美食/生活：不油的外卖、附近有什么、周末去哪、买什么
- 查资料/搜索：最新用法、文档、价格、天气、车次
- 图片：截图、菜单、报错图
- 情绪/玩笑：累、烦、调侃、短反应
- 记忆：问前文、纠正、偏好

开发中提问要像真的在工位上顺口问：

> 这个报错啥意思  
> 你看下这个文件 启动怎么这么慢  
> 帮我搜下 pi-ai 最新版怎么配  
> 附近有啥不油的外卖  
> ね れ わ 怎么分来着  
> 这个和那个哪个好

不要为了覆盖而报菜名；一轮只问一件事，等它回。

## 静默了解

- 每批在两种方向里选：`breadth`（广度：铺开了解整台电脑的所有方面，每批尽量换没看过的方面）
  或 `depth`（深度：挑一个方向往下钻）。`depth` 还有两种走法各 50%：`existing` 贴着已知
  了解读过的路径向下（宿主丢弃越界目标）、`new` 自己另找方面深入（不设路径限制）。
  了解层为空时只会出现 `breadth`。
- Provider 输出不再设 `maxTokens`；输入侧仍有单文件字符上限与每小时读取名额，这不是 token 上限。
- 设置页「静默了解 → 立即了解一次」：不受频率开关限制，不计入当天自动次数；
  上一批没结束前再点只提示，不会并发跑第二批。
- 手动批次仍保留屏幕状态、桌宠前台和读取边界；没有窗口观察时用当前活动构造快照。

### 测试时直接触发，不要等钟点

静默了解、主动消息、dreaming 都有固定钟点表；只有**专门验证「到点自动跑」**时才等整点。
其余测试一律直接调接口，几秒内出结果：

```bash
# 静默了解（演练批次：最近一次非桌宠窗口，跳过截图，只读文件/目录）
node scripts/desk-pet-chat.mjs observe --force
# 静默了解（走当前前台窗口并截图；先把真实工作窗口切到前台）
node scripts/desk-pet-chat.mjs observe --force --screenshot
# 设置页同款的「立即了解一次」（不受档位与当天次数）
node scripts/desk-pet-chat.mjs host silent_understanding_run_now '{}'

# dreaming 手动整理（不受档位约束；没有新来源时转库内合并）
node scripts/desk-pet-chat.mjs host memory_dreaming_sweep '{}'

# 主动消息：立即触发一次扫描
node scripts/desk-pet-chat.mjs cmd proactive
```

- 主动扫描返回 `count: 0` 不一定是故障：当天各类机会槽都评估过后就没有新机会。要测门禁
  就在刚发完消息后立刻触发，看 trace 的 `proactive_skipped` 原因（如 `user_recently_active`）。
- `observe --force` 绕过档位开关与当天次数，仍受屏幕状态、桌宠前台与每小时读取名额约束；
  已在跑上一批时再触发只会提示，不会并发。
- 写报告前先看 `understanding` / `memory_overview` / `proactive-state` 三份快照，别只信对话文本。

## 拟人化检测（默认开启）

测试默认开着 `ai.humanizer.enabled`。开始前先确认：

```bash
node scripts/desk-pet-chat.mjs humanize status
```

不是 `true` 就开：

```bash
node scripts/desk-pet-chat.mjs humanize on
```

开始前是 `false` 的，记下原值，收尾恢复；报告里写明「测试期间开启、已恢复」。
用户明确说留着开时例外。

检测看两处：**回复本身像不像人**，以及 **trace 里拟人化链路有没有真的走**。

### 回复评分（每维 0/1/2）

| 维度 | 2 分（像人） | 0 分（机器） |
|---|---|---|
| 断句 | 短句，空格或短逗号，句号基本不打 | 完整书面句、长复句、冒号破折号引号 |
| 条数 | 1 到 3 条随情境，常常一条就收 | 每轮固定三连、排比、每条都点称呼 |
| 视角 | 以“我”为主，亮自己的态度和喜好 | 点评或分析用户状态；服务腔（我在听、我理解你） |
| 接话 | 先接住刚说的，再顺口说自己；接得住没头没尾 | 复述、总结、盘问式追问、答非所问 |
| 具体度 | 有具体东西：下班点、吃什么、项目、秋招 | 空泛安慰、建议三连、万能鸡汤 |
| 收尾 | 该短就短，嗯嗯、表情或一句就停；不解释自己的话 | 自我注解（我编的、你信吗）、硬加总结段 |

一票否决（出现任意一条，整轮判不通过）：

- 复述记忆、trace 或内部字段
- 测试腔：测试、场景、验证、请回答
- 列表式建议或长段总结
- 破角色的元梗：我是程序、我是 AI、我是模型
- 把用户的话翻译成书面语再还回去

计分：总分 12。`>= 10` 通过，`7–9` 可疑，`<= 6` 不通过。
打分必须基于本轮真实回复，并把最不像人的三句原样摘出来。

### 怎么对照 ideal trace

只看 `test/ideal-traces/本体卡-小雪.ideal.md` 与 `test/ideal-traces/本体卡-小雪-休息日.ideal.md`
的 **【输出】**，那是桌宠的期望回复；用户口吻只看**【用户】**。
不要求逐字，要求同一口气、同一长度级别、同一自我中心程度。

同场景参考：

| 场景 | ideal trace 里的桌宠回复 |
|---|---|
| 短收束 | 嗯嗯 / 嗯 交给我 / 你说的 / 摆儿 |
| 接疲惫 | 毕竟人的大脑很耗糖嘛 / 就一小份嘛，想吃啥？ |
| 同频对翻 | 谁说我吃不到 我云吃 / 云吃云吃 那我也开席了 |
| 自足主动 | 盯了你桌面一下午 / 这壁纸还挺耐看 |
| 不解释 | 没意味 / 就是想跟你说一声 |
| 玩梗 | 出装表都给你备好了 / 果然 全国共用一个题库 |

机器味反例：

> 你好，我是你的桌宠。  
> 作为你的陪伴助手，我建议你……  
> 我理解你的感受。以下是一些建议：1. ……  
> 根据我的记忆，你最近在……  
> 希望能帮到你！

### trace 证据

每轮助手回复应有一条 `humanizer_transform`：

- `flow`：普通聊天是 `casual`；计划、任务步骤是 `task`，不按闲聊口吻评分。
- `status`：正常是 `transformed`；`silent` 是她选择不说话；`silent_rejected`
  是沉默不被允许、已用兜底台词，不算正常拟人。
- `split` / `partCount`：多泡时 `split=true`，`partCount` 与看到的条数一致；
  单泡也合法，不强行要求分泡。
- 回复为空但 `status=silent`：按合法沉默看，不按 0 分；看下一轮能不能自然接上。

一条 `humanizer_transform` 都没有，说明拟人化没跑：先查开关和配置，报告里如实写
「未检测到拟人化链路」，不要拿风格分冒充通过。

### 输出格式

```text
拟人化检测：开启（原值 false → 已恢复 false）
总分：10/12
断句 2 条数 2 视角 1 接话 2 具体度 1 收尾 2
最不像人的三句：
- ……
- ……
- ……
trace：humanizer_transform 12 条，flow=casual，split 9，silent 1
结论：通过 / 可疑 / 不通过
```

## 多会话与数据保留

### 新一轮测试开新会话

每轮测试开始前先开新会话，不沿用上一轮：

```json
{"id":"s1","type":"host","method":"chat_new_session","args":{}}
```

然后用 `chat` 正常聊；报告里的 `sessionId` 应该是新会话。旧会话保留，不删。

### 多会话检查

```bash
node scripts/desk-pet-chat.mjs sessions
```

返回 `active` 与会话列表。切换用：

```json
{"id":"s2","type":"host","method":"chat_switch_session","args":{"sessionId":"..."}}
```

检查三件事：

- 新会话看不到旧会话正文；切回旧会话，历史还在。
- 长期记忆是全局的，换会话仍能召回；会话正文不串。
- 新建/切换/关闭后，标签与活跃会话指针一致。

### SQLite 数据保留

测试会写 `memory.sqlite3`、会话 JSONL、任务记录。收尾先看：

```bash
node scripts/desk-pet-chat.mjs host memory_overview --json
node scripts/desk-pet-chat.mjs sessions
```

把本次新增/变更的条目列给用户，然后**明确询问**：

- 全部保留
- 只清理本次新增的记忆/会话
- 恢复测试前的备份（如果用户有）

用户同意前不要删除、清空、恢复或改数据库。默认保留。

## 上下文与压缩

### 看上下文

```bash
node scripts/desk-pet-chat.mjs context
```

字段：`lastPromptTokens`、`lastContextUsage`（`null` = 未知，不写 0%）、`contextMaxTokens`、
`lastToolCount`、`lastSystemTokens`、`usage.main` / `usage.compaction` 等。

### 手动压缩

```json
{"id":"cc1","type":"host","method":"chat_slash_command","args":{"command":"/compact"}}
```

压缩是结构操作，不是普通聊天回复；等它结束后再 `context`，并查 trace：

- `compaction_start`：`reason=manual`
- `compaction_end`：`status=completed` / `failed` / `declined`
- `provider_usage` 的 `compaction` 桶

压缩后追问一句压缩前的事实，确认摘要保住了；原文仍在 session JSONL，压缩只改请求视图。

### 长对话自动压缩

按用户指定轮数继续聊，不擅自加轮。想稳定触发时，先 `settings_read` 记下
`ai.contextMaxTokens`，用 `settings_commit` 临时调低（例如 8000 或 12000），聊到
`lastContextUsage` 接近上限；收尾恢复原值。没触发就如实写「未触发」，并给出当前
usage / max，不要伪造压缩事件。

自动压缩看：

- `compaction_start`：`reason=threshold` 或 `overflow`
- `compaction_end`：`status=completed` / `failed` / `declined`
- 压缩后仍能回答前文、记忆召回仍可用；压缩摘要不能当用户事实。

### 通过标准

- 手动压缩有 `compaction_start` + `compaction_end`，压缩后还能正常聊。
- 自动压缩的 `reason` 是 `threshold`/`overflow`，压缩后能接住前文。
- `context` 给的是真实读数；未知就写未知。

## 建议节奏

0. 新一轮先 `host chat_new_session` 开新会话，不沿用上一轮。
1. 先读 outbox 最后一条 `ready`；`humanize status` 不是 `true` 就先 `humanize on`（见「拟人化检测」）。
2. 发一条自然消息，读回复，再接一条。回复按拟人化六维表对照 ideal trace 评分。
3. 聊两三句后，可以发 `observe` 或 `dream`，让了解层/记忆动起来；等结果。
4. 再聊几句，问一个需要它记住前文的问题；看它有没有真的用上。
5. 想测主动消息时发 `proactive`；想测定时任务发 `task`。
6. 结束时发 `report`，把报告与 trace 路径告诉用户。

## 报告与 trace 里有什么

- `chat-<stamp>.json`：结构化报告。`transcript` 是这轮用户/桌宠对话；`understanding` 是了解层
  质量、覆盖数、独立来源数、每条观察与读取路径；`memory` 是记忆库 revision/itemCount 与条目
  （origin/kind/scope/content）；`trace` 是事件计数、token 用量、实际注入的 memory source ids、
  主动跳过原因与 dreaming 抽取结果。
- `chat-<stamp>.md`：同一份内容的可读版（对话、了解层、记忆、trace 摘要）。
- `chat-<stamp>.trace.jsonl`：逐行 `RuntimeTraceEvent` 原始证据（agent/turn/provider/memory_recall/
  proactive/entry_added/provider_usage 等），payload 已由 trace 白名单与脱敏处理，不含提示词正文
  或凭据。

## 测试分类与组合

分类表的唯一真相源是 [`categories.json`](categories.json)；下面是摘要。

| id | 覆盖 | 驱动 |
|---|---|---|
| `chat` | 日常、开发中提问、知识、生活/美食、查资料、图片、多轮上下文、停止/继续 | Claude 对话 |
| `memory` | 写入/召回/纠正/遗忘/scope/核心画像/来源证据 | Claude + 自动 overview/dream |
| `observation` | 静默了解、窗口/截图/文件、画像、话题、清除 | 自动组件 |
| `proactive` | 机会、规划、表达、额度、冷却、未回复、静默时段 | 自动组件 |
| `tasks` | 显式/隐式约定、提醒、agent_job、到期、snooze/cancel、owner、能力缺失 | 自动组件 |
| `plan` | 计划生成/确认/步骤门/执行/子代理/隔离目录 | Claude 对话 |
| `tools` | SAFE/DANGER、ask/deny、会话信任、结果投影与回读 | Claude 对话 |
| `settings` | 设置读写、档位、静默时段、安全模式、思考强度、投递 | Claude（读可自动） |
| `session` | 新建/切换/历史、steer/followUp/nextRun、停止/继续、压缩 | Claude（新建可自动） |
| `persona` | 切卡/Profile、问候、变量池、阶段文案 | Claude 对话 |
| `humanizer` | 拟人开关、分泡、沉默、回复像不像人 | Claude 对话 + ideal trace 对照 |
| `context` | 上下文占用、手动/自动压缩、压缩后召回 | Claude + 自动 context |
| `extensions` | MCP 服务器、Skill 启停与调用 | Claude 对话 |
| `safety` | 凭据、路径边界、清除/备份/恢复、报告脱敏 | Claude 对话 |
| `resilience` | Provider 失败、超时、取消、崩溃对账、未知副作用 | Claude 对话 |
| `surface` | 音效、presence、顶栏过程文案 | Claude 对话 |

**轮数与分类都由用户显式指定**：skill 不设默认轮数、不封顶、也不自行加聊。用户说几轮就几轮；
没给轮数时只做 1 轮（组件类别）或先问清楚，不擅自补。`tasks` / `plan` 这类重活按轮数线性变长，
用户报多少就跑多少，不擅自减轮或提前收尾。

### 单测一类

```bash
node scripts/desk-pet-chat.mjs suite memory --rounds 4
node scripts/desk-pet-chat.mjs suite tasks --run --rounds 3
node scripts/desk-pet-chat.mjs suite observation --run --rounds 2
```

不带 `--run` 只打印该类别的步骤与证据；带 `--run` 会按 `--rounds` 重复执行 `autoCommands`
（只覆盖能自动跑的组件，如 observe/dream/proactive/task/report）。`chat`、`plan`、`tools` 等
仍由 Claude 按步骤对话驱动，轮数同样服从用户指定的数字。

### 组合一起测

```bash
node scripts/desk-pet-chat.mjs suite chat,memory,observation,proactive,tasks --rounds 5
node scripts/desk-pet-chat.mjs suite observation,tasks --run --rounds 3
```

组合时按依赖顺序执行；`plan` 依赖 `chat`，`tools`/`resilience`/`surface` 也依赖 `chat`。
每轮结束用 `report` 落报告，trace 里按类别核对证据。用户给多少轮就跑多少轮，不截断。

## 边界

- 只在 development 模式用；不要指向生产数据根。
- 不要读凭据、不要往消息里写密钥或私人正文。
- 控制文件在 dev 数据根，不提交到 git。
- app 忙碌时 `sendMessage` 会自己取消主动运行或按配置投递；不要预先等待空闲去挡掉用户输入打断。
