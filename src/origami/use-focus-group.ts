import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'

import type { HeadState } from '@/components/proxy/use-head-state'

export interface FocusGroupState {
  origamiFocusGroup?: string
}

/** Opens and scrolls to the group passed in navigation state, e.g. from the home server card. */
export const useFocusGroup = (
  groupNames: string[],
  onHeadState: (groupName: string, patch: Partial<HeadState>) => void,
  locate: (groupName: string) => void,
) => {
  const location = useLocation()
  const navigate = useNavigate()
  const target = (location.state as FocusGroupState | null)?.origamiFocusGroup
  const openedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!target || !groupNames.includes(target)) return
    if (openedRef.current !== target) {
      openedRef.current = target
      onHeadState(target, { open: true })
    }
    const frame = requestAnimationFrame(() => {
      locate(target)
      // Clear the state so returning to the page does not jump again.
      navigate(location.pathname, { replace: true, state: null })
    })
    return () => cancelAnimationFrame(frame)
  }, [target, groupNames, onHeadState, locate, navigate, location.pathname])
}
