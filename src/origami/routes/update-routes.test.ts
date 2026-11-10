import { getProxies } from 'tauri-plugin-mihomo-api'
import { beforeEach, expect, it, vi } from 'vitest'

import type { IOrigamiRoute } from '@/services/bindings'
import { getVergeConfig } from '@/services/cmds'

import { updateRoutes } from './update-routes'

vi.mock('tauri-plugin-mihomo-api', () => ({
  delayProxyByName: vi.fn(),
  getProxies: vi.fn(async () => ({ proxies: {} })),
  selectNodeForGroup: vi.fn(),
  unfixedProxy: vi.fn(),
}))
vi.mock('@/services/cmds', () => ({ getVergeConfig: vi.fn() }))

let saved: IOrigamiRoute[] = []
const patch = vi.fn(
  async (value: { origami_routes?: IOrigamiRoute[] | null }) => {
    // A reload takes a moment; meanwhile another writer may be waiting.
    await new Promise((resolve) => setTimeout(resolve, 10))
    saved = value.origami_routes ?? []
  },
)

const route = (value: string) =>
  ({ kind: 'app', value, via: 'vpn' }) as unknown as IOrigamiRoute

beforeEach(() => {
  saved = []
  patch.mockClear()
  vi.mocked(getProxies).mockClear()
  vi.mocked(getVergeConfig).mockImplementation(
    async () => ({ origami_routes: saved }) as never,
  )
})

it('keeps both changes when two writers save at the same time', async () => {
  // The publisher timer and a click in "Programs" each used to write the whole list from what
  // they had read before, and the later write dropped the earlier change.
  await Promise.all([
    updateRoutes(patch, (routes) => [...routes, route('a.exe')]),
    updateRoutes(patch, (routes) => [...routes, route('b.exe')]),
  ])
  expect(saved.map((r) => r.value).sort()).toEqual(['a.exe', 'b.exe'])
})

it('writes nothing when the update has nothing to change', async () => {
  await updateRoutes(patch, () => null)
  expect(patch).not.toHaveBeenCalled()
})
