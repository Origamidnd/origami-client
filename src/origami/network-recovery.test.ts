import {
  closeAllConnections,
  delayProxyByName,
  getVersion,
} from 'tauri-plugin-mihomo-api'
import { beforeEach, expect, it, vi } from 'vitest'

import { origamiSetLinkState, restartCore } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'

import { getLinkState, setLinkState } from './link-state'
import { recoverNetwork, watchRecovery } from './network-recovery'

vi.mock('tauri-plugin-mihomo-api', () => ({
  closeAllConnections: vi.fn(async () => {}),
  delayProxyByName: vi.fn(),
  flushDNS: vi.fn(async () => {}),
  flushFakeIp: vi.fn(async () => {}),
  getVersion: vi.fn(async () => ({ version: 'v1' })),
}))
vi.mock('@/services/cmds', () => ({
  cmdTestDelay: vi.fn(async () => 100),
  origamiSetLinkState: vi.fn(async () => null),
  restartCore: vi.fn(async () => {}),
}))
vi.mock('@/services/notice-service', () => ({ showNotice: { info: vi.fn() } }))
vi.mock('@/providers/app-data-context', () => ({ useProxiesData: vi.fn() }))
vi.mock('./home/use-connection', () => ({ useConnection: vi.fn() }))

const GROUP = 'Blocked'

// What answers right now: the VPN through the group, the internet through DIRECT, and the core.
const net = { vpn: true, internet: true }

beforeEach(() => {
  vi.useFakeTimers()
  net.vpn = true
  net.internet = true
  setLinkState('ok')
  vi.mocked(getVersion).mockReset()
  vi.mocked(getVersion).mockResolvedValue({ version: 'v1' } as never)
  vi.mocked(delayProxyByName).mockReset()
  vi.mocked(delayProxyByName).mockImplementation(async (proxy) => {
    if (proxy === 'DIRECT' ? net.internet : net.vpn && net.internet) {
      return { delay: 100 } as never
    }
    throw new Error('Timeout')
  })
  vi.mocked(restartCore).mockReset()
  vi.mocked(restartCore).mockResolvedValue(null as never)
  vi.mocked(closeAllConnections).mockClear()
  vi.mocked(origamiSetLinkState).mockClear()
  vi.mocked(showNotice.info).mockClear()
})

const run = async (force = false) => {
  const result = recoverNetwork(GROUP, { force })
  await vi.runAllTimersAsync()
  return result
}

const fixedByRestart = () =>
  vi.mocked(restartCore).mockImplementation(async () => {
    net.vpn = true
    return null as never
  })

const watch = () =>
  watchRecovery(
    () => true,
    { addEventListener: vi.fn(), removeEventListener: vi.fn() } as never,
    () => GROUP,
  )

const MIN = 60 * 1000

it('only drops the DNS cache when the link works', async () => {
  expect(await run()).toBe('ok')
  expect(closeAllConnections).not.toHaveBeenCalled()
  expect(restartCore).not.toHaveBeenCalled()
})

it('restarts the core when the internet is there and the VPN still passes nothing', async () => {
  net.vpn = false
  fixedByRestart()
  expect(await run()).toBe('restarted')
  expect(closeAllConnections).toHaveBeenCalledOnce()
  expect(restartCore).toHaveBeenCalledOnce()
})

it('reports a failure when even the restart does not help', async () => {
  net.vpn = false
  expect(await run()).toBe('failed')
})

it('touches nothing without internet: a running game must survive the outage', async () => {
  net.internet = false
  expect(await run()).toBe('noInternet')
  expect(closeAllConnections).not.toHaveBeenCalled()
  expect(restartCore).not.toHaveBeenCalled()
})

it('restarts a silent core without closing anything first', async () => {
  vi.mocked(getVersion).mockRejectedValue(new Error('pipe'))
  net.vpn = false
  fixedByRestart()
  expect(await run()).toBe('restarted')
  expect(closeAllConnections).not.toHaveBeenCalled()
})

it('counts a core that does not even answer as silent', async () => {
  vi.mocked(getVersion).mockImplementation(() => new Promise(() => {}))
  net.vpn = false
  fixedByRestart()
  expect(await run()).toBe('restarted')
})

it('still restarts without internet when forced', async () => {
  net.internet = false
  expect(await run(true)).toBe('noInternet')
  expect(restartCore).toHaveBeenCalledOnce()
})

it('checks once about half a minute after start and restarts a silent VPN', async () => {
  const stop = watch()
  net.vpn = false
  fixedByRestart()
  await vi.advanceTimersByTimeAsync(20 * 1000)
  expect(delayProxyByName).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(40 * 1000)
  expect(restartCore).toHaveBeenCalledOnce()
  expect(showNotice.info).toHaveBeenCalledWith(
    'origami.recovery.restartedStartup',
  )
  stop()
})

it('skips the checks while the VPN is off', async () => {
  const stop = watchRecovery(
    () => false,
    { addEventListener: vi.fn(), removeEventListener: vi.fn() } as never,
    () => GROUP,
  )
  await vi.advanceTimersByTimeAsync(MIN)
  expect(delayProxyByName).not.toHaveBeenCalled()
  stop()
})

it('says there is no internet within a minute and clears it when the internet returns', async () => {
  const stop = watch()
  await vi.advanceTimersByTimeAsync(40 * 1000)
  net.internet = false
  await vi.advanceTimersByTimeAsync(40 * 1000)
  expect(getLinkState()).toBe('noInternet')
  expect(origamiSetLinkState).toHaveBeenLastCalledWith('noInternet')
  net.internet = true
  await vi.advanceTimersByTimeAsync(40 * 1000)
  expect(getLinkState()).toBe('ok')
  expect(origamiSetLinkState).toHaveBeenLastCalledWith('ok')
  stop()
})

it('asks for fresh numbers once when the internet returns', async () => {
  const onLinkBack = vi.fn()
  const stop = watchRecovery(
    () => true,
    { addEventListener: vi.fn(), removeEventListener: vi.fn() } as never,
    () => GROUP,
    onLinkBack,
  )
  await vi.advanceTimersByTimeAsync(40 * 1000)
  expect(onLinkBack).not.toHaveBeenCalled()
  net.internet = false
  await vi.advanceTimersByTimeAsync(40 * 1000)
  net.internet = true
  await vi.advanceTimersByTimeAsync(2 * MIN)
  expect(onLinkBack).toHaveBeenCalledOnce()
  stop()
})

it('does not restart the core during an outage of 20 minutes', async () => {
  const stop = watch()
  await vi.advanceTimersByTimeAsync(40 * 1000)
  net.internet = false
  await vi.advanceTimersByTimeAsync(20 * MIN)
  expect(restartCore).not.toHaveBeenCalled()
  expect(closeAllConnections).not.toHaveBeenCalled()
  stop()
})

it('tries a restart only after a very long outage', async () => {
  const stop = watch()
  await vi.advanceTimersByTimeAsync(40 * 1000)
  net.internet = false
  await vi.advanceTimersByTimeAsync(32 * MIN)
  expect(restartCore).toHaveBeenCalledOnce()
  stop()
})

it('gives the VPN time after the internet is back before restarting', async () => {
  const stop = watch()
  await vi.advanceTimersByTimeAsync(40 * 1000)
  net.internet = false
  await vi.advanceTimersByTimeAsync(5 * MIN)
  net.internet = true
  net.vpn = false
  await vi.advanceTimersByTimeAsync(2 * MIN)
  expect(getLinkState()).toBe('down')
  expect(restartCore).not.toHaveBeenCalled()
  fixedByRestart()
  await vi.advanceTimersByTimeAsync(5 * MIN)
  expect(restartCore).toHaveBeenCalledOnce()
  expect(showNotice.info).toHaveBeenCalledWith('origami.recovery.restartedHang')
  expect(getLinkState()).toBe('ok')
  stop()
})

it('restarts a frozen core within a minute and says so', async () => {
  const stop = watch()
  await vi.advanceTimersByTimeAsync(40 * 1000)
  vi.mocked(getVersion).mockImplementation(() => new Promise(() => {}))
  net.vpn = false
  vi.mocked(restartCore).mockImplementation(async () => {
    vi.mocked(getVersion).mockResolvedValue({ version: 'v1' } as never)
    net.vpn = true
    return null as never
  })
  await vi.advanceTimersByTimeAsync(MIN)
  expect(restartCore).toHaveBeenCalledOnce()
  expect(showNotice.info).toHaveBeenCalledWith('origami.recovery.restartedHang')
  stop()
})

it('waits longer and longer between restarts while nothing helps', async () => {
  const stop = watch()
  await vi.advanceTimersByTimeAsync(40 * 1000)
  net.vpn = false
  // 25 minutes: attempts about 5, 10 and 20 minutes in, not one every few minutes.
  await vi.advanceTimersByTimeAsync(25 * MIN)
  expect(vi.mocked(restartCore).mock.calls.length).toBe(3)
  stop()
})
