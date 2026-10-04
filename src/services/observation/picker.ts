import { invoke } from "@tauri-apps/api/core"

/** Native picker; Rust returns only an allowed, canonical project root. */
export async function pickObservationProject(): Promise<string | null> {
  return invoke<string | null>("pick_observation_project")
}
