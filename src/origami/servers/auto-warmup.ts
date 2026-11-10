import { useEffect, useRef } from 'react'
import {
  closeConnection,
  delayGroup,
  getConnections,
} from 'tauri-plugin-mihomo-api'

import { onCoreReloaded } from '../core-reload-signal'
import { useConnection } from '../home/use-connection'

import { autoGroups, autoGroupsSettled, releaseLeftoverPins } from './auto-hold'

const TEST_TIMEOUT_MS = 5000
// Several reloads in a row count as one.
const DEBOUNCE_MS = 1500
// The core's clock and this one may differ a little.
const CLOCK_SKEW_MS = 2000

interface StaleCandidate {
  id: string
  start: string
  chains?: string[]
}

/**
 * Connections opened since `since` through an auto group by a server it no longer picks. `chains`
 * goes from the server up to the rule's group. Older connections stay: moving them would cut off
 * a running game or video for no reason.
 */
export const staleConnections = <T extends StaleCandidate>(
  connections: T[],
  picks: Map<string, string>,
  since: number,
) =>
  connections.filter((connection) => {
    if (Date.parse(connection.start) < since) return false
    const chains = connection.chains ?? []
    return chains.some(
      (name, index) =>
        index > 0 && picks.has(name) && picks.get(name) !== chains[index - 1],
    )
  })

/**
 * An auto group knows nothing about its servers after a start or reload, so until its first test it
 * uses the first one on the list, whichever that is. This tests it right away and moves whatever
 * opened in that short time to the server it really picked.
 */
export const warmAutoGroups = async (since: number) => {
  // A group test drops a pin and would put back a pin it saw, so it waits for a held group.
  await autoGroupsSettled()
  const groups = await autoGroups()
  if (groups.length === 0) return
  await Promise.allSettled(
    groups.map((group) =>
      // keepFixed: testing must not undo a server someone pinned in the group.
      delayGroup(group.name, group.testUrl as string, TEST_TIMEOUT_MS, true),
    ),
  )
  const picks = new Map(
    (await autoGroups())
      .filter((group) => group.now)
      .map((group) => [group.name, group.now as string]),
  )
  const { connections } = await getConnections()
  await Promise.allSettled(
    staleConnections(
      (connections ?? []) as unknown as StaleCandidate[],
      picks,
      since,
    ).map((connection) => closeConnection(connection.id)),
  )
}

/** Mounted once, in the sidebar: after every start and reload of the core while the VPN is on. */
export const useAutoWarmup = () => {
  const { connected } = useConnection()
  const connectedRef = useRef(connected)
  connectedRef.current = connected
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sinceRef = useRef<number | null>(null)

  const scheduleRef = useRef(() => {
    sinceRef.current ??= Date.now() - CLOCK_SKEW_MS
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      const since = sinceRef.current ?? Date.now()
      sinceRef.current = null
      timerRef.current = null
      if (!connectedRef.current) return
      warmAutoGroups(since).catch(() => {
        // The core is starting or stopped; its next start brings another try.
      })
    }, DEBOUNCE_MS)
  })

  useEffect(() => onCoreReloaded(() => scheduleRef.current()), [])

  // Connecting with a core that has been up all along: nothing has tested its groups yet.
  useEffect(() => {
    if (!connected) return
    // A pin left by a crash or a restart halfway through a hold.
    void releaseLeftoverPins()
    scheduleRef.current()
  }, [connected])

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )
}
