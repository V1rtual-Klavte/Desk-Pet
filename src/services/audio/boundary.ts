// ==========================================
// 人格界限状态 —— 兼容层
// 已迁移至 src/services/personality/boundary.ts
// ==========================================

import { getBoundaryInfo, getBoundaryLevel, setBoundaryLevel, incrementBoundary, resetBoundary } from "@/services/personality"
import { createLogger } from "@/services/logger"

const log = createLogger("Boundary")

export {
  getBoundaryLevel,
  setBoundaryLevel,
  incrementBoundary,
  resetBoundary,
}

/** 界限描述（兼容旧导出名） */
export function boundaryLabel(): string {
  return getBoundaryInfo().label
}

// ── F12 调试（保持兼容）──
if (typeof window !== "undefined") {
  if (!(window as any).__boundary) {
    (window as any).__boundary = {
      get: getBoundaryLevel,
      set: setBoundaryLevel,
      inc: incrementBoundary,
      reset: resetBoundary,
      label: boundaryLabel,
    }
  }
  log.info("__boundary 就绪")
}
