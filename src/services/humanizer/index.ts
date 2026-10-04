import { humanizerSilenceGuard } from "./protocol"
import { humanizerScheduler } from "./scheduler"

export {
  HUMANIZER_PROMPT,
  HUMANIZER_SILENT_MARKER,
  HUMANIZER_SPLIT_MARKER,
  SilenceGuard,
  humanizerSilenceGuard,
  transformHumanizerText,
} from "./protocol"
export type { HumanizedText, HumanizerFlow, SilenceResolution } from "./protocol"
export {
  HUMANIZER_TIMING,
  HumanizerScheduler,
  cancelSession,
  enqueueCommitted,
  getRevealState,
  humanizerScheduler,
  revealAll,
  setFirstRevealHandler,
  subscribe,
} from "./scheduler"
export type {
  EnqueueCommittedHumanizedMessage,
  HumanizerClock,
  HumanizerRevealState,
} from "./scheduler"

/** Clear reveal timers, UI subscribers, and per-session silence counters between isolated tests. */
export function resetHumanizerForTest(): void {
  humanizerScheduler.resetForTest()
  humanizerSilenceGuard.clear()
}
