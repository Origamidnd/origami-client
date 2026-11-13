import { useCallback } from 'react'

import { switchProxyNode } from '@/services/cmds'
import { mutate } from '@/services/mutate'
import { debugLog } from '@/utils/debug'

// OrigamiVPN: the switch itself (select or unfix, remember it in the profile, refresh the tray,
// close the connections that went through the group) runs in Rust, the same path the tray uses
// (upstream 05a6e9a6). Here only the request is sent.

interface ProxySelectionOptions {
  onSuccess?: () => void
  onError?: (error: any) => void
}

export const useProxySelection = (options: ProxySelectionOptions = {}) => {
  const { onSuccess, onError } = options

  // Every request is sent (upstream 8660a11c): a one-slot queue dropped all but the last of quick
  // switches, so of several services moved at once only one actually moved. Requests for the same
  // group still apply in order, since `mutate` runs equal ids one after another.
  const changeProxy = useCallback(
    async (groupName: string, proxyName: string, fixed?: string | null) => {
      const unfix = fixed === proxyName
      debugLog(
        `[ProxySelection] ${unfix ? 'unfix' : 'switch'}: ${groupName} -> ${proxyName}`,
      )
      try {
        const result = await mutate(
          () => switchProxyNode(groupName, proxyName, unfix),
          { id: `select-proxy-node:${groupName}`, errorNotice: false },
        )
        if (result.ok) onSuccess?.()
      } catch (error) {
        console.error(
          `[ProxySelection] Failed to switch ${groupName} -> ${proxyName}`,
          error,
        )
        onError?.(error)
      }
    },
    [onError, onSuccess],
  )

  const handleSelectChange = useCallback(
    (groupName: string, fixed?: string | null) =>
      (event: { target: { value: string } }) => {
        void changeProxy(groupName, event.target.value, fixed)
      },
    [changeProxy],
  )

  const handleProxyGroupChange = useCallback(
    (
      group: { name: string; fixed?: string | null },
      proxy: { name: string },
    ) => {
      void changeProxy(group.name, proxy.name, group.fixed)
    },
    [changeProxy],
  )

  return {
    changeProxy,
    handleSelectChange,
    handleProxyGroupChange,
  }
}
