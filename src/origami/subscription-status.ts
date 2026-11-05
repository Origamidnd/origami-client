const DAY_MS = 24 * 60 * 60 * 1000

export type ExpiryStage = 'soon' | 'lastDay' | 'expired'

const msLeft = (expire: number, now: number) => expire * 1000 - now

/**
 * Whole days left until `expire` (unix seconds), never below zero. Counted down, like the panel does
 * in the announce line on the same screen, so the two never differ; 0 means less than a day.
 */
export const daysLeft = (expire: number, now: number) =>
  Math.max(0, Math.floor(msLeft(expire, now) / DAY_MS))

/** Reminder stage: 3 days or less, the last day, or already over. */
export const expiryStage = (
  expire: number | undefined,
  now: number,
): ExpiryStage | null => {
  if (!expire) return null
  const left = msLeft(expire, now)
  if (left <= 0) return 'expired'
  if (left <= DAY_MS) return 'lastDay'
  if (left <= 3 * DAY_MS) return 'soon'
  return null
}

export const RENEW_DAYS = 7

/** «Продлить» shows only near the end: a year-long or endless subscription does not need it. */
export const needsRenew = (expire: number | undefined, now: number) =>
  !!expire && msLeft(expire, now) <= RENEW_DAYS * DAY_MS

/** One reminder per stage for each paid period; renewing changes `expire` and resets it. */
export const reminderKey = (uid: string, expire: number, stage: ExpiryStage) =>
  `${uid}:${expire}:${stage}`
