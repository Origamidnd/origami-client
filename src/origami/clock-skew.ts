import { useSyncExternalStore } from 'react'

import type { ClockSkew } from '@/services/bindings'
import { origamiGetClockSkew } from '@/services/cmds'

export type { ClockSkew }

/**
 * Which way the computer's clock is off, by the last subscription answer (Rust keeps it). With a
 * wrong clock TLS, DoH and Reality fail and the VPN looks dead, so the home screen says so.
 */
let state: ClockSkew | null = null
const listeners = new Set<() => void>()

export const getClockSkew = () => state

export const setClockSkew = (next: ClockSkew | null) => {
  if (next === state) return
  state = next
  listeners.forEach((listener) => listener())
}

/** For a window opened after the check: the app often starts in the tray. */
const readClockSkew = () =>
  origamiGetClockSkew()
    .then(setClockSkew)
    .catch(() => {
      // Keeps what it had; the next change arrives as a notice.
    })

/** The notice payload: "ahead", "behind" or "ok"; an empty one asks to read the state. */
export const applyClockNotice = (payload: string) => {
  if (payload === 'ahead' || payload === 'behind') setClockSkew(payload)
  else if (payload === 'ok') setClockSkew(null)
  else void readClockSkew()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useClockSkew = () =>
  useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  )
