import { useEffect, useRef } from 'react'
import { delayProxyByName, getVersion } from 'tauri-plugin-mihomo-api'

import { useAppRefreshers, useProxiesData } from '@/providers/app-data-context'

import { notifyCoreReloaded } from './core-reload-signal'
import { resolveCurrent } from './current-server'
import { onLinkStateChange } from './link-state'

// The watch itself (probes, wake from sleep, network changes, core restarts, the tray's red dot)
// runs in Rust: src-tauri/src/core/link_watch.rs. What is left here serves the window.

const PROBE_URL = 'https://www.gstatic.com/generate_204'
// Google for most of the world, Yandex for a network where Google is cut.
const DIRECT_URLS = [PROBE_URL, 'https://ya.ru']
const PROBE_TIMEOUT_MS = 6000
const API_DEADLINE_MS = 4000
// The request itself may hang when the core is frozen.
const PROBE_DEADLINE_MS = PROBE_TIMEOUT_MS + 3000

const withDeadline = <T>(work: Promise<T>, ms: number) => {
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('deadline')), ms)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

const passes = async (proxy: string, url: string) => {
  try {
    const { delay } = await withDeadline(
      delayProxyByName(proxy, url, PROBE_TIMEOUT_MS),
      PROBE_DEADLINE_MS,
    )
    return delay > 0
  } catch {
    return false
  }
}

export type LinkVerdict = 'coreSilent' | 'noInternet' | 'vpnSilent'

/** Why a probe failed: the core does not answer, nothing goes even directly, or only the VPN fails. */
export const diagnoseLink = async (): Promise<LinkVerdict> => {
  try {
    await withDeadline(getVersion(), API_DEADLINE_MS)
  } catch {
    return 'coreSilent'
  }
  const direct = await Promise.all(
    DIRECT_URLS.map((url) => passes('DIRECT', url)),
  )
  return direct.some(Boolean) ? 'vpnSilent' : 'noInternet'
}

/** Calls `onBack` each time the link works again after a failure. Returns the cleanup. */
export const watchLinkBack = (onBack: () => void) =>
  onLinkStateChange((next, previous) => {
    if (next === 'ok' && previous !== 'ok') onBack()
  })

/** Mounted once, in the sidebar: fresh numbers on the home screen once the link is back. */
export const useLinkBackRefresh = () => {
  const { proxyView } = useProxiesData()
  const { refreshProxy } = useAppRefreshers()
  const serverRef = useRef<string | undefined>(undefined)
  serverRef.current = proxyView ? resolveCurrent(proxyView)?.name : undefined
  const refreshRef = useRef(refreshProxy)
  refreshRef.current = refreshProxy

  useEffect(
    () =>
      watchLinkBack(() => {
        // During the outage every test failed: Auto is back on its first server, and the home
        // screen still says the current one does not answer.
        notifyCoreReloaded()
        const server = serverRef.current
        if (server) {
          void passes(server, PROBE_URL).finally(() => refreshRef.current())
        }
      }),
    [],
  )
}
