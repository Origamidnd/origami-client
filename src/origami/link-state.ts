import { useSyncExternalStore } from 'react'

/**
 * What the last checks found while the VPN is on: traffic goes, the internet itself is gone, or the
 * internet is there but the VPN passes nothing.
 */
export type LinkState = 'ok' | 'noInternet' | 'down'

let state: LinkState = 'ok'
const listeners = new Set<() => void>()

export const getLinkState = () => state

export const setLinkState = (next: LinkState) => {
  if (next === state) return
  state = next
  listeners.forEach((listener) => listener())
}

export const useLinkState = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
    () => state,
  )
