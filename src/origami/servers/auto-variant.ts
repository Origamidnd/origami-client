import { useEffect, useRef, useSyncExternalStore } from 'react'

import { useProxySelection } from '@/hooks/use-proxy-selection'
import { useVerge } from '@/hooks/use-verge'
import { useAppRefreshers, useProxiesData } from '@/providers/app-data-context'
import delayManager from '@/services/delay'
import { showNotice } from '@/services/notice-service'
import type { ProxyGroupView } from '@/types/proxy-view'
import { DEFAULT_DELAY_TIMEOUT } from '@/utils/delay'

import {
  groupCountries,
  PLAIN_VARIANT,
  serviceTitle,
  variantToSwitch,
  type CountryOption,
  type ServerOption,
} from './model'
import {
  buildServices,
  CHECK_KEY,
  memberName,
  serverOptions,
  type Service,
} from './services'

// Countries where the user picked a variant by hand; automatic switching leaves them alone.
const STORAGE_KEY = 'origami.variantPinned'
const WATCH_EVERY_MS = 10 * 60 * 1000
const FIRST_WATCH_MS = 60 * 1000

const listeners = new Set<() => void>()

const read = (): ReadonlySet<string> => {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return new Set(Array.isArray(value) ? value : [])
  } catch {
    return new Set()
  }
}

let pinned = read()

export const setVariantPinned = (country: string, value: boolean) => {
  if (pinned.has(country) === value) return
  const next = new Set(pinned)
  if (value) next.add(country)
  else next.delete(country)
  pinned = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]))
  } catch {
    // Without storage the choice lasts for this session only.
  }
  listeners.forEach((listener) => listener())
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const usePinnedVariants = () =>
  useSyncExternalStore(
    subscribe,
    () => pinned,
    () => pinned,
  )

export interface VariantSwitch {
  group: ProxyGroupView
  country: CountryOption
  to: ServerOption
}

/** The country now chosen in a service, when it has several variants. */
export const chosenCountry = (service: Service) => {
  const now = service.group.now
  if (!now) return undefined
  return groupCountries(serverOptions(service)).find(
    (country) =>
      country.variants.length > 1 &&
      country.variants.some((option) => option.name === now),
  )
}

/** Moves to make in every service whose country still switches automatically. */
export const pendingSwitches = (services: Service[]): VariantSwitch[] =>
  services.flatMap((service) => {
    const country = chosenCountry(service)
    if (!country || pinned.has(country.base) || !service.group.now) return []
    const to = variantToSwitch(country, service.group.now)
    return to ? [{ group: service.group, country, to }] : []
  })

export const switchLabel = (move: VariantSwitch) =>
  move.to.variant === PLAIN_VARIANT
    ? move.country.base
    : `${move.country.base}, ${move.to.variant}`

/** Applies the moves through the given selector and tells the user once per move. */
export const useApplySwitches = () => {
  const { refreshProxy } = useAppRefreshers()
  const { handleProxyGroupChange } = useProxySelection({
    onSuccess: () => void refreshProxy(),
    onError: () => void refreshProxy(),
  })
  return (moves: VariantSwitch[]) => {
    for (const move of moves) {
      handleProxyGroupChange(move.group, { name: move.to.name })
      showNotice.info('origami.servers.autoVariantSwitched', {
        service: serviceTitle(move.group.name).title,
        server: switchLabel(move),
      })
    }
  }
}

/**
 * Background check for the countries people actually use: every few minutes it pings only
 * their variants and moves to a clearly better one. Mounted once, in the sidebar.
 */
export const useAutoVariantWatch = () => {
  const { proxyView } = useProxiesData()
  const { refreshProxy } = useAppRefreshers()
  const { verge } = useVerge()
  const apply = useApplySwitches()
  const latestRef = useRef({ proxyView, apply, refreshProxy, verge })
  latestRef.current = { proxyView, apply, refreshProxy, verge }

  useEffect(() => {
    let stopped = false
    const run = async () => {
      const { proxyView: view, verge: settings } = latestRef.current
      if (!view) return
      const services = buildServices(view)
      const seen = new Set<string>()
      const members = services.flatMap((service) => {
        const country = chosenCountry(service)
        if (!country || pinned.has(country.base)) return []
        const names = new Set(country.variants.map((option) => option.name))
        return service.servers.filter((member) => {
          const name = memberName(member)
          if (!names.has(name) || seen.has(name)) return false
          seen.add(name)
          return true
        })
      })
      if (members.length === 0) return
      await delayManager.checkListDelay(
        members,
        CHECK_KEY,
        settings?.default_latency_timeout || DEFAULT_DELAY_TIMEOUT,
      )
      if (stopped) return
      await latestRef.current.refreshProxy()
      const fresh = latestRef.current.proxyView ?? view
      latestRef.current.apply(pendingSwitches(buildServices(fresh)))
    }
    const first = setTimeout(() => void run(), FIRST_WATCH_MS)
    const every = setInterval(() => void run(), WATCH_EVERY_MS)
    return () => {
      stopped = true
      clearTimeout(first)
      clearInterval(every)
    }
  }, [])
}
