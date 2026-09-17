import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import {
  createSessionRepoForkBehaviorConformance,
  createSessionRepoForkSourceSnapshotConformance,
  createSessionRepoLifecycleConformance,
  createSessionRepoMessageConformance,
  createSessionRepoOwnershipConformance,
} from "@earendil-works/pi-agent-core/harness/session/testing"
import type { JsonlSessionMetadata, SessionRepo } from "@earendil-works/pi-agent-core"
import type { SceneDef } from "../../types"
import { createPiSessionRepo, PI_SESSIONS_DIR } from "@/services/engine/pi"
import type { PiSessionRepo } from "@/services/engine/pi"
import { runtimePath } from "@/services/paths"

/**
 * 官方一致性套件按「根目录里只有本 case 的会话」做断言（如 list 精确匹配两个 id），
 * 所以每个 case 必须拿到全新会话根；repo 实例也各自独立，才能测出独占打开与恢复。
 */
let currentRepo: PiSessionRepo | undefined

/**
 * 官方工厂的泛型默认把 list 的 options 收窄成 `void`，与门面的
 * JsonlSessionListOptions 签名不兼容；这里按官方签名做一层纯转发，不改变行为。
 */
async function freshRepo(): Promise<SessionRepo<JsonlSessionMetadata>> {
  const sessionsRoot = await runtimePath("data", PI_SESSIONS_DIR, `conformance-${crypto.randomUUID()}`)
  const repo = await createPiSessionRepo({ sessionsRoot })
  currentRepo = repo
  return {
    create: (options, context) => repo.create(options, context),
    open: (metadata, context) => repo.open(metadata, context),
    list: (_options, context) => repo.list(undefined, context),
    delete: (metadata, context) => repo.delete(metadata, context),
    fork: (source, options, context) => repo.fork(source, options, context),
  }
}

function closeCurrentRepo(): Promise<void> | undefined {
  return currentRepo?.close(BACKGROUND_CONTEXT)
}

/**
 * 官方 `createSessionRepoConformance` 的 runner-independent case 直接映射成 Live Test 断言。
 *
 * 唯一未纳入的是 fork destination reservation 组（「先调用者先占住目标 id」）：
 * `JsonlSessionRepo.fork` 在占位前多一次 `captureForkSource` await，而 `create` 更早进入
 * `resolveCreateDestination`，所以并发时 create 总是先占位、fork 被拒 —— 该组第二条 case
 * 因此在官方 NodeExecutionEnv（node:fs）上同样稳定失败（本机复现：16/17，同一 case）。
 * 这是上游实现的竞态，与本适配器无关；其余 15 条 case 两边都通过。
 */
const conformanceCases = [
  ...createSessionRepoLifecycleConformance(freshRepo, closeCurrentRepo),
  ...createSessionRepoOwnershipConformance(freshRepo, closeCurrentRepo),
  ...createSessionRepoMessageConformance(freshRepo, closeCurrentRepo),
  ...createSessionRepoForkBehaviorConformance(freshRepo, closeCurrentRepo),
  ...createSessionRepoForkSourceSnapshotConformance(freshRepo, closeCurrentRepo),
]

export const 会话仓库一致性: SceneDef = {
  meta: {
    caseId: "harness-session-repo-conformance",
    module: "harness-storage",
    contractId: "hs-01",
    description: "官方 SessionRepo 一致性套件（lifecycle/ownership/messages/fork，不含上游竞态组）跑在 TauriExecutionEnv 上",
    depth: "deep",
    suite: "regression",
    entry: "unit",
    tags: ["harness-storage", "session-repo"],
  },
  turns: [{
    index: 1,
    description: "逐条运行官方 conformance case",
    userText: "运行官方 SessionRepo 一致性套件。",
    checks: conformanceCases.map(conformanceCase => ({
      type: `${conformanceCase.group}/${conformanceCase.name}`,
      run: () => conformanceCase.run(),
    })),
  }],
}

export default 会话仓库一致性
