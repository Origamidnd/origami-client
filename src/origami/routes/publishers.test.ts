import { beforeEach, expect, it, vi } from 'vitest'

import { origamiProgramPublishers } from '@/services/cmds'

vi.mock('@/services/cmds', () => ({ origamiProgramPublishers: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.mocked(origamiProgramPublishers).mockReset()
})

const paths = (count: number) =>
  Array.from({ length: count }, (_, i) => `C:\\Games\\game${i}.exe`)

it('asks for every path, also beyond the 64 the backend reads at once', async () => {
  // The backend drops paths past its limit; they must not be taken for unsigned.
  vi.mocked(origamiProgramPublishers).mockImplementation(async (list) =>
    Object.fromEntries(list.slice(0, 64).map((path) => [path, 'Valve'])),
  )
  const { learnPublishers, publisherOf } = await import('./publishers')
  await learnPublishers(paths(100))
  expect(publisherOf('C:\\Games\\game99.exe')).toBe('Valve')
})

it('does not remember a failed lookup as "no publisher" for good', async () => {
  vi.mocked(origamiProgramPublishers).mockRejectedValueOnce(new Error('spawn'))
  const { learnPublishers, publisherOf } = await import('./publishers')
  await learnPublishers(['C:\\Games\\game.exe'])
  expect(publisherOf('C:\\Games\\game.exe')).toBeNull()
  vi.mocked(origamiProgramPublishers).mockResolvedValue({
    'C:\\Games\\game.exe': 'Valve',
  })
  vi.advanceTimersByTime(10 * 60 * 1000)
  await learnPublishers(['C:\\Games\\game.exe'])
  expect(publisherOf('C:\\Games\\game.exe')).toBe('Valve')
})
