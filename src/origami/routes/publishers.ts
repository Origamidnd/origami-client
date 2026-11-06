import { origamiProgramPublishers } from '@/services/cmds'

const known = new Map<string, string | null>()
const asking = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

const keyOf = (path: string) => path.toLowerCase()

/** The publisher of a file, once it has been read. */
export const publisherOf = (path?: string | null) =>
  (path && known.get(keyOf(path))) || null

/** Reads the files not read yet. A failure counts as no publisher: it is not asked again and again. */
export const learnPublishers = async (paths: (string | undefined)[]) => {
  const fresh = [
    ...new Set(paths.filter((path): path is string => !!path)),
  ].filter((path) => !known.has(keyOf(path)) && !asking.has(keyOf(path)))
  if (!fresh.length) return
  fresh.forEach((path) => asking.add(keyOf(path)))
  const found = await origamiProgramPublishers(fresh).catch(() => null)
  for (const path of fresh) {
    asking.delete(keyOf(path))
    known.set(keyOf(path), found?.[path] ?? null)
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
