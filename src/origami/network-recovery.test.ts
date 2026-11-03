import { closeAllConnections } from 'tauri-plugin-mihomo-api'
import { beforeEach, expect, it, vi } from 'vitest'

import { cmdTestDelay, restartCore } from '@/services/cmds'

import { recoverNetwork } from './network-recovery'

vi.mock('tauri-plugin-mihomo-api', () => ({
  closeAllConnections: vi.fn(async () => {}),
  flushDNS: vi.fn(async () => {}),
  flushFakeIp: vi.fn(async () => {}),
}))
vi.mock('@/services/cmds', () => ({
  cmdTestDelay: vi.fn(),
  restartCore: vi.fn(async () => {}),
}))
vi.mock('@/services/notice-service', () => ({ showNotice: { info: vi.fn() } }))
vi.mock('./home/use-connection', () => ({ useConnection: vi.fn() }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(cmdTestDelay).mockReset()
  vi.mocked(restartCore).mockClear()
  vi.mocked(closeAllConnections).mockClear()
})

const run = async () => {
  const result = recoverNetwork()
  await vi.runAllTimersAsync()
  return result
}

it('only drops the DNS cache when the link works', async () => {
  vi.mocked(cmdTestDelay).mockResolvedValue(120)
  expect(await run()).toBe('ok')
  expect(closeAllConnections).not.toHaveBeenCalled()
  expect(restartCore).not.toHaveBeenCalled()
})

it('restarts the core when traffic still does not go through', async () => {
  vi.mocked(cmdTestDelay)
    .mockResolvedValueOnce(10000)
    .mockResolvedValueOnce(10000)
    .mockResolvedValueOnce(90)
  expect(await run()).toBe('restarted')
  expect(restartCore).toHaveBeenCalledOnce()
})

it('reports offline when even the restart does not help', async () => {
  vi.mocked(cmdTestDelay).mockResolvedValue(10000)
  expect(await run()).toBe('offline')
})
