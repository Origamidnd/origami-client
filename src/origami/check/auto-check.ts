import { isReachable } from './targets'

export type Delays = (number | undefined)[]

// Right after the app starts the core is still warming up and every request fails, so the
// automatic check tries again before calling anything broken. A real block fails every time.
export const AUTO_CHECK_ATTEMPTS = 3
export const AUTO_CHECK_RETRY_MS = 3000
// While no service answers at all, the core (or its TUN) is most likely not up yet: on Windows 10
// it took ~20 s after start (23.11). Keep trying this long before showing everything as broken.
export const AUTO_CHECK_WARMUP_MS = 45_000

export interface AutoCheckClock {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

/**
 * Probes the services; the automatic check tries again while something fails. When some services
 * answer the core works, and a few tries tell a blocked service from a slow one. When none answers,
 * it keeps trying for the core's warm-up time.
 */
export const probeUntilSettled = async (
  probe: () => Promise<Delays>,
  auto: boolean,
  clock: AutoCheckClock,
): Promise<Delays> => {
  const started = clock.now()
  let results = await probe()
  for (let attempt = 1; auto; attempt++) {
    if (results.every((delay) => isReachable(delay))) break
    const noneAnswers = !results.some((delay) => isReachable(delay))
    const more = noneAnswers
      ? clock.now() - started + AUTO_CHECK_RETRY_MS < AUTO_CHECK_WARMUP_MS
      : attempt < AUTO_CHECK_ATTEMPTS
    if (!more) break
    await clock.sleep(AUTO_CHECK_RETRY_MS)
    results = await probe()
  }
  return results
}
