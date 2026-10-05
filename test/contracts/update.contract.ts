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
import type { ModuleContract } from "../host/types"

export const updateContract: ModuleContract = {
  module: "update",
  sourceFiles: [
    "src/services/host/types.ts",
    "src/services/host/index.ts",
    "src/services/native-ui/index.ts",
    "src/services/native-ui/host-requests.ts",
  ],
  sourceHash: "6c0609549d563ddf63d17d695eebcd24f6999578de24536200a77cc22174f631",
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
