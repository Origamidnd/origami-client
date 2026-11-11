import { afterEach, expect, it, vi } from 'vitest'

import { setCacheData } from '@/services/query-client'
import { checkUpdateSafe } from '@/services/update'

import { checkAndRememberUpdate, checkInBackground } from './use-update'

vi.mock('@/services/query-client', () => ({
  fetchCacheData: async (key: unknown, fn: () => unknown) => {
    const data = await fn()
    setCacheData(key as never, data)
    return data
  },
  setCacheData: vi.fn(),
  useQuery: vi.fn(),
}))
vi.mock('@/services/update', () => ({ checkUpdateSafe: vi.fn() }))
vi.mock('@/origami/use-package-manager', () => ({ usePackageManager: vi.fn() }))
vi.mock('./use-verge', () => ({ useVerge: vi.fn() }))
vi.stubGlobal('localStorage', { getItem: vi.fn(), setItem: vi.fn() })

it('keeps a manually found update where the update window reads it', async () => {
  // The startup check failed (no GitHub through the VPN), so the cache holds nothing; the window
  // opened by "Проверить" must still get the version, the notes and something to install.
  const offer = { available: true, version: '0.1.13' }
  vi.mocked(checkUpdateSafe).mockResolvedValue(offer as never)

  await expect(checkAndRememberUpdate()).resolves.toBe(offer)

  expect(setCacheData).toHaveBeenCalledWith(['checkUpdate'], offer)
})

afterEach(() => {
  vi.useRealTimers()
  vi.mocked(checkUpdateSafe).mockReset()
  vi.mocked(setCacheData).mockClear()
})

it('tries a failed automatic check again after half an hour, once', async () => {
  // SWR does not poll while its cache holds an error, so the daily interval never fires after a
  // failure; the retry has to come from us, and only one for all components using the hook.
  vi.useFakeTimers()
  const offer = { available: true, version: '0.1.13' }
  vi.mocked(checkUpdateSafe)
    .mockRejectedValueOnce(new Error('github unreachable'))
    .mockRejectedValueOnce(new Error('github unreachable'))
    .mockRejectedValueOnce(new Error('github unreachable'))
    .mockResolvedValue(offer as never)

  // The first check and SWR's own two quick retries.
  for (let i = 0; i < 3; i++) {
    await expect(checkInBackground()).rejects.toThrow()
  }

  await vi.advanceTimersByTimeAsync(29 * 60 * 1000)
  expect(checkUpdateSafe).toHaveBeenCalledTimes(3)

  await vi.advanceTimersByTimeAsync(60 * 1000)
  expect(checkUpdateSafe).toHaveBeenCalledTimes(4)
  expect(setCacheData).toHaveBeenCalledWith(['checkUpdate'], offer)
})

it('keeps trying every half hour while the check fails', async () => {
  vi.useFakeTimers()
  vi.mocked(checkUpdateSafe).mockRejectedValue(new Error('github unreachable'))

  await expect(checkInBackground()).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
  await vi.advanceTimersByTimeAsync(30 * 60 * 1000)

  expect(checkUpdateSafe).toHaveBeenCalledTimes(3)
})
