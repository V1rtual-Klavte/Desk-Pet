import type { ObservationKind } from "./types"

/** Stable artifact identity never contains window title or observed content. */
export async function observationEvidenceId(kind: ObservationKind, identity: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${kind}\n${identity.normalize("NFC").replace(/\\/g, "/")}`)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("")
}

/** Window and screenshot records share app identity; title is mutable input, not an artifact key. */
export function observationWindowEvidenceId(appId: string | null): Promise<string> {
  return observationEvidenceId("window", appId ?? "")
}

/** Content version fingerprint; callers persist only this hash, never another source copy. */
export async function observationEvidenceHash(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload))
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("")
}
