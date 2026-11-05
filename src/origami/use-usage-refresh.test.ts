import { expect, it, vi } from 'vitest'

import { usageIsDue } from './use-usage-refresh'

vi.mock('@/hooks/use-profiles', () => ({ useProfiles: vi.fn() }))
vi.mock('@/hooks/use-visibility', () => ({ useVisibility: vi.fn() }))
vi.mock('@/services/cmds', () => ({ origamiRefreshUsage: vi.fn() }))

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0)
const MIN = 60 * 1000
const seconds = (ms: number) => Math.floor(ms / 1000)

it('asks when nothing was asked yet and the update is old', () => {
  expect(usageIsDue(0, seconds(NOW - 120 * MIN), NOW)).toBe(true)
  expect(usageIsDue(0, undefined, NOW)).toBe(true)
})

it('stays quiet for half an hour after asking', () => {
  expect(usageIsDue(NOW - 29 * MIN, seconds(NOW - 120 * MIN), NOW)).toBe(false)
  expect(usageIsDue(NOW - 31 * MIN, seconds(NOW - 120 * MIN), NOW)).toBe(true)
})

it('stays quiet right after a full update: it brought the same numbers', () => {
  expect(usageIsDue(0, seconds(NOW - 5 * MIN), NOW)).toBe(false)
})
