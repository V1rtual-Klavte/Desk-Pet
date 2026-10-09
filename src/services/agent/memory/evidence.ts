import { completeBehaviorDerivedInvalidation, needsBehaviorDerivedInvalidation } from "@/services/behavior"

let reconciliation: Promise<void> | undefined

/** Close legacy evidence before either serving or registering derived memory. Failures remain retryable. */
export async function reconcileDerivedMemoryEvidence(): Promise<void> {
  if (reconciliation) return reconciliation
  reconciliation = (async () => {
    // Lazy imports avoid observation -> memory and memory initialization cycles.
    const observation = await import("@/services/observation")
    await observation.getUnderstandingSnapshotAsync()
    const behaviorPending = await needsBehaviorDerivedInvalidation()
    const understandingPending = observation.hasUnverifiedMemoryClosurePending()
    if (!behaviorPending && !understandingPending) return
    const memory = await import("./index")
    if (behaviorPending) {
      await memory.forgetDerivedBehaviorMemory()
      await completeBehaviorDerivedInvalidation()
    } else if (understandingPending) {
      await memory.forgetUnderstandingDerivedMemory()
    }
    // The behavior closure includes understanding; ack only after the transaction commits.
    if (understandingPending) await observation.completeUnverifiedMemoryClosure()
  })()
  try { await reconciliation }
  finally { reconciliation = undefined }
}
