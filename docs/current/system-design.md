# 当前系统地图

用途：定位模块、入口和状态所有者。行为协议见[运行时契约](runtime-contract.md)，产品体验见[DES](../DES.md)。本文不维护阶段进度或测试结果。

## 入口与模块

| 入口 / 模块 | 职责 | 首先查看 |
|---|---|---|
| 前端窗口入口 | 主窗口、设置、图层编辑与模拟器；统一启动拦截和配置加载 | [boot.ts](../../src/services/boot.ts)、[main.ts](../../src/main.ts)、[vite.config.ts](../../vite.config.ts) |
| Vue 界面 | 会话、聊天、角色、设置和确认的投影 | [App.vue](../../src/App.vue)、[components/](../../src/components/) |
| agent | 用户输入、子代理与主动消息入口（Provider 调用归 `engine/pi/model-gateway.ts`，`agent/pi/` 已随 Harness 迁移删除） | [runner.ts](../../src/services/agent/runner.ts)、[agent/](../../src/services/agent/) |
| engine | 预处理、Plan、Slash、Harness 运行槽、会话仓库与压缩接线 | [engine/](../../src/services/engine/)、[pi/harness-slot.ts](../../src/services/engine/pi/harness-slot.ts)、[pi/runtime.ts](../../src/services/engine/pi/runtime.ts)、[pi/session-repo.ts](../../src/services/engine/pi/session-repo.ts) |
| engine/runtime | trace、快照协议与输入事件身份（`deskpetEventId`/`deskpetSource`；Queue/AgentSlot 已退役） | [runtime/](../../src/services/engine/runtime/)、[input-identity.ts](../../src/services/engine/runtime/input-identity.ts) |
| context | 分层构建、共享预算（块排序与可选块整块淘汰）与工具输出请求投影 | [context/](../../src/services/context/) |
| agent/memory | Plan checkpoint、记忆文件与只读 MemoryProvider（会话正文在 `sessions/` JSONL） | [memory/](../../src/services/agent/memory/) |
| session | 会话仓库访问层、会话列表与消息读模型、切换与恢复 | [session/](../../src/services/session/) |
| personality / reply | Card、变量与阶段文案；回复元数据解析和效果 | [personality/](../../src/services/personality/)、[reply/](../../src/services/reply/) |
| tool / safety | 工具注册和路由、Pi 文件工具、MCP；权限与确认 | [tool/](../../src/services/tool/)、[safety/](../../src/services/safety/) |
| skill | 有界元数据索引与按需正文读取的 Prompt 目录 | [skill/](../../src/services/skill/) |
| profile / audio | 外观资源、导入导出与系统音效 | [profile/](../../src/services/profile/)、[audio/](../../src/services/audio/) |
| window / cooldown | 前台窗口监控、主动消息与共享冷却 | [window/](../../src/services/window/)、[cooldown.ts](../../src/services/cooldown.ts) |
| config / paths | 类型化配置与 Rust 路径桥接 | [config.ts](../../src/services/config.ts)、[paths.ts](../../src/services/paths.ts) |
| logger / error / dialog | 统一日志、异常出口与通用交互提示 | [logger/](../../src/services/logger/)、[error/](../../src/services/error/)、[dialog/](../../src/services/dialog/) |
| Rust App / commands | AppPaths（数据根、允许根与凭据路径终判）、IPC 注册、文件/工具与平台能力 | [lib.rs](../../src-tauri/src/lib.rs)、[paths.rs](../../src-tauri/src/paths.rs)、[commands/](../../src-tauri/src/commands/) |
| Rust window / monitor | Windows/macOS 窗口与前台应用监控 | [window/](../../src-tauri/src/window/)、[monitor/](../../src-tauri/src/monitor/) |
| Live Test | Contract、Scene、隔离宿主与报告 | [测试 README](../../src/services/__tests__/live/README.md) |

图层和景深的共享计算位于 [composables/](../../src/composables/)，展示入口是 [StreamView.vue](../../src/components/StreamView.vue)。[init.ts](../../src/services/init.ts) 负责能力准备和模式资源生命周期。

## 主消息链路

```text
sendMessage → preprocessor / Slash
  → 空闲 slot.admitInput() → driveAdmitted()（先 lane.accept 落盘再驱动，不走上游 lane.prompt）/ 忙碌 lane 持久 inbox（steer / followUp）
  → runPiAgentTurn：捕获会话与运行身份、Card/变量/模型快照（preflight）
      → 准备当前模式工具与 Skill 元数据
      → 助手模式按配置执行可选 Plan，取得步骤结果
      → recallMemory（默认空）→ Harness Lane：transform_context 投影 → Provider → before_tool 权限与执行
      → 条目提交、逐请求 usage、流式正文事件
      → ReplyGenerator：RUNTIME_DATA、变量与显示文本
  → 固定 session 的条目/状态完成 → Vue 投影
```

该图描述普通消息主路径。主动消息、Slash、错误和恢复有各自来源与终止路径；不能据此推断每条输入都调用模型或 Planner。

## 状态所有权

| 生命周期 | 所有者 | 边界 |
|---|---|---|
| 跨重启 | 配置文件、Card/Profile 资源、会话 JSONL 条目 | 文件原子提交；index 不是正文来源 |
| 应用 | 配置、Card/Profile 选择、能力目录 | 新 run 读取快照；切换有专用入口 |
| 会话 | Lane 持久 inbox、会话 JSONL 条目 | 身份由 sessionId 与操作代际关联 |
| 单次运行 | 冻结模型/能力/Prompt 来源、AbortSignal、写队列 | 旧运行不能修改新的会话或 Card 所有者 |
| 界面 | Vue 标签、消息、进度与表达效果 | 从领域事实投影（会话列表读模型归 session 模块），不重建第二份持久化 Store |

具体模型工厂、重试、取消、Plan 恢复、PromptSnapshot 与工具写入顺序由[运行时契约](runtime-contract.md)维护。

## 启动与资源

窗口共用 `bootWindow()`：安装异常拦截 → 初始化路径和配置 → 设置日志级别 → 挂载 Vue。主应用再由 `init.ts` 初始化对应能力。

MCP 不随应用启动连接；助手回合按 owner 借用，最后释放时关闭。Skill 缓存元数据，正文经工具按需读。记忆 LLM 整理不挂启动定时器；Card 阶段文案的加载/缺失生成属于另一条人格准备路径。

Profile 与默认资源的位置见[运行时数据](runtime-data.md)，构建/平台/日志诊断见[工程参考](development.md)。不要从旧方案的候选类名推导必须存在同名“全局状态内核”。
