import { useSyncExternalStore } from 'react'

import { restartCore } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'

export type CoreTroubleKind = 'startFailed' | 'serviceCoreStopped' | 'config'

export interface CoreTrouble {
  kind: CoreTroubleKind
  detail: string
}

// The service already restarts a crashed core on its own; when it gives up, the app tries again
// itself before asking the user, at most this many times in the window below.
const AUTO_RESTARTS = 2
const AUTO_WINDOW_MS = 10 * 60 * 1000

let current: CoreTrouble | null = null
let restarts: number[] = []
const listeners = new Set<() => void>()

const set = (next: CoreTrouble | null) => {
  current = next
  listeners.forEach((listener) => listener())
}

export const closeCoreTrouble = () => set(null)

export const currentCoreTrouble = () => current

/** Tries a quiet restart for a core that stopped, then shows the dialog if that did not help. */
export const reportCoreTrouble = async (
  trouble: CoreTrouble,
  now = Date.now(),
) => {
  restarts = restarts.filter((at) => now - at < AUTO_WINDOW_MS)
  if (
    trouble.kind === 'serviceCoreStopped' &&
    restarts.length < AUTO_RESTARTS
  ) {
    restarts.push(now)
    try {
      await restartCore()
      showNotice.info('origami.coreTrouble.restarted')
      return
    } catch {
      // Falls through to the dialog.
    }
  }
  set(trouble)
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useCoreTrouble = () =>
  useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  )
