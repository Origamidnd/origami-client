import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('@/services/delay', () => ({
  default: { getDelayFix: () => -1 },
}))
vi.mock('@/hooks/use-proxy-selection', () => ({ useProxySelection: vi.fn() }))
vi.mock('@/hooks/use-verge', () => ({ useVerge: vi.fn() }))
vi.mock('@/providers/app-data-context', () => ({
  useAppRefreshers: vi.fn(),
  useProxiesData: vi.fn(),
}))
vi.mock('@/services/notice-service', () => ({ showNotice: { info: vi.fn() } }))

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
})

const node = (name: string) =>
  ({
    kind: 'node',
    ref: { name },
    node: { name, type: 'Vless' },
  }) as never

const service = (name: string, now: string) =>
  ({
    group: { name, now },
    servers: [
      node('🔷 🇸🇪 Швеция'),
      node('🔷 🇸🇪 Швеция (xHTTP)'),
      node('🔷 🇩🇪 Германия'),
    ],
  }) as never

beforeEach(() => {
  store.clear()
  vi.resetModules()
})

it('pins the countries whose variant was already chosen, once', async () => {
  const { pinExistingChoicesOnce, pendingSwitches } = await import(
    './auto-variant'
  )
  pinExistingChoicesOnce([
    service('🎮 Игры', '🔷 🇸🇪 Швеция (xHTTP)'),
    service('▶️ YouTube', '🔷 🇩🇪 Германия'),
  ])

  expect(JSON.parse(store.get('origami.variantPinned') ?? '[]')).toEqual([
    '🇸🇪 Швеция',
  ])
  expect(pendingSwitches([service('🎮 Игры', '🔷 🇸🇪 Швеция (xHTTP)')])).toEqual(
    [],
  )
})

it('does nothing the second time', async () => {
  store.set('origami.variantPinnedExisting', '1')
  const { pinExistingChoicesOnce } = await import('./auto-variant')
  pinExistingChoicesOnce([service('🎮 Игры', '🔷 🇸🇪 Швеция (xHTTP)')])

  expect(store.has('origami.variantPinned')).toBe(false)
})
