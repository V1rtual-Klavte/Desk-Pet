import type { AppCategory, WindowObservation } from "@/services/window/types"

export type { AppCategory, WindowObservation }
export { IDLE_ACTIVE_LIMIT_MS } from "@/services/window/types"

export interface BehaviorQuality {
  status: "reliable" | "insufficient" | "unavailable"
  sampleDays: number
  coverageRatio: number
  eligibleCollectionMs: number
  reasons: string[]
}

export const BEHAVIOR_MEASUREMENT_VERSION = 2 as const
export type BehaviorActivityBucket = "active" | "idle" | "unknown" | "unobserved"

export interface BehaviorDaily {
  measurementVersion: typeof BEHAVIOR_MEASUREMENT_VERSION
  date: string
  activeMs: number
  unknownMs: number
  idleMs: number
  unobservedMs: number
  petForegroundMs: number
  categoryMs: Record<AppCategory, number>
  hourMs: number[]
  workSegments: number
  workTotalMs: number
  workLongestMs: number
  appMs: Record<string, number>
  switches: number
  coveredMs: number
  classifiedMs: number
  unclassifiedMs: number
}

export interface BehaviorSnapshot {
  measurementVersion: typeof BEHAVIOR_MEASUREMENT_VERSION
  revision: number
  generatedAt: number
  quality: BehaviorQuality
  rhythm: { weekdays: number[]; weekends: number[]; days7: number; days30: number }
  apps: { categoryShare: Record<AppCategory, number>; commonAppIds: string[]; unknownRatio: number; classificationRatio: number; classifiedMs: number; unclassifiedMs: number }
  focus: { segments: number; totalMs: number; longestMs: number; meanMs: number; switchesPerHour: number; currentContinuousMs: number; currentCategory: AppCategory | null }
  activity: { byHour: number[]; activeMs: number; idleMs: number; unknownMs: number; unobservedMs: number; petForegroundMs: number }
  weekly: {
    days: number
    focus: { segments: number; totalMs: number; longestMs: number; meanMs: number; switchesPerHour: number; coveredMs: number }
    activity: { byHour: number[]; activeMs: number; idleMs: number; unknownMs: number; unobservedMs: number; petForegroundMs: number }
  }
}

export interface BehaviorSegment {
  date: string
  appId: string | null
  category: AppCategory
  startAt: number
  endAt: number
  durationMs: number
  activity: BehaviorActivityBucket
}
