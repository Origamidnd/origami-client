import { useEffect, useRef, useSyncExternalStore } from 'react'
import { getConnections } from 'tauri-plugin-mihomo-api'

import { useProxiesData } from '@/providers/app-data-context'
import type { ProxyViewV1 } from '@/types/proxy-view'

import { useConnection } from '../home/use-connection'

import { addSnapshot, emptyTraffic } from './program-traffic'

// A plain request, not the connections stream: the totals are kept all the time, so they should
// cost next to nothing. A connection that opens and closes between two polls is not counted.
const BACKGROUND_POLL_MS = 5 * 1000
const PAGE_POLL_MS = 1500

let state = emptyTraffic()
const listeners = new Set<() => void>()

const directNodes = (view: ProxyViewV1 | null | undefined) =>
  new Set(
    Object.values(view?.records ?? {})
      .filter((record) => record.type === 'Direct')
      .map((record) => record.name),
  )

const poll = async (view: ProxyViewV1 | null | undefined) => {
  const { connections } = await getConnections()
  const direct = directNodes(view)
  state = addSnapshot(
    state,
    (connections ?? []) as unknown as IConnectionsItem[],
    (node) => node === 'DIRECT' || direct.has(node),
  )
  listeners.forEach((listener) => listener())
}

/** The programs seen so far, for what runs beside the page. */
export const seenPrograms = () => [...state.programs.values()]

const usePolling = (intervalMs: number, enabled: boolean) => {
  const { proxyView } = useProxiesData()
  const viewRef = useRef(proxyView)
  viewRef.current = proxyView

  useEffect(() => {
    if (!enabled) return
    const run = () => {
      poll(viewRef.current).catch(() => {
        // The core is restarting or stopped; the next poll tries again.
      })
    }
    run()
    const timer = setInterval(run, intervalMs)
    return () => clearInterval(timer)
  }, [enabled, intervalMs])
}

/** Mounted once, in the sidebar: keeps the totals while the VPN is on. */
export const useProgramTrafficWatch = () => {
  const { connected } = useConnection()
  usePolling(BACKGROUND_POLL_MS, connected)
}

/** The totals for the Programs page, refreshed more often while it is open. */
export const useProgramTraffic = () => {
  usePolling(PAGE_POLL_MS, true)
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
    () => state,
  )
}
