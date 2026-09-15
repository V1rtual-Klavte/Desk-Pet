import type { ContextBlock } from "@/services/engine/runtime"
import type { MemoryProjection } from "@/services/agent/memory"

export interface UserProfileProjection {
  sourceId: "User.md"
  projectionVersion: 1
  provenance: "user_profile_file"
  taint: "derived"
  text: string
}

export function createUserProfileProjection(text: string): UserProfileProjection {
  return {
    sourceId: "User.md",
    projectionVersion: 1,
    provenance: "user_profile_file",
    taint: "derived",
    text,
  }
}

export function profileProjectionBlock(projection: UserProfileProjection): ContextBlock {
  return {
    blockId: "profile:user",
    layer: "profile",
    source: projection.sourceId,
    sourceId: projection.sourceId,
    provenance: projection.provenance,
    projectionVersion: projection.projectionVersion,
    text: projection.text,
    priority: 80,
    origin: "memory",
    taint: projection.taint,
  }
}

export function memoryProjectionBlocks(projections: MemoryProjection[]): ContextBlock[] {
  return projections.map((projection, index) => ({
    blockId: `memory:recall:${index}:${projection.sourceId}`,
    layer: "memory",
    source: "MemoryProvider",
    sourceId: projection.sourceId,
    provenance: projection.provenance,
    memoryVersion: projection.memoryVersion,
    text: projection.text,
    priority: 65,
    tokenBudget: projection.tokenBudget,
    origin: "memory",
    taint: projection.taint,
  }))
}
