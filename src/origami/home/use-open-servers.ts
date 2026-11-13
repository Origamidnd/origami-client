import { useNavigate } from 'react-router'

import { useProxiesData } from '@/providers/app-data-context'

import { resolveCurrent } from '../current-server'
import type { FocusGroupState } from '../use-focus-group'

export const useCurrentServer = () => {
  const { proxyView } = useProxiesData()
  return proxyView ? resolveCurrent(proxyView) : null
}

/** Opens the Servers tab on the service the home plate shows. */
export const useOpenServers = () => {
  const navigate = useNavigate()
  const current = useCurrentServer()
  return () => {
    const state: FocusGroupState = { origamiFocusGroup: current?.group.name }
    navigate('/proxies', { state })
  }
}
