import { describe, expect, it } from 'vitest'

import {
  AUTO_CHECK_ATTEMPTS,
  type AutoCheckClock,
  type Delays,
  probeUntilSettled,
} from './auto-check'
import { FAILED_DELAY } from './targets'

const fakeClock = (): AutoCheckClock & { elapsed: () => number } => {
  let time = 0
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms
    },
    elapsed: () => time,
  }
}

const ALL_FAIL: Delays = [FAILED_DELAY, undefined, FAILED_DELAY, FAILED_DELAY]
const ALL_OK: Delays = [120, 90, 150, 200]

describe('probeUntilSettled', () => {
  it('waits for a core that needs 20 s to warm up instead of calling everything broken', async () => {
    // Windows 10, 23.11: the core answered only ~20 s after start; three tries over ~6 s all
    // failed and the home screen said Telegram, YouTube and Instagram do not open, for good.
    const clock = fakeClock()
    const probe = async () => (clock.now() < 20_000 ? ALL_FAIL : ALL_OK)
    expect(await probeUntilSettled(probe, true, clock)).toEqual(ALL_OK)
  })

  it('gives up on a link where nothing answers, so the card is not stuck checking', async () => {
    const clock = fakeClock()
    let probes = 0
    const probe = async () => {
      probes += 1
      return ALL_FAIL
    }
    expect(await probeUntilSettled(probe, true, clock)).toEqual(ALL_FAIL)
    expect(clock.elapsed()).toBeLessThanOrEqual(60_000)
    expect(probes).toBeGreaterThan(AUTO_CHECK_ATTEMPTS)
  })

  it('does not wait long when the core works and one service is blocked', async () => {
    // Some answers mean the core is up: a service that fails is really blocked on this server.
    const clock = fakeClock()
    const blocked: Delays = [120, 90, FAILED_DELAY, 200]
    let probes = 0
    const probe = async () => {
      probes += 1
      return blocked
    }
    expect(await probeUntilSettled(probe, true, clock)).toEqual(blocked)
    expect(probes).toBe(AUTO_CHECK_ATTEMPTS)
  })

  it('checks once when the person pressed the button', async () => {
    const clock = fakeClock()
    let probes = 0
    const probe = async () => {
      probes += 1
      return ALL_FAIL
    }
    await probeUntilSettled(probe, false, clock)
    expect(probes).toBe(1)
    expect(clock.elapsed()).toBe(0)
  })
})
