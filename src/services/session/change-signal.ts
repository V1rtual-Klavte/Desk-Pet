/** In-process hints for changes to authoritative session files. */
type SessionFileChangeListener = (path: string) => void

const listeners = new Set<SessionFileChangeListener>()

export function subscribeSessionFileChanges(listener: SessionFileChangeListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function notifySessionFileChanged(path: string): void {
  for (const listener of listeners) listener(path)
}
