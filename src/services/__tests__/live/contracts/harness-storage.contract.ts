import type { ModuleContract } from "../types"

export const harnessStorageContract: ModuleContract = {
  module: "harness-storage",
  sourceFiles: [
    "src/services/engine/pi/session-repo.ts",
    "src/services/tool/pi/tauri-execution-env.ts",
  ],
  generatedAt: "2026-09-17",
  sourceHash: "42536436bd8ae91d1dd813644ec3f9be40697862d821d14a1406ac7af5878d86",
  coverage: [
    {
      id: "hs-01",
      feature: "JsonlSessionRepo 官方一致性",
      description: "官方一致性套件的 lifecycle/ownership/messages/fork 共 15 条 case 在 TauriExecutionEnv（真实 Rust IPC）上通过：创建、列举、删除、独占打开、消息持久化、fork；fork destination reservation 组依赖「先调用者先占位」的时序，在官方 NodeExecutionEnv 上同样稳定失败（上游竞态），不纳入",
      why: "H-1 用官方协议验证存储实现，重启恢复与 fork 语义不靠自造断言",
      depth: "deep",
      scenarios: ["harness-session-repo-conformance"],
    },
    {
      id: "hs-02",
      feature: "TauriExecutionEnv FileSystem 补全",
      description: "appendFile/renameFile/createDir/remove/createTempDir 经真实 Rust 命令完成且不 throw：rename 原子替换已存在目标；remove 遵守 recursive/force（force 时缺失算成功，目录需 recursive）；createDir 默认递归",
      why: "JsonlSessionRepo 的原子发布依赖 append+rename，能力缺口会让会话无法落盘",
      depth: "deep",
      scenarios: ["harness-execution-env-filetree"],
    },
    {
      id: "hs-03",
      feature: "会话重启恢复与目录边界",
      description: "同一磁盘根上新建仓库实例后，list 从磁盘头部恢复 metadata、open 重新加载会话状态；会话文件落在数据根 pi-sessions 下，不写进旧 sessions/*.md",
      why: "H-1 的完成条件是重启后可恢复会话，且新旧会话格式不得混放",
      depth: "deep",
      scenarios: ["harness-session-restart-recovery"],
    },
  ],
  rules: {
    minScenarios: 3,
    minDeepScenarios: 3,
    requireBoundary: true,
    requireErrorPath: true,
    unitOnly: true,
    unitOnlyReason: "H-1 只验证存储层：官方一致性套件与 FileSystem 行为都在应用内通过真实 Rust IPC 执行，但都不经过模型；模型驱动的 Harness 全链路（accept/drive/steer）按 §8.9 属于 H-2，本批次没有可运行的 production/runtime 入口",
  },
}
