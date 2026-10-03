import type { AppCategory, WindowObservation } from "@/services/window/types"

export type { AppCategory, WindowObservation }

export interface BehaviorQuality {
  status: "reliable" | "insufficient" | "unavailable"
  sampleDays: number
  coverageRatio: number
  eligibleCollectionMs: number
  reasons: string[]
}

export interface BehaviorDaily {
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
}

export interface BehaviorSnapshot {
  revision: number
  generatedAt: number
  quality: BehaviorQuality
  rhythm: { weekdays: number[]; weekends: number[]; days7: number; days30: number }
  apps: { categoryShare: Record<AppCategory, number>; commonAppIds: string[]; unknownRatio: number }
  focus: { segments: number; totalMs: number; longestMs: number; meanMs: number; switchesPerHour: number; currentContinuousMs: number; currentCategory: AppCategory | null }
  activity: { byHour: number[]; activeMs: number; idleMs: number; unobservedMs: number; petForegroundMs: number }
  weekly: {
    days: number
    focus: { segments: number; totalMs: number; longestMs: number; meanMs: number; switchesPerHour: number; coveredMs: number }
    activity: { byHour: number[]; activeMs: number; idleMs: number; unobservedMs: number; petForegroundMs: number }
  }
}

export interface BehaviorSegment {
  date: string
  appId: string | null
  category: AppCategory
  startAt: number
  endAt: number
  durationMs: number
  quality: "observed"
}
