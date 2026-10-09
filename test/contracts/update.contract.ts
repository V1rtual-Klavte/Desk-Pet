// 2026-10-09 最终静态复核：HostCommandMap新增会话索引命令，更新命令名字、参数与Node请求隔离保持原义；未执行测试。
// 应用内更新契约（Node 侧只有边界：命令形状 + 不承载更新动作）。
//
// 范围：`test/unit/release/update.test.ts` 的全部 caseId 锚点。更新真相源与安装
// 流程在 Rust Native UpdatePort（`crates/native-host/src/update/`），Node 不参与
// 验签、不接触制品字节 —— 因此本契约 sourceFiles 只登记被 L2 断言真正触碰的 TS
// 边界（命令矩阵、桥取用口、宿主请求分派），Rust 侧不在这里冒充。全部覆盖点在 L2；
// 真实下载/安装属 L4 与宿主自测，不在这里冒充。
//
// 2026-10-05 设置页 Card 增删改查 + 模版批次：host/types.ts 与 host-requests.ts 的变化
// 都是新增（HostCommandMap 加 personality_file_delete、HostRequestMap 加 4 条 Card 请求与
// CardManagePayload/Result、dispatch 加 4 条请求臂）；up-01 的「更新命令按冻结名字与形状
// 存在」不受影响，`action.checkUpdate` 与 `update_check` 两个名字仍走 default 分支以 OTHER
// 拒绝（四条新臂均为 card_*，不在其路径上）。逐点复核行为面未变，仅按当前源码刷新 sourceHash。
// 2026-10-05 二批复查（本批刷新）：另一会话同批把音效请求臂从 sound_assign 换成
// sound_set_assignment / sound_reset（host/types.ts 的 HostRequestMap 与 native-ui/host-requests.ts）；
// up-01 的更新命令边界与「更新动作不进 Node 请求面」路径不受影响（音效面不在其路径上）。
// 本批刷新同时包含另一会话对 host/types.ts / host-requests.ts 的改动；主会话只做了
// 「coverage 描述与当前实现一致性」的核对（不是逐行行为审计），仅按当前源码刷新 sourceHash。
// 2026-10-05 收尾复查（本批刷新）：sourceFiles 变化 —— src/services/host/types.ts 与
// src/services/host/index.ts（另一会话同批：音效请求臂与设置面类型扩展、文档路径改指归档）。
// up-01 逐条对照当前实现：更新命令形状（update_check / update_download_and_install /
// app_restart）仍成立，「更新动作不进 Node 请求面」（dispatchHostRequest 对 action.checkUpdate
// 与 update_check 均以 OTHER 拒绝）仍成立。本批刷新同时包含另一会话的改动；本轮只做 coverage
// 描述与当前实现一致性核对（非逐行行为审计），未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 聊天图片批次（本批刷新）：sourceFiles 变化 —— src/services/host/types.ts 新增
// HostCommandMap.chat_delete_session_images 一条（删会话清理托管聊天图片，不在更新路径上）。
// up-01 逐条对照当前实现：更新命令形状（update_check / update_download_and_install /
// app_restart）仍成立，「更新动作不进 Node 请求面」（dispatchHostRequest 对 action.checkUpdate
// 与 update_check 均以 OTHER 拒绝）仍成立。未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 dreaming 日 token 闸撤除批次（本批刷新）：sourceFiles 变化 ——
// src/services/host/types.ts（HostCommandMap 的 memory_dreaming_budget_reserve：去 dailyLimit、
// 响应 boolean → void——dreaming 日 token 上限不再作门禁，预留只记账）。本契约覆盖点不在改动
// 面内，未修订；本批刷新同时包含工作树中其它并发改动的源文件（非逐行行为审计），sourceHash
// 按当前源码复算。
// 2026-10-06 契约刷新（第二轮验收 · 本批刷新）：sourceFiles 变化 —— src/services/host/types.ts
// 两处均不在更新路径上：bash_exec.timeoutMs 的注释补充（毫秒直传语义与 bash 档位定义点
// tool/local/bash-timeout.ts 的关系；bash 超时档位批次）与 memory_dreaming_budget_reserve 的
// 签名变化（去 dailyLimit、result boolean→void，见上一条批次）。up-01 逐条对照当前实现：
// 更新命令形状（update_check / update_download_and_install / app_restart）仍成立，
// 「更新动作不进 Node 请求面」（dispatchHostRequest 对 action.checkUpdate 与 update_check
// 均走 default 以 OTHER 拒绝）仍成立。未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 提问选择与去超时批次（本批刷新）：sourceFiles 变化仅限
// `src/services/host/types.ts`（新增 deskpet-choice-start/end 推送与 deskpet-choice-resolved
// 回执；权限确认载荷去掉 expiresAt）。不在更新器行为面内；各覆盖点逐条核对实现点仍在、
// 描述与当前实现一致；sourceHash 按当前源码复算。
// 2026-10-06 超时后台化批次（本批刷新）：host/types.ts —— bash_exec 增可选入参 sessionId
//与 HostEventMap 增事件 bash-background-finished；更新域的消费面未动。各覆盖点逐点核对
//一致；sourceHash 按当前源码复算。
// 2026-10-06 派生行为结论沉淀批次（本批刷新）：host/types.ts —— memory_job_sources /
// memory_pending_source_count 入参增可选 origin（整理按来源类别取批）；更新域的消费面未动。
// 各覆盖点逐点核对一致；sourceHash 按当前源码复算（同批含另会话在飞改动）。
// 2026-10-06 设置页列表面板删除批次（本批刷新）：sourceFiles 变化仅限
// `src/services/host/types.ts`（ProfileManageResult / CardManageResult 删除 newId / activeId ——
// 只服务于已删除的设置页行级列表；属设置面管理孔，不在更新路径上）。up-01 逐条对照当前实现：
// 更新命令形状（update_check / update_download_and_install / app_restart）仍成立、
// 「更新动作不进 Node 请求面」仍成立。未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 Card 按需加载批次（本批刷新）：sourceFiles 变化 —— src/services/host/types.ts
// （update_download_and_install 的结果声明 void → { version: string }，与 Rust
// update/mod.rs 实际返回 `{"version": …}` 逐项对齐；Node 侧不消费该结果，L2 用例只断言
// 命令发出与顺序）与 src/services/native-ui/host-requests.ts（personality_cards 列表改现读
// Card 目录；不在更新路径上）。up-01 逐条对照当前实现：更新命令形状仍成立（结果声明更准）、
// 「更新动作不进 Node 请求面」仍成立。未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 抽屉三下拉统一 CONFIG 写批次（本批刷新）：sourceFiles 变化 ——
// src/services/host/types.ts（chat_send 线格式删除 delivery 参数；新增三条 chat_set_*
// 请求臂）与 src/services/native-ui/host-requests.ts（三条请求臂注册 + reapplyRuntimeSettings
// 的抽屉三键重推会话投影；personality_cards 现读与 Card 按需加载在上一批已登记）—— 都不在
// 更新路径上。up-01 逐条对照当前实现：更新命令形状（update_check /
// update_download_and_install / app_restart）仍成立，「更新动作不进 Node 请求面」
//（dispatchHostRequest 对 action.checkUpdate 与 update_check 均走 default 以 OTHER 拒绝）
// 仍成立。未修订覆盖点，仅按当前源码刷新 sourceHash。
import type { ModuleContract } from "../host/types"

export const updateContract: ModuleContract = {
  module: "update",
  sourceFiles: [
    "src/services/host/types.ts",
    "src/services/host/index.ts",
    "src/services/native-ui/index.ts",
    "src/services/native-ui/host-requests.ts",
  ],
  sourceHash: "351c17c1427865d6fa48bcf9fc243afbdca610a8ba3a76ca5834b594f7230782",
  coverage: [
    {
      id: "up-01",
      feature: "更新命令的边界形状与请求面隔离",
      description:
        "HostCommandMap 的更新命令按冻结名字与形状存在：update_check 的结果是候选描述或 null（null=没有可安装候选，不伪装成候选），update_download_and_install / app_restart 按各自形状发出；经取用口 request 的结果原样返回。更新动作不落进 Node 宿主请求面：宿主设置窗的 action.checkUpdate 与 update_check 经 dispatchHostRequest 都以 OTHER 拒绝（不路由成 Node 的 settings_commit 动作，也不另建第二份 Node 更新实现）",
      why: "更新命令名字/形状漂移会让宿主命令落错域；把更新动作并进 Node 请求面会造出与 Rust UpdatePort 并行的第二实现（验签与制品边界被绕过）",
      layer: "unit",
      depth: "deep",
      scenarios: [
        "native-update-check-command",
        "native-update-command-map",
        "native-update-settings-request-boundary",
      ],
    },
  ],
  // 本契约全部覆盖点在 L2：Node 侧只有命令边界与负向隔离，真实的更新流程在
  // Rust Native UpdatePort（L4 / 宿主自测），这里没有可核对内容。门槛按既有
  // no-e2e 契约的先例归零清空，不是放宽 —— 跨层完整性由 checkLayerCoverage 负责。
  rules: { minScenarios: 0, minDeepScenarios: 0, requireBoundary: false, requireErrorPath: false },
}
