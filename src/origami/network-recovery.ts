import { useEffect, useRef } from 'react'
import {
  closeAllConnections,
  flushDNS,
  flushFakeIp,
} from 'tauri-plugin-mihomo-api'

import { cmdTestDelay, restartCore } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'

import { isReachable } from './check/targets'
import { useConnection } from './home/use-connection'

const TICK_MS = 15 * 1000
// A tick that comes this late means the computer was asleep.
const SLEEP_GAP_MS = 60 * 1000
// Let Wi-Fi and the adapter settle before checking.
const SETTLE_MS = 5 * 1000
const MIN_INTERVAL_MS = 30 * 1000
const PROBE_URL = 'https://www.gstatic.com/generate_204'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const probe = async () =>
  isReachable(await cmdTestDelay(PROBE_URL).catch(() => undefined))

/**
 * After a wake from sleep or a network change, DNS answers and old connections may point at the
 * previous network. While the VPN is on this drops the DNS cache, and if the link through the core
 * does not work, closes the stale connections, checks again and restarts the core once.
 */
export const recoverNetwork = async () => {
  await Promise.allSettled([flushDNS(), flushFakeIp()])
  if (await probe()) return 'ok'
  await Promise.allSettled([closeAllConnections()])
  await sleep(SETTLE_MS)
  if (await probe()) return 'ok'
  await restartCore()
  await sleep(SETTLE_MS)
  return (await probe()) ? 'restarted' : 'offline'
}

/** Mounted once, in the sidebar. */
export const useNetworkRecovery = () => {
  const { connected } = useConnection()
  const connectedRef = useRef(connected)
  connectedRef.current = connected

  useEffect(() => {
    let lastTick = Date.now()
    let lastRun = 0
    let pending: ReturnType<typeof setTimeout> | null = null
    let running = false

    const schedule = () => {
      if (pending) clearTimeout(pending)
      pending = setTimeout(() => {
        pending = null
        const now = Date.now()
        if (running || !connectedRef.current || now - lastRun < MIN_INTERVAL_MS)
          return
        lastRun = now
        running = true
        recoverNetwork()
          .then((result) => {
            if (result === 'restarted') {
              showNotice.info('origami.recovery.restarted')
            }
          })
          .catch((error) => console.warn('[recovery] failed', error))
          .finally(() => {
            running = false
          })
      }, SETTLE_MS)
    }

    const tick = setInterval(() => {
      const now = Date.now()
      if (now - lastTick > SLEEP_GAP_MS) schedule()
      lastTick = now
    }, TICK_MS)

    // Only "online" (the link came back): NetworkInformation "change" also fires on speed estimates.
    window.addEventListener('online', schedule)

    return () => {
      clearInterval(tick)
      if (pending) clearTimeout(pending)
      window.removeEventListener('online', schedule)
    }
  }, [])
}
