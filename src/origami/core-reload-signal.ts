const listeners = new Set<() => void>()

/** Called by the event bus when the core has started or reloaded its config. */
export const notifyCoreReloaded = () => {
  listeners.forEach((listener) => listener())
}

export const onCoreReloaded = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
