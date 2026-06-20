// ==========================================
// 人格界限状态（表层 / 中层 / 深层）
// 不修改人格卡，不修改 AI 逻辑，独立模块
// ==========================================

import { createLogger } from "@/services/logger";

const log = createLogger("Boundary");

/** 界限等级：2=表层, 4=中层, 5+=深层 */
let boundaryLevel = 2;

export function getBoundaryLevel(): number {
  return boundaryLevel;
}

export function setBoundaryLevel(level: number): void {
  boundaryLevel = Math.max(2, level);
}

export function incrementBoundary(): void {
  boundaryLevel++;
}

export function resetBoundary(): void {
  boundaryLevel = 2;
}

/** 界限描述 */
export function boundaryLabel(): string {
  if (boundaryLevel <= 3) return "表层";
  if (boundaryLevel <= 4) return "中层";
  return "深层";
}

if (typeof window !== "undefined") {
  (window as any).__boundary = {
    get: getBoundaryLevel,
    set: setBoundaryLevel,
    inc: incrementBoundary,
    reset: resetBoundary,
    label: boundaryLabel,
  };
  log.info("__boundary.set/.inc/.get 就绪 | 当前:", boundaryLabel());
}
