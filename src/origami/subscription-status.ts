const DAY_MS = 24 * 60 * 60 * 1000

export type ExpiryStage = 'soon' | 'lastDay' | 'expired'

/** Whole days left until `expire` (unix seconds), never below zero. */
export const daysLeft = (expire: number, now: number) =>
  Math.max(0, Math.ceil((expire * 1000 - now) / DAY_MS))

/** Reminder stage: 3 days or less, the last day, or already over. */
export const expiryStage = (
  expire: number | undefined,
  now: number,
): ExpiryStage | null => {
  if (!expire) return null
  if (expire * 1000 <= now) return 'expired'
  const days = daysLeft(expire, now)
  if (days <= 1) return 'lastDay'
  if (days <= 3) return 'soon'
  return null
}

/** One reminder per stage for each paid period; renewing changes `expire` and resets it. */
export const reminderKey = (uid: string, expire: number, stage: ExpiryStage) =>
  `${uid}:${expire}:${stage}`
