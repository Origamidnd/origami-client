import { beforeEach, expect, it, vi } from 'vitest'

import { restartCore } from '@/services/cmds'

vi.mock('@/services/cmds', () => ({ restartCore: vi.fn() }))
vi.mock('@/services/notice-service', () => ({ showNotice: { info: vi.fn() } }))

const stopped = { kind: 'serviceCoreStopped' as const, detail: 'exit 1' }

beforeEach(() => {
  vi.resetModules()
  vi.mocked(restartCore).mockReset()
})

it('restarts a stopped core quietly twice, then asks the user', async () => {
  vi.mocked(restartCore).mockResolvedValue(undefined as never)
  const store = await import('./store')

  await store.reportCoreTrouble(stopped, 1000)
  await store.reportCoreTrouble(stopped, 2000)
  expect(store.currentCoreTrouble()).toBeNull()

  await store.reportCoreTrouble(stopped, 3000)
  expect(restartCore).toHaveBeenCalledTimes(2)
  expect(store.currentCoreTrouble()).toEqual(stopped)
})

it('shows the dialog when the quiet restart fails', async () => {
  vi.mocked(restartCore).mockRejectedValue(new Error('no'))
  const store = await import('./store')

  await store.reportCoreTrouble(stopped, 1000)

  expect(store.currentCoreTrouble()).toEqual(stopped)
})

it('asks right away for a config that fails the check', async () => {
  const store = await import('./store')
  const config = { kind: 'config' as const, detail: 'bad yaml' }

  await store.reportCoreTrouble(config, 1000)

  expect(restartCore).not.toHaveBeenCalled()
  expect(store.currentCoreTrouble()).toEqual(config)
})
