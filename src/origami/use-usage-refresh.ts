import { useEffect } from 'react'

import { useProfiles } from '@/hooks/use-profiles'
import { useVisibility } from '@/hooks/use-visibility'
import { origamiRefreshUsage } from '@/services/cmds'

// Not on a timer and not on every look: a window left open all day asks nothing, and opening it
// again and again asks at most this often.
const MIN_GAP_MS = 30 * 60 * 1000
const KEY = 'origami.usageCheckedAt'

const readCheckedAt = (uid: string) => {
  try {
    return Number(localStorage.getItem(`${KEY}.${uid}`)) || 0
  } catch {
    return 0
  }
}

const writeCheckedAt = (uid: string, at: number) => {
  try {
    localStorage.setItem(`${KEY}.${uid}`, String(at))
  } catch {
    // Without storage the next look asks again, still only when the screen opens.
  }
}

/** A full subscription update (`updatedAt`, unix seconds) brings the same numbers. */
export const usageIsDue = (
  checkedAt: number,
  updatedAt: number | undefined,
  now: number,
) => now - Math.max(checkedAt, (updatedAt ?? 0) * 1000) >= MIN_GAP_MS

/**
 * Keeps the traffic numbers fresh when Home is opened or the window is shown. It asks for the numbers
 * alone: a real update would reload the core and start Auto over, cutting off whoever is playing.
 */
export const useUsageRefresh = (item: IProfileItem | undefined) => {
  const visible = useVisibility()
  const { mutateProfiles } = useProfiles()
  const uid = item?.type === 'remote' ? item.uid : undefined
  const updated = item?.updated ?? undefined

  useEffect(() => {
    if (!visible || !uid) return
    const now = Date.now()
    if (!usageIsDue(readCheckedAt(uid), updated, now)) return
    // Written first, so a failing server is not asked again on every look.
    writeCheckedAt(uid, now)
    origamiRefreshUsage(uid)
      .then(() => mutateProfiles())
      .catch(() => {
        // The numbers stay as they were until the next try.
      })
  }, [visible, uid, updated, mutateProfiles])
}
