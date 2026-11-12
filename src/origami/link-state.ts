import { useSyncExternalStore } from 'react'

import type { LinkState } from '@/services/bindings'
import { origamiGetLinkState } from '@/services/cmds'

export type { LinkState }

/**
 * What the background link watch (Rust) found while the VPN is on: traffic goes, the internet
 * itself is gone, or the internet is there but the VPN passes nothing. The window only shows it.
 */
let state: LinkState = 'ok'
const listeners = new Set<(next: LinkState, previous: LinkState) => void>()

export const getLinkState = () => state

export const setLinkState = (next: LinkState) => {
  if (next === state) return
  const previous = state
  state = next
  listeners.forEach((listener) => listener(next, previous))
}

/** For a window opened after the last change: the event about it went nowhere. */
export const readLinkState = () =>
  origamiGetLinkState()
    .then(setLinkState)
    .catch(() => {
      // Keeps what it had; the next change arrives as an event.
    })

export const onLinkStateChange = (
  listener: (next: LinkState, previous: LinkState) => void,
) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useLinkState = () =>
  useSyncExternalStore(
    onLinkStateChange,
    () => state,
    () => state,
  )
