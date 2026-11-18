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

  test('a read that started before a notice does not undo it', async () => {
    setClockSkew(null)
    let finish: (value: null) => void = () => {}
    vi.mocked(origamiGetClockSkew).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)) as never,
    )
    applyClockNotice('')
    applyClockNotice('behind')
    finish(null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(getClockSkew()).toBe('behind')
  })
})
