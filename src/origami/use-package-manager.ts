import { useEffect, useState } from 'react'

import { getPackageManager } from '@/services/cmds'

let cached: Promise<string | null> | undefined

/** `undefined` while loading, `null` for built-in updates, else the package manager (e.g. pacman). */
export const usePackageManager = () => {
  const [manager, setManager] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    cached ??= getPackageManager().catch(() => null)
    void cached.then((value) => {
      if (alive) setManager(value)
    })
    return () => {
      alive = false
    }
  }, [])
  return manager
}
