import { useSyncExternalStore } from 'react'

let supportUrl: string | null = null
const listeners = new Set<() => void>()

const set = (url: string | null) => {
  supportUrl = url
  listeners.forEach((listener) => listener())
}

/** Says the report is on the clipboard before anything opens over the app. */
export const showDiagnosticsCopied = (url: string) => set(url)

export const closeDiagnosticsCopied = () => set(null)

export const useDiagnosticsCopied = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => supportUrl,
    () => supportUrl,
  )
