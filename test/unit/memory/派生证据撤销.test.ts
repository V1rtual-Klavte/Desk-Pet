import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  behaviorPending: false,
  understandingPending: false,
  needsBehaviorDerivedInvalidation: vi.fn(async () => false),
  completeBehaviorDerivedInvalidation: vi.fn(async () => undefined),
  getUnderstandingSnapshotAsync: vi.fn(async () => undefined),
  hasUnverifiedMemoryClosurePending: vi.fn(() => false),
  completeUnverifiedMemoryClosure: vi.fn(async () => undefined),
  forgetDerivedBehaviorMemory: vi.fn(async () => undefined),
  forgetUnderstandingDerivedMemory: vi.fn(async () => undefined),
}))

vi.mock("@/services/behavior", () => ({
  needsBehaviorDerivedInvalidation: state.needsBehaviorDerivedInvalidation,
  completeBehaviorDerivedInvalidation: state.completeBehaviorDerivedInvalidation,
}))

vi.mock("@/services/observation", () => ({
  getUnderstandingSnapshotAsync: state.getUnderstandingSnapshotAsync,
  hasUnverifiedMemoryClosurePending: state.hasUnverifiedMemoryClosurePending,
  completeUnverifiedMemoryClosure: state.completeUnverifiedMemoryClosure,
}))

vi.mock("@/services/agent/memory/index", () => ({
  forgetDerivedBehaviorMemory: state.forgetDerivedBehaviorMemory,
  forgetUnderstandingDerivedMemory: state.forgetUnderstandingDerivedMemory,
}))

import { reconcileDerivedMemoryEvidence } from "@/services/agent/memory/evidence"

describe("派生记忆证据撤销闭环", () => {
  beforeEach(() => {
    state.behaviorPending = false
    state.understandingPending = false
    state.needsBehaviorDerivedInvalidation.mockImplementation(async () => state.behaviorPending)
    state.hasUnverifiedMemoryClosurePending.mockImplementation(() => state.understandingPending)
    state.completeBehaviorDerivedInvalidation.mockClear()
    state.getUnderstandingSnapshotAsync.mockClear()
    state.completeUnverifiedMemoryClosure.mockClear()
    state.forgetDerivedBehaviorMemory.mockReset().mockResolvedValue(undefined)
    state.forgetUnderstandingDerivedMemory.mockReset().mockResolvedValue(undefined)
  })

  it("并发双 pending 合并成一次全派生清理，事务成功后才双重确认 [derived-evidence-coalesces-all-scopes]", async () => {
    state.behaviorPending = true
    state.understandingPending = true

    await Promise.all([reconcileDerivedMemoryEvidence(), reconcileDerivedMemoryEvidence()])

    expect(state.getUnderstandingSnapshotAsync).toHaveBeenCalledTimes(1)
    expect(state.forgetDerivedBehaviorMemory).toHaveBeenCalledTimes(1)
    expect(state.forgetUnderstandingDerivedMemory).not.toHaveBeenCalled()
    expect(state.completeBehaviorDerivedInvalidation).toHaveBeenCalledTimes(1)
    expect(state.completeUnverifiedMemoryClosure).toHaveBeenCalledTimes(1)
  })

  it("全派生清理事务失败时不确认 pending，后续调用可重试 [derived-evidence-retry-after-transaction-failure]", async () => {
    state.behaviorPending = true
    state.understandingPending = true
    state.forgetDerivedBehaviorMemory.mockRejectedValueOnce(new Error("transaction failed"))

    await expect(reconcileDerivedMemoryEvidence()).rejects.toThrow("transaction failed")
    expect(state.completeBehaviorDerivedInvalidation).not.toHaveBeenCalled()
    expect(state.completeUnverifiedMemoryClosure).not.toHaveBeenCalled()

    await reconcileDerivedMemoryEvidence()
    expect(state.forgetDerivedBehaviorMemory).toHaveBeenCalledTimes(2)
    expect(state.completeBehaviorDerivedInvalidation).toHaveBeenCalledTimes(1)
    expect(state.completeUnverifiedMemoryClosure).toHaveBeenCalledTimes(1)
  })

  it("仅了解 pending 时只清除了解来源范围 [derived-evidence-understanding-scope-only]", async () => {
    state.understandingPending = true

    await reconcileDerivedMemoryEvidence()

    expect(state.forgetUnderstandingDerivedMemory).toHaveBeenCalledTimes(1)
    expect(state.forgetDerivedBehaviorMemory).not.toHaveBeenCalled()
    expect(state.completeBehaviorDerivedInvalidation).not.toHaveBeenCalled()
    expect(state.completeUnverifiedMemoryClosure).toHaveBeenCalledTimes(1)
  })

  it("没有旧 pending 时不触发清理事务或确认写入 [derived-evidence-no-pending-no-transaction]", async () => {
    await reconcileDerivedMemoryEvidence()

    expect(state.forgetDerivedBehaviorMemory).not.toHaveBeenCalled()
    expect(state.forgetUnderstandingDerivedMemory).not.toHaveBeenCalled()
    expect(state.completeBehaviorDerivedInvalidation).not.toHaveBeenCalled()
    expect(state.completeUnverifiedMemoryClosure).not.toHaveBeenCalled()
  })
})
