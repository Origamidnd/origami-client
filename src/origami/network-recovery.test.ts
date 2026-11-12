import { delayProxyByName, getVersion } from 'tauri-plugin-mihomo-api'
import { beforeEach, expect, it, vi } from 'vitest'

import { setLinkState } from './link-state'
import { diagnoseLink, watchLinkBack } from './network-recovery'

vi.mock('tauri-plugin-mihomo-api', () => ({
  delayProxyByName: vi.fn(),
  getVersion: vi.fn(),
}))
vi.mock('@/services/cmds', () => ({
  origamiGetLinkState: vi.fn(async () => 'ok'),
}))
vi.mock('@/providers/app-data-context', () => ({
  useProxiesData: vi.fn(),
  useAppRefreshers: vi.fn(),
}))

const net = { internet: true }

beforeEach(() => {
  vi.useFakeTimers()
  net.internet = true
  setLinkState('ok')
  vi.mocked(getVersion).mockReset()
  vi.mocked(getVersion).mockResolvedValue({ version: 'v1' } as never)
  vi.mocked(delayProxyByName).mockReset()
  vi.mocked(delayProxyByName).mockImplementation(async (proxy) => {
    if (proxy === 'DIRECT' && net.internet) return { delay: 100 } as never
    throw new Error('Timeout')
  })
})

it('tells a silent VPN from a missing internet', async () => {
  expect(await diagnoseLink()).toBe('vpnSilent')
  net.internet = false
  expect(await diagnoseLink()).toBe('noInternet')
})

it('counts a core that does not even answer as silent', async () => {
  vi.mocked(getVersion).mockImplementation(() => new Promise(() => {}))
  const verdict = diagnoseLink()
  await vi.advanceTimersByTimeAsync(5000)
  expect(await verdict).toBe('coreSilent')
})

it('asks for fresh numbers once when the link is back', () => {
  const onBack = vi.fn()
  const stop = watchLinkBack(onBack)
  setLinkState('noInternet')
  setLinkState('down')
  expect(onBack).not.toHaveBeenCalled()
  setLinkState('ok')
  setLinkState('ok')
  expect(onBack).toHaveBeenCalledOnce()
  stop()
  setLinkState('down')
  setLinkState('ok')
  expect(onBack).toHaveBeenCalledOnce()
})
