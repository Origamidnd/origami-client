import { useSyncExternalStore } from 'react'

import type { CheckResults } from './use-diagnostics-text'

let request: CheckResults | null = null
const listeners = new Set<() => void>()

const set = (next: CheckResults | null) => {
  request = next
  listeners.forEach((listener) => listener())
}

/** The home check passes its latest results; elsewhere there are none. */
export const openSendDiagnostics = (results: CheckResults = { delays: {} }) =>
  set(results)

export const closeSendDiagnostics = () => set(null)

export const useSendDiagnosticsRequest = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => request,
    () => request,
  )
