import type { IOrigamiRoute } from '@/services/bindings'
import { getVergeConfig } from '@/services/cmds'

import { keepAutoServers } from '../servers/auto-hold'

type Patch = (value: Partial<IVergeConfig>) => Promise<unknown>

/**
 * Changes the routes from the ones saved right now, inside the queue of core reloads. The publisher
 * timer, "Programs" and own routes each used to write the whole list from what they had read earlier,
 * so the later write dropped the earlier change. `update` returns null when there is nothing to do.
 */
export const updateRoutes = async (
  patch: Patch,
  update: (routes: IOrigamiRoute[]) => IOrigamiRoute[] | null,
) => {
  let before: IOrigamiRoute[] = []
  let next: IOrigamiRoute[] | null = null
  await keepAutoServers(async () => {
    before = (await getVergeConfig()).origami_routes ?? []
    next = update(before)
    if (next) await patch({ origami_routes: next })
  })
  return { before, next: next as IOrigamiRoute[] | null }
}
