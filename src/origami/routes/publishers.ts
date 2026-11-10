import { origamiProgramPublishers } from '@/services/cmds'

const known = new Map<string, string | null>()
const asking = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

const keyOf = (path: string) => path.toLowerCase()

/** The publisher of a file, once it has been read. */
export const publisherOf = (path?: string | null) =>
  (path && known.get(keyOf(path))) || null

// The backend reads at most this many files per call (src-tauri cmd/publisher.rs, MAX_PATHS) and
// leaves the rest out, which must not read as "no publisher".
const BATCH = 64
// A call that failed (PowerShell did not start) is not repeated every few seconds by the join timer,
// and its files are not marked as unsigned either.
const RETRY_AFTER_MS = 10 * 60 * 1000
let failedAt = Number.NEGATIVE_INFINITY

/** Reads the files not read yet. A file with no valid signature is remembered as having no publisher. */
export const learnPublishers = async (paths: (string | undefined)[]) => {
  if (Date.now() - failedAt < RETRY_AFTER_MS) return
  const fresh = [
    ...new Set(paths.filter((path): path is string => !!path)),
  ].filter((path) => !known.has(keyOf(path)) && !asking.has(keyOf(path)))
  if (!fresh.length) return
  fresh.forEach((path) => asking.add(keyOf(path)))
  try {
    for (let start = 0; start < fresh.length; start += BATCH) {
      const batch = fresh.slice(start, start + BATCH)
      const found = await origamiProgramPublishers(batch).catch(() => null)
      if (!found) {
        failedAt = Date.now()
        break
      }
      for (const path of batch) known.set(keyOf(path), found[path] ?? null)
    }
  } finally {
    fresh.forEach((path) => asking.delete(keyOf(path)))
  }
  version += 1
  listeners.forEach((listener) => listener())
}

export const subscribePublishers = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const publishersVersion = () => version
