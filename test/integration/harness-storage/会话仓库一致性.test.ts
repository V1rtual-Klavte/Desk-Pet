// ==========================================
// 会话仓库一致性 —— 从 test/e2e/scenes/harness-storage/会话仓库一致性.scene.ts 迁到 L3（W2）
//
// 跑的是 pi 官方一致性套件（`@earendil-works/pi-agent-core/harness/session/testing`）：
// **断言在上游包里**，本仓只负责映射层（freshRepo / closeCurrentRepo / 用例选择）。因此本用例
// 只能为映射层背书，不能为上游断言本身的鉴别力背书（受限于上游，无法审上游断言）。
//
// 映射层复核结论（W2 审视）：
//   · 用例选择：15/17 条（lifecycle 4 / ownership 1 / messages 2 / fork 行为 7 / fork 源快照 1），
//     唯一未纳入的是 fork destination reservation 组（2 条）—— `JsonlSessionRepo.fork` 在占位前多
//     一次 `captureForkSource` await，而 `create` 更早进入 `resolveCreateDestination`，并发时 create
//     总是先占位、fork 被拒；该组在官方 NodeExecutionEnv（node:fs）上同样稳定失败（本机复现
//     16/17，同一 case），属上游竞态，与本适配器无关。
//   · 转发层不丢信息：`conformanceCase.run()` 的 rejection 由 `expect(...).resolves` 原样上报；
//     `list` 的 options 在官方泛型里是 `TListOptions = void`（`harness/session/types.d.ts`），
//     15 条入选 case 全部以 `list(undefined, ctx)` 调用，`(_options) => repo.list(undefined, …)`
//     这层转发因此是逐字等价的，不是弱化。
//   · 每个 case 拿到全新会话根、repo 实例各自独立（官方套件按「根目录里只有本 case 的会话」断言）。
// ==========================================

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import {
  createSessionRepoForkBehaviorConformance,
  createSessionRepoForkSourceSnapshotConformance,
  createSessionRepoLifecycleConformance,
  createSessionRepoMessageConformance,
  createSessionRepoOwnershipConformance,
} from "@earendil-works/pi-agent-core/harness/session/testing"
import type { JsonlSessionMetadata, SessionRepo } from "@earendil-works/pi-agent-core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { createPiSessionRepo } from "@/services/engine/harness"
import type { PiSessionRepo } from "@/services/engine/harness"
import { initPaths, runtimePath } from "@/services/paths"

let dataRoot = ""

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "deskpet-harness-conformance-"))
  setTestDataRoot(dataRoot)
  await initPaths()
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

/**
 * 官方一致性套件按「根目录里只有本 case 的会话」做断言（如 list 精确匹配两个 id），
 * 所以每个 case 必须拿到全新会话根；repo 实例也各自独立，才能测出独占打开与恢复。
 */
let currentRepo: PiSessionRepo | undefined

/**
 * 官方工厂的泛型默认把 list 的 options 收窄成 `void`（`SessionRepo<TMetadata, TCreateOptions, TListOptions = void>`），
 * 与门面的 `JsonlSessionListOptions` 签名不兼容；这里按官方签名做一层纯转发，不改变行为。
 */
async function freshRepo(): Promise<SessionRepo<JsonlSessionMetadata>> {
  const sessionsRoot = await runtimePath("data", `conformance-${crypto.randomUUID()}`)
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
 * 官方 runner-independent case 直接映射成 L3 断言：`run()` 以 rejection 表示失败，
 * 交给 expect 原样上报（不吞、不包装）。
 */
const conformanceCases = [
  ...createSessionRepoLifecycleConformance(freshRepo, closeCurrentRepo),
  ...createSessionRepoOwnershipConformance(freshRepo, closeCurrentRepo),
  ...createSessionRepoMessageConformance(freshRepo, closeCurrentRepo),
  ...createSessionRepoForkBehaviorConformance(freshRepo, closeCurrentRepo),
  ...createSessionRepoForkSourceSnapshotConformance(freshRepo, closeCurrentRepo),
]

describe("会话仓库一致性", () => {
  it("官方 SessionRepo 一致性套件（lifecycle/ownership/messages/fork，不含上游竞态组）跑在 NativeExecutionEnv 上 [harness-session-repo-conformance]", async () => {
    // 集合为空时下面的循环是空转（0 条断言也全绿）—— 上游工厂改名/删除时会静默失去覆盖，
    // 所以先钉住条数（lifecycle 4 / ownership 1 / messages 2 / fork 行为 7 / fork 源快照 1）。
    expect(conformanceCases.length).toBe(15)
    for (const conformanceCase of conformanceCases) {
      // 逐条断言：rejection 即该 case 失败，消息里带上 group/name 便于定位。
      await expect(
        conformanceCase.run(),
        `官方一致性 case 未通过: ${conformanceCase.group}/${conformanceCase.name}`,
      ).resolves.toBeUndefined()
    }
  })
})
