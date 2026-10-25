---
name: desk-pet-eval-runner
description: 执行 V1rtual-Desk-Pet 结构化聊天评测用例：冻结规格与预算，隔离驱动真实 app，采集证据，先跑确定性检查，再用异构 API judge 评语义探针，输出同源报告。用户说“跑结构化评测”“执行评测用例”“跑一次聊天评测”“用 API judge 评分”时使用。W2 的隔离起停已验收，W3 的采集与封存已落位但未验收；聊天驱动、自动评分与人工裁决仍未实现，未实现前只能说明阻塞，不得伪造运行结果。
---

# 结构化聊天评测运行与判分

## 现状（W2–W3b）

W2 已实现并验收 **debug 隔离根 + 宿主所有权核验 + direct-seed 装载器**（2026-10-25）。W3a 的测试侧证据封存／同源报告／五回保留模块与 W3b 的产品 trace 采集、跨会话取证、采集生命周期和运行器封存接线已落位，反例测试已写但尚未运行验收；聊天驱动、`dataset run`、固定时钟、自动评分与人工裁决仍未实现（W4–W6）。W2 相关单元测试、类型检查与 Rust 单测已运行通过，真实隔离起停覆盖了 ready／装载核验、非法路径、跨进程单实例、E2E 互斥和停止后锁释放。用户要求“跑评测”时，先说明这些阻塞，不要用聊天报告、coding agent 打分或隔离起停成功来冒充正式评测结果。

```bash
node scripts/desk-pet-chat.mjs eval prepare --case saturday-companionship --card <card.md> [--run-id <id>]
node scripts/desk-pet-chat.mjs eval start --run-id <id>
node scripts/desk-pet-chat.mjs eval status --run-id <id>
node scripts/desk-pet-chat.mjs eval finish --run-id <id>
node scripts/desk-pet-chat.mjs eval stop --run-id <id>
node scripts/desk-pet-chat.mjs capture status
node scripts/desk-pet-chat.mjs capture sessions
```

- `prepare` 只在 `test/.tmp/sim-eval-<id>/` 建隔离根，写入合成 CONFIG、显式给出的 Card、`seed.json` 与 `runner.json`；`--card` 必须由调用方提供，不读取真实 CONFIG、凭据或用户 Card。
- `start` 只接受 debug 构建，设置 `DESKPET_SIM_EVAL=1` / `DESKPET_SIM_EVAL_RUN_DIR` 拉起宿主，依次核对 `ready.json`、控制通道 ready 与 `seed-report`：pid 必须是本次子进程、`runDir`／`dataRoot`／`controlDir` 必须同源、运行模式必须是 development，fixture／会话／消息数／记忆数必须与 `runner.json` 一致；核对通过后建 attempt 并开始 trace 采集。
- `finish` 结束试次、收口采集，写 dialogue、补声明会话、封存 attempt 并生成同源报告；`stop` 只写 `stop.request`，由宿主走产品退出序列并移除 ready，未完成采集以中断状态收口。停止条件是进程退出且 ready 消失。`.instance.lock` 文件按设计保留（OS 在进程退出时释放锁，删除文件会引入 unlink 竞争），无残留判据是无宿主进程、无 ready、锁未被持有且真实数据根未变。不要 kill 进程来“收尾”。
- `status` 只读现有证据，不修复、不重启、不清理失败现场；`capture status|sessions` 通过开发控制通道核对本次采集的范围与来源，不读取真实用户会话。

当前候选 `saturday-companionship` 为 27 条用户消息 + 2 个 host 步骤、3 个会话、21 条探针（9 条 critical），fixture 为 `direct-seed`，时钟固定。W2 装载器会把 fixture 的初始会话/记忆写入隔离数据根，纠正、自动记忆抽取和跨会话召回仍应由真实消息触发；但**固定时钟尚未注入**，不能假装跨天间隔已经发生。探针窗口只看 driver 步骤，fixture 预置的助手消息不参与判定。

## 只读数据集入口

```bash
node scripts/desk-pet-chat.mjs dataset validate
node scripts/desk-pet-chat.mjs dataset list
node scripts/desk-pet-chat.mjs dataset types
node scripts/desk-pet-chat.mjs dataset driver <caseId>
```

`review` 是给用户审批看的，驱动方不得先读。隔离起停和结构校验通过都不产生质量结论。

## 目标流程（W3–W5，W3 采集与封存已落位）

```text
冻结 case 选择、运行意图、trial 数、预算、允许修复范围
  → 启动隔离的完整桌面 app（正常初始化，不是无 UI 的 L4）
  → 每个 trial 重建身份、会话、任务、许可与时间域
  → 只把 userRole + driver 交给聊天执行者
  → 声明检查点，等待真实完成事件或有限超时
  → 采集对话、事件、来源、状态 before/after 与实际产物
  → 按探针 authority 路由：deterministic 先跑，api-judge 评非 humanizer 语义
  → humanizer / human 权威探针留给用户本人，自动流程停在 pending
  → 按 case 规则聚合，生成同源报告并等待人工复核
  → 授权修复后创建新 attempt，保留旧失败
```

一次实际执行是一个 evaluationRun；同一修复循环的所有 attempt、case、trial、报告、评分与复核属于同一保留组。留最近五组，失败与成功同等保留，待审／在途组受保护。

## 判分边界

- **按 checker 的 authority 路由，不按题型路由**：`deterministic` 只走事件／状态／文件／来源检查，`api-judge` 只走异构 API judge，`human` 只由用户本人判定。题型（`questionType`）只用于报告分组与覆盖统计，不决定由谁判分。
- **结构化探针**：由 runner 调用与被测模型异构的 API judge 判定 `api-judge` 权威的语义探针；默认 `deepseek-v4-pro`，可用 `DESKPET_EVAL_JUDGE_MODEL`、本地 `test/eval-models.local.json` 或 CLI 覆盖。必须核对实际响应模型，不能只比较请求名；被模型与 judge 相同则拒绝。
- **确定性检查优先**：能由事件、状态、文件、来源或实际产物判定的探针，不用语义 judge 代替。
- **humanizer 与 human 权威**：所有 `humanizer.*` 语义探针和拟人化质量 rubric 只由用户本人判定。coding agent 可按 rubric 提供建议，但只能作为 `assistants` 的辅助，不能判 pass/fail、不能写审批、不能让 case 变成 gold。只要 case 含 human 权威探针，自动流程最终状态必须是 `pending`，等用户复核。
- **coding agent 的自由评述**：可以评聊天自然度、接话、人格一致等自由问答结论，但不得代替 API judge 判结构化探针成败，也不得代填 gold 审批。
- **未校准不开放可信自动判分**：W4 的反例集与用户校准完成前，语义评分只作探索，不作为通过依据；semantic 不能成为唯一的 required 确定性依据。
- **聚合规则**：全部 critical `required` 成立、非关键达到阈值且没有 `forbidden` 违规才算 case 通过；含 human 权威探针时，自动部分只能给出 `pending`，不能给出最终通过。已证实失败不能被缺证据洗掉，缺证据也不冒充产品失败或零成本。
- **证据冻结**：grades／reviews 每次新增版本，绑定原始证据与规则；不得覆盖旧分数、旧证据或用户裁决。

## 驱动与隔离

- `direct-seed` 与 `real-chain` 不能混用：前者只预置初始状态，后者必须通过真实导入建立；不要把纠正结果 seed 进去再宣称纠正成功。
- `fixed` 时钟仍待 runner 注入（W3b 未实现，随 W4）；未注入时只能声明时间格式已冻结，不能声明真实间隔或自动抽取时序已验证。
- 探针窗口限定 driver 步骤；fixture 预置的助手消息不得进入 `last-assistant` 或 `all-assistant` 判定。
- driver 只读 `dataset driver` 的 `userRole` + `driver`；不得读题型、探针、oracle、检查点、证据、评分、修复提示或留出材料。driver 里的 `at` 只是固定时钟标签，不要自行等待或伪造跨天。
- 题型（`questionType`）和 `questionTypes` 只用于运行方路由与报告分组，不进入驱动包；驱动代理不需要知道题目分类，避免按题型反推判据。
- 看过 `dataset review` 的代理不得驱动同一个 case；驱动换独立会话／代理。
- 桌宠可读测试工作区、工具许可范围与报告目录不得泄漏题库、gold 或 judge 材料；泄漏的运行显式标受污染，不能称盲测。
- 权限等待沿用现有消息链／控制链分离；不因等待用户回复死锁，不自动重放未知副作用。
- 旧 ready、错回执、跨代际、过期授权不得续用；trial 起点在副作用前声明，结束在任务收敛或明确中断后声明。

## 报告与人工关口

- 人读与机读报告从同一证据集合派生；报告可重建，不反向定义 oracle，也不成为业务真相。
- 分开显示“声明覆盖”“实际触达”“有证据验证通过”；多标签不增加 case 数，主动作未发生时不宣称验证了主动引用。
- 执行／证据／检查／复核状态分离；缺证据、判分故障或未校准时显式阻断相应结论，不输出掩盖问题的单一总分。
- 结果交用户复核；用户可指出误判、裁决分歧，保留原评分、原证据与真实用户来源。
- 修复只限用户明确授权的代码／行为范围；修复后新建 attempt，禁止改 gold、删断言或题库特判来刷绿。
- 预算、模型调用、实机权限与数据清理均需当次授权；不擅自追加收费调用或修改真实用户数据。

## 边界

- 不新造 Agent runtime、HTTP API、评测网站或通用脚本 DSL。
- 不以 L4 Scene runner 代替完整桌面；L4 不创建正常原生 UI 与监控线程。
- 不把接口通过解释为原生绘制、焦点、声音或 UI 首显已验证。
- 不修改其他记忆评测的保留、双人 gold 与许可规则。
- 真实模型、平台与 Windows／macOS 未跑的一侧明确写未验证。
