import type { ModuleContract } from "../types"

export const harnessStorageContract: ModuleContract = {
  module: "harness-storage",
  sourceFiles: [
    "src/services/engine/pi/session-repo.ts",
    "src/services/tool/pi/tauri-execution-env.ts",
    "src/services/session/repo.ts",
  ],
  generatedAt: "2026-09-23",
  sourceHash: "38aa8f29b2990114f01125fab0750dd6d852e5867173c2a822971f0eae1280ec",
  coverage: [
    {
      id: "hs-01",
      feature: "JsonlSessionRepo 官方一致性",
      description: "官方一致性套件的 lifecycle/ownership/messages/fork 共 15 条 case 在 TauriExecutionEnv（真实 Rust IPC）上通过：创建、列举、删除、独占打开、消息持久化、fork；fork destination reservation 组依赖「先调用者先占位」的时序，在官方 NodeExecutionEnv 上同样稳定失败（上游竞态），不纳入。本覆盖点是 H-1 的存储层边界：只验证存储实现，不经过模型；生产入口的写入路径由 hs-04 承接",
      why: "H-1 用官方协议验证存储实现，重启恢复与 fork 语义不靠自造断言",
      depth: "deep",
      scenarios: ["harness-session-repo-conformance"],
    },
    {
      id: "hs-02",
      feature: "TauriExecutionEnv FileSystem 补全",
      description: "appendFile/renameFile/createDir/remove/createTempDir/listDir 经真实 Rust 命令完成且不 throw：rename 原子替换已存在目标；remove 遵守 recursive/force（force 时缺失算成功，目录需 recursive）；createDir 默认递归；listDir 直接返回绝对 path、size、mtimeMs 与 file/directory/symlink 三值 kind",
      why: "JsonlSessionRepo 的原子发布依赖 append+rename，list 依赖完整 FileInfo 字段，能力缺口会让会话无法落盘或无法恢复",
      depth: "deep",
      scenarios: ["harness-execution-env-filetree"],
    },
    {
      id: "hs-03",
      feature: "会话重启恢复与目录边界",
      description: "同一磁盘根上新建仓库实例后，list 从磁盘头部恢复 metadata、open 重新加载会话状态；会话文件落在给定会话根（数据根 sessions/ 同形）的 --cwd-- 子目录下，根上的 index.json（UI 状态）与旧 .md 残留不参与扫描、也不影响读写",
      why: "H-1 的完成条件是重启后可恢复会话，且会话正文与同根的 UI 状态文件互不干扰",
      depth: "deep",
      scenarios: ["harness-session-restart-recovery"],
    },
    {
      id: "hs-04",
      feature: "旁路写入与分支 tip 链",
      description: "阻塞工具期间经 session/repo 的旁路入口写入自定义条目：条目在会话文件中可读，且回合结束后仍在 lane 分支 tip 链上",
      why: "lane 的 tip 缓存若挤掉旁路写入，审计条目会静默从证据链里消失",
      depth: "deep",
      scenarios: ["harness-branch-tip-bypass"],
    },
  ],
  rules: {
    minScenarios: 4,
    minDeepScenarios: 4,
    requireBoundary: true,
    requireErrorPath: true,
  },
}
