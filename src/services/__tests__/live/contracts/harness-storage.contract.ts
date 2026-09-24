import type { ModuleContract } from "../types"

export const harnessStorageContract: ModuleContract = {
  module: "harness-storage",
  sourceFiles: [
    "src/services/engine/pi/session-repo.ts",
    "src/services/tool/pi/tauri-execution-env.ts",
    "src/services/session/repo.ts",
  ],
  generatedAt: "2026-09-24",
  sourceHash: "e7661c6ded0c314cddc64bdb697c74ea3fd639d5e263ac11ac4e93947d553e65",
  coverage: [
    {
      id: "hs-01",
      feature: "JsonlSessionRepo 官方一致性",
      description: "官方一致性套件 17 条 case 里取 15 条（lifecycle 4 / ownership 1 / messages 2 / fork 行为 7 / fork 源快照 1）在 TauriExecutionEnv（真实 Rust IPC）上通过：创建、列举、删除、独占打开、消息持久化、fork；fork destination reservation 组（2 条「先调用者先占位」）整体不纳入：其中「先 fork 后 create」一条依赖占位时序，在官方 NodeExecutionEnv（node:fs）上同样稳定失败（2026-09-24 复核：17 条里 16 过、1 败且败的正是该条）—— 上游 `JsonlSessionRepo.fork` 在占位前多一次 `captureForkSource` await，create 因此确定性地先占住目标 id，不是偶发抖动。本覆盖点是 H-1 的存储层边界：只验证存储实现，不经过模型；生产入口的写入路径由 hs-04 承接",
      why: "H-1 用官方协议验证存储实现，重启恢复与 fork 语义不靠自造断言",
      depth: "deep",
      scenarios: ["harness-session-repo-conformance"],
    },
    {
      id: "hs-02",
      feature: "TauriExecutionEnv FileSystem 补全",
      description: "readTextFile/writeFile/appendFile/renameFile/createDir/remove/createTempDir/listDir 经真实 Rust 命令完成且不 throw（失败以 Result 返回）；失败按 Rust 结构化错误码归类而不是拿 message 猜：PATH_NOT_FOUND→not_found、SENSITIVE_PATH 与 PATH_ESCAPE→permission_denied、NOT_ABSOLUTE→invalid，未列出的码（如 TOOL/IO，如「目标不是常规文件」）如实保持 unknown；rename 原子替换已存在目标；remove 遵守 recursive/force（force 时缺失算成功，目录需 recursive）；createDir 默认递归；listDir 直接返回绝对 path、size、mtimeMs 与 file/directory/symlink 三值 kind",
      why: "JsonlSessionRepo 的原子发布依赖 append+rename，list 依赖完整 FileInfo 字段，能力缺口会让会话无法落盘或无法恢复；错误码是调用方唯一的分类依据，文案随实现漂移",
      depth: "deep",
      scenarios: ["harness-execution-env-filetree"],
    },
    {
      id: "hs-03",
      feature: "会话重启恢复与目录边界",
      description: "同一磁盘根上新建仓库实例后，list 从磁盘头部恢复 metadata、open 重新加载会话状态；会话文件落在给定会话根（数据根 sessions/ 同形）的 --cwd-- 子目录下，根上的 index.json（UI 状态）与旧 .md 残留不参与扫描、也不影响读写；列举不默认按当前 cwd 过滤，也不忽略调用方显式传的 cwd：数据根变更或 --cwd-- 目录编码碰撞后，同根下别的 cwd 目录里的会话仍被如实列出（调用方按 metadata.cwd 自行判别），显式 { cwd } 则只列那一个目录。消费侧（session/repo 的 listPiSessionMetadata）对跨根项做一次性的留痕属日志行为，未由场景断言",
      why: "H-1 的完成条件是重启后可恢复会话，且会话正文与同根的 UI 状态文件互不干扰；「index.json 里有 id、列表里静默消失」正是列举按当前数据根过滤带来的现象",
      depth: "deep",
      scenarios: ["harness-session-restart-recovery"],
    },
    {
      id: "hs-04",
      feature: "旁路写入与分支 tip 链",
      description: "阻塞工具期间经 session/repo 的旁路入口写入自定义条目，按 2026-09-24 两轮实测钉住它回合结束后的归宿：条目在会话文件中可读、其 seq 早于收尾后的 tip，但**不在** lane 分支的 tip 链上 —— Harness 的提交面按内存 `state.tipId` 续写并覆盖 `branch.tip`，把旁路条目挤成孤立分支（两轮实测链上都查不到旁路 id，前后写入的条目都在）。这是已登记的会话层限制（修法归 session 层，不在本波范围）：断言钉的是真实现状并当回归守卫 —— 将来旁路条目回到链上时场景会失败并要求更新登记",
      why: "lane 的 tip 缓存若按旧 tip 续写，旁路写入的审计条目会静默从证据链里消失（条目还在文件里，却不在 tip 回溯链上）——本覆盖点就是这条风险的实测出口",
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
