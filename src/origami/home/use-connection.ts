import { useSyncExternalStore } from 'react'

import { useSystemProxyState } from '@/hooks/use-system-proxy-state'
import { useSystemState } from '@/hooks/use-system-state'
import { useVerge } from '@/hooks/use-verge'
import { requestService } from '@/services/service-request'

export type ConnectMode = 'proxy' | 'tun'

const MODE_KEY = 'origami.connectMode'
const listeners = new Set<() => void>()

const readMode = (): ConnectMode => {
  try {
    return localStorage.getItem(MODE_KEY) === 'tun' ? 'tun' : 'proxy'
  } catch {
    return 'proxy'
  }
}

let preferredMode = readMode()

const setPreferredMode = (mode: ConnectMode) => {
  preferredMode = mode
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {
    // Without storage the choice lasts for this session only.
  }
  listeners.forEach((listener) => listener())
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** One connect button over the two stock switches: system proxy and TUN. */
export const useConnection = () => {
  const { verge, patchVerge } = useVerge()
  const { indicator: proxyOn, toggleSystemProxy } = useSystemProxyState()
  const { isTunModeAvailable, isLoading } = useSystemState()
  const mode = useSyncExternalStore(
    subscribe,
    () => preferredMode,
    () => preferredMode,
  )

  const tunOn = !!verge?.enable_tun_mode && isTunModeAvailable
  const connected = proxyOn || tunOn
  const activeMode: ConnectMode | null = tunOn
    ? 'tun'
    : proxyOn
      ? 'proxy'
      : null

  const enable = async (target: ConnectMode) => {
    if (target === 'tun') {
      if (!isTunModeAvailable) {
        requestService({
          reason: 'tunNeedsService',
          restore: { enable_tun_mode: true },
        })
        return
      }
      await patchVerge({ enable_tun_mode: true })
    } else {
      await toggleSystemProxy(true)
    }
  }

  const disconnect = async () => {
    if (tunOn) await patchVerge({ enable_tun_mode: false })
    if (proxyOn || verge?.enable_system_proxy) await toggleSystemProxy(false)
  }

  const connect = () => enable(mode)

  const changeMode = async (next: ConnectMode) => {
    if (next === mode) return
    setPreferredMode(next)
    if (!connected) return
    await disconnect()
    await enable(next)
  }

  return {
    mode,
    activeMode,
    connected,
    isLoading,
    tunNeedsService: !isTunModeAvailable,
    connect,
    disconnect,
    changeMode,
  }
}
