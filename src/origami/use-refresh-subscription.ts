import { useLockFn } from 'ahooks'
import { useState } from 'react'

import { useProfiles } from '@/hooks/use-profiles'
import { useAppRefreshers } from '@/providers/app-data-context'
import { updateProfile } from '@/services/cmds'
import { mutate } from '@/services/mutate'
import { showNotice } from '@/services/notice-service'

import { explainSubscriptionError } from './errors'

/** Downloads the current subscription again; shared by Home, Servers and the subscription page. */
export const useRefreshSubscription = () => {
  const { current, mutateProfiles } = useProfiles()
  const { refreshAll } = useAppRefreshers()
  const [updating, setUpdating] = useState(false)

  const refresh = useLockFn(async () => {
    const uid = current?.uid
    if (!uid) return
    setUpdating(true)
    try {
      await mutate(() => updateProfile(uid, current.option ?? undefined), {
        id: `update-profile:${uid}`,
        errorNotice: false,
      })
      await mutateProfiles()
      await refreshAll()
      showNotice.success('origami.home.subscription.refreshed')
    } catch (error) {
      const reason = explainSubscriptionError(error)
      if (reason) showNotice.error(reason)
      else showNotice.error(error)
    } finally {
      setUpdating(false)
    }
  })

  return {
    refresh,
    updating,
    canRefresh: current?.type === 'remote',
  }
}
