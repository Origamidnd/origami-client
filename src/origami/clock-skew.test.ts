import { describe, expect, test, vi } from 'vitest'

vi.mock('@/services/cmds', () => ({
  origamiGetClockSkew: vi.fn(async () => 'behind'),
}))

import { origamiGetClockSkew } from '@/services/cmds'

import { applyClockNotice, getClockSkew, setClockSkew } from './clock-skew'

describe('clock skew state', () => {
  test('a notice sets the warning and "ok" clears it', () => {
    setClockSkew(null)
    applyClockNotice('ahead')
    expect(getClockSkew()).toBe('ahead')
    applyClockNotice('ok')
    expect(getClockSkew()).toBeNull()
  })

  test('an empty notice reads what the app kept, for a window opened later', async () => {
    setClockSkew(null)
    applyClockNotice('')
    await vi.waitFor(() => expect(getClockSkew()).toBe('behind'))
    expect(origamiGetClockSkew).toHaveBeenCalledOnce()
  })
})
