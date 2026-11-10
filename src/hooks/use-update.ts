import { useState } from 'react'

import { usePackageManager } from '@/origami/use-package-manager'
import { fetchCacheData, setCacheData, useQuery } from '@/services/query-client'
import { checkUpdateSafe } from '@/services/update'

import { useVerge } from './use-verge'

const LAST_CHECK_KEY = 'last_check_update'

export const readLastCheckTime = (): number | null => {
  const stored = localStorage.getItem(LAST_CHECK_KEY)
  if (!stored) return null
  const ts = parseInt(stored, 10)
  return isNaN(ts) ? null : ts
}

export const updateLastCheckTime = (timestamp?: number): number => {
  const now = timestamp ?? Date.now()
  localStorage.setItem(LAST_CHECK_KEY, now.toString())
  setCacheData([LAST_CHECK_KEY], now)
  return now
}

const UPDATE_QUERY_KEY = ['checkUpdate']
const DAY_MS = 24 * 60 * 60 * 1000
// GitHub can be unreachable for a while (no route through the current server, a slow network at
// start); a day is too long to wait for the next try.
const RETRY_AFTER_FAILURE_MS = 30 * 60 * 1000

const fetchUpdate = async () => {
  const result = await checkUpdateSafe()
  updateLastCheckTime()
  return result
}

/**
 * OrigamiVPN: a check started by a person. The result goes into the same cache the update window
 * and the sidebar read, so a found update is shown even when the automatic check failed.
 */
export const checkAndRememberUpdate = () =>
  fetchCacheData(UPDATE_QUERY_KEY, fetchUpdate)

/** OrigamiVPN: how long until the next automatic check. */
export const updateCheckInterval = (lastCheckFailed: boolean): number =>
  lastCheckFailed ? RETRY_AFTER_FAILURE_MS : DAY_MS

export const useUpdate = (enabled: boolean = true) => {
  const { verge } = useVerge()
  const { auto_check_update } = verge || {}

  // OrigamiVPN: installs updated by a package manager (Arch) skip the built-in updater.
  const packageManager = usePackageManager()
  const shouldCheck =
    enabled && auto_check_update !== false && packageManager === null

  const [lastCheckFailed, setLastCheckFailed] = useState(false)
  const fetchAndNote = async () => {
    try {
      const result = await fetchUpdate()
      setLastCheckFailed(false)
      return result
    } catch (err) {
      setLastCheckFailed(true)
      throw err
    }
  }

  const { data: updateInfo, isFetching: isValidating } = useQuery({
    queryKey: UPDATE_QUERY_KEY,
    queryFn: fetchAndNote,
    enabled: shouldCheck,
    retry: 2,
    staleTime: 60 * 60 * 1000,
    refetchInterval: updateCheckInterval(lastCheckFailed),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  })

  const checkUpdate = async () => {
    const data = await checkAndRememberUpdate()
    return { data }
  }

  const { data: lastCheckUpdate } = useQuery({
    queryKey: [LAST_CHECK_KEY],
    queryFn: readLastCheckTime,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  return {
    updateInfo,
    checkUpdate,
    loading: isValidating,
    lastCheckUpdate: lastCheckUpdate ?? null,
  }
}
