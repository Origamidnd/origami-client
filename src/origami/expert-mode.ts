import { useSyncExternalStore } from 'react'

import { syncToTray } from './tray-sync'

const STORAGE_KEY = 'origami.expertMode'

// Pages shown only in expert mode; the rest of the navigation is always visible.
export const EXPERT_PATHS = new Set([
  '/connections',
  '/rules',
  '/logs',
  '/unlock',
])

const listeners = new Set<() => void>()

const read = () => {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

// Lets styles hide expert-only bits (such as the sidebar speed graph) without touching stock components.
const mark = (value: boolean) => {
  document.documentElement.dataset.origamiExpert = value ? '1' : '0'
}

let current = read()
mark(current)
syncToTray({ origami_expert_mode: current })

export const setExpertMode = (value: boolean) => {
  current = value
  try {
    localStorage.setItem(STORAGE_KEY, value ? '1' : '0')
  } catch {
    // Storage can be unavailable; the choice then lasts for this session only.
  }
  mark(value)
  syncToTray({ origami_expert_mode: value })
  listeners.forEach((listener) => listener())
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useExpertMode = () =>
  useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  )

export const filterNavPaths = (paths: string[], expert: boolean) =>
  expert ? paths : paths.filter((path) => !EXPERT_PATHS.has(path))
