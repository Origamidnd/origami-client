import { useEffect, useRef } from 'react'
import {
  closeAllConnections,
  delayProxyByName,
  flushDNS,
  getVersion,
} from 'tauri-plugin-mihomo-api'

import { useAppRefreshers, useProxiesData } from '@/providers/app-data-context'
import { cmdTestDelay, origamiSetLinkState, restartCore } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'

import { isReachable } from './check/targets'
import { notifyCoreReloaded } from './core-reload-signal'
import { resolveCurrent } from './current-server'
import { useConnection } from './home/use-connection'
import { getLinkState, type LinkState, setLinkState } from './link-state'

const TICK_MS = 15 * 1000
// A tick that comes this late means the computer was asleep.
const SLEEP_GAP_MS = 60 * 1000
// Let Wi-Fi and the adapter settle before checking.
const SETTLE_MS = 5 * 1000
const MIN_INTERVAL_MS = 30 * 1000
// One check a little after start: a core left over from an install over a running app can be up
// but pass no traffic until it is restarted.
const STARTUP_CHECK_MS = 30 * 1000
// While the VPN is on the link is probed all the time; a failed probe is repeated soon, and only
// the second failure in a row changes what the app says.
const LINK_PROBE_MS = 30 * 1000
const LINK_CONFIRM_MS = 10 * 1000
const LINK_FAILS = 2
// Restarting the core recreates the network adapter, which cuts the UDP of a running game until
// the game is restarted, so it is the last resort. A silent core gets it at once. With the internet
// there and the VPN silent it waits a while and tries once: the server is most likely down, and
// restarting again and again only cuts whatever goes past the VPN. With no internet at all it would
// not help, so only a very long outage gets it, in case the core has hung in a way that looks like
// one. The pause then doubles after each attempt that fails.
const VPN_SILENT_RESTART_MS = 5 * 60 * 1000
const NO_INTERNET_RESTART_MS = 30 * 60 * 1000
const HANG_RETRY_MS = 5 * 60 * 1000
const HANG_RETRY_MAX_MS = 30 * 60 * 1000

const PROBE_URL = 'https://www.gstatic.com/generate_204'
// Google for most of the world, Yandex for a network where Google is cut.
const DIRECT_URLS = [PROBE_URL, 'https://ya.ru']
const PROBE_TIMEOUT_MS = 6000
const API_DEADLINE_MS = 4000
// The request itself may hang when the core is frozen.
const PROBE_DEADLINE_MS = PROBE_TIMEOUT_MS + 3000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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

/** Through the group most traffic takes: the rules may send the probe's own site past the VPN. */
const probe = async (group: string | undefined) =>
  group
    ? passes(group, PROBE_URL)
    : isReachable(await cmdTestDelay(PROBE_URL).catch(() => undefined))

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

export type RecoveryResult = 'ok' | 'restarted' | 'noInternet' | 'failed'

/**
 * After a wake from sleep or a network change, DNS answers and old connections may point at the
 * previous network. While the VPN is on this drops the DNS cache, and if the link through the core
 * does not work and the internet is there, closes the stale connections, checks again and restarts
 * the core once. Without internet it leaves everything alone: when the internet is back a running
 * game goes on by itself. `force` restarts the core anyway.
 */
export const recoverNetwork = async (
  group?: string,
  { force = false }: { force?: boolean } = {},
): Promise<RecoveryResult> => {
  // Only the DNS cache: fake-ip addresses do not depend on the network, are kept across restarts
  // (store-fake-ip), and a program that remembered one could no longer reach it after a flush.
  await Promise.allSettled([flushDNS()])
  if (await probe(group)) return 'ok'
  const verdict = await diagnoseLink()
  if (verdict === 'noInternet' && !force) return 'noInternet'
  if (verdict !== 'coreSilent') {
    await Promise.allSettled([closeAllConnections()])
    await sleep(SETTLE_MS)
    if (await probe(group)) return 'ok'
  }
  await restartCore()
  await sleep(SETTLE_MS)
  if (await probe(group)) return 'restarted'
  return (await diagnoseLink()) === 'noInternet' ? 'noInternet' : 'failed'
}

type Reason = 'network' | 'startup' | 'hang'

const RESTARTED_NOTICE: Record<Reason, string> = {
  network: 'origami.recovery.restarted',
  startup: 'origami.recovery.restartedStartup',
  hang: 'origami.recovery.restartedHang',
}

const RESULT_STATE: Record<RecoveryResult, LinkState> = {
  ok: 'ok',
  restarted: 'ok',
  noInternet: 'noInternet',
  failed: 'down',
}

type EventTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>

/**
 * Runs recovery after a wake from sleep, when the link comes back, and once shortly after start,
 * while the VPN is on, and keeps the link state up to date. Returns the cleanup.
 */
export const watchRecovery = (
  isConnected: () => boolean,
  target: EventTarget = window,
  getGroup: () => string | undefined = () => undefined,
  onLinkBack: () => void = () => {},
) => {
  let lastTick = Date.now()
  let lastRun = 0
  let pending: ReturnType<typeof setTimeout> | null = null
  let confirm: ReturnType<typeof setTimeout> | null = null
  let running = false
  let probing = false
  let fails = 0
  let hangRetryMs = HANG_RETRY_MS
  let nextHangRun = 0
  let noInternetSince: number | null = null
  let vpnSilentSince: number | null = null
  // One restart per stretch of a silent VPN; the link working again starts a new stretch.
  let vpnSilentRestarted = false

  const report = (state: LinkState) => {
    if (state === 'ok') {
      fails = 0
      hangRetryMs = HANG_RETRY_MS
      nextHangRun = 0
      noInternetSince = null
      vpnSilentSince = null
      vpnSilentRestarted = false
    }
    const previous = getLinkState()
    if (state === previous) return
    setLinkState(state)
    if (state === 'ok') onLinkBack()
    origamiSetLinkState(state).catch(() => {
      // The tray keeps its icon until the next change.
    })
  }

  const schedule = (reason: Reason = 'network', force = false) => {
    if (pending) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = null
      const now = Date.now()
      if (running || !isConnected() || now - lastRun < MIN_INTERVAL_MS) return
      lastRun = now
      running = true
      recoverNetwork(getGroup(), { force })
        .then((result) => {
          report(RESULT_STATE[result])
          if (result === 'restarted') {
            showNotice.info(RESTARTED_NOTICE[reason])
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
  const onOnline = () => schedule()
  target.addEventListener('online', onOnline)
  const startup = setTimeout(() => schedule('startup'), STARTUP_CHECK_MS)

  const tryHangRestart = (force = false) => {
    const now = Date.now()
    if (now < nextHangRun) return false
    nextHangRun = now + hangRetryMs
    hangRetryMs = Math.min(hangRetryMs * 2, HANG_RETRY_MAX_MS)
    schedule('hang', force)
    return true
  }

  const onFailedLink = async () => {
    const verdict = await diagnoseLink()
    const now = Date.now()
    if (verdict === 'noInternet') {
      report('noInternet')
      vpnSilentSince = null
      noInternetSince ??= now
      if (now - noInternetSince >= NO_INTERNET_RESTART_MS) tryHangRestart(true)
      return
    }
    report('down')
    noInternetSince = null
    if (verdict === 'coreSilent') {
      tryHangRestart()
      return
    }
    // Counted from here, so the VPN gets its time to come back after the internet does.
    vpnSilentSince ??= now
    if (!vpnSilentRestarted && now - vpnSilentSince >= VPN_SILENT_RESTART_MS) {
      vpnSilentRestarted = tryHangRestart()
    }
  }

  const checkLink = async () => {
    if (!isConnected()) {
      report('ok')
      return
    }
    if (running || probing) return
    probing = true
    try {
      if (await probe(getGroup())) {
        report('ok')
        return
      }
      if (++fails < LINK_FAILS) {
        confirm = setTimeout(() => void checkLink(), LINK_CONFIRM_MS)
        return
      }
      await onFailedLink()
    } finally {
      probing = false
    }
  }

  const linkProbe = setInterval(() => void checkLink(), LINK_PROBE_MS)

  return () => {
    clearInterval(tick)
    clearInterval(linkProbe)
    clearTimeout(startup)
    if (pending) clearTimeout(pending)
    if (confirm) clearTimeout(confirm)
    target.removeEventListener('online', onOnline)
  }
}

/** Mounted once, in the sidebar. */
export const useNetworkRecovery = () => {
  const { connected } = useConnection()
  const { proxyView } = useProxiesData()
  const { refreshProxy } = useAppRefreshers()
  const connectedRef = useRef(connected)
  connectedRef.current = connected
  const current = proxyView ? resolveCurrent(proxyView) : null
  const groupRef = useRef<string | undefined>(undefined)
  groupRef.current = current?.group.name
  const serverRef = useRef<string | undefined>(undefined)
  serverRef.current = current?.name
  const refreshRef = useRef(refreshProxy)
  refreshRef.current = refreshProxy

  useEffect(
    () =>
      watchRecovery(
        () => connectedRef.current,
        window,
        () => groupRef.current,
        () => {
          // During the outage every test failed: Auto is back on its first server, and the home
          // screen still says the current one does not answer.
          notifyCoreReloaded()
          const server = serverRef.current
          if (server) {
            void passes(server, PROBE_URL).finally(() => refreshRef.current())
          }
        },
      ),
    [],
  )
}
