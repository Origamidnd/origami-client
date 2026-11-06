import { origamiGameTitles } from '@/services/cmds'

const known = new Map<string, string | null>()
const asking = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

const keyOf = (path: string) => path.toLowerCase()

/** The game behind a program file, once it has been looked up. Only a label. */
export const gameTitleOf = (path?: string | null) =>
  (path && known.get(keyOf(path))) || null

/**
 * Looks up the files not seen yet. An empty answer may mean that the list is not there yet, so those
 * stay unknown and the next look asks again; the backend does not repeat a failed download at once.
 */
export const learnGameTitles = async (paths: (string | undefined)[]) => {
  const fresh = [
    ...new Set(paths.filter((path): path is string => !!path)),
  ].filter((path) => !known.has(keyOf(path)) && !asking.has(keyOf(path)))
  if (!fresh.length) return
  fresh.forEach((path) => asking.add(keyOf(path)))
  const found = await origamiGameTitles(fresh).catch(() => null)
  fresh.forEach((path) => asking.delete(keyOf(path)))
  if (!found || Object.keys(found).length === 0) return
  for (const path of fresh) known.set(keyOf(path), found[path] ?? null)
  version += 1
  listeners.forEach((listener) => listener())
}

export const subscribeGameTitles = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const gameTitlesVersion = () => version
