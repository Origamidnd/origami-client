import { beforeEach, expect, it, vi } from 'vitest'

import { switchProxyNode } from '@/services/cmds'

import { useProxySelection } from './use-proxy-selection'

vi.mock('react', () => ({
  useCallback: (callback: unknown) => callback,
}))
vi.mock('@/services/cmds', () => ({ switchProxyNode: vi.fn() }))
vi.mock('@/services/notice-service', () => ({ showNotice: { error: vi.fn() } }))
vi.mock('@/services/query-client', () => ({ revalidateQueries: vi.fn() }))

beforeEach(() => {
  vi.mocked(switchProxyNode).mockReset()
  vi.mocked(switchProxyNode).mockResolvedValue(null)
})

it('moves every service of a quick batch, not only the last one', async () => {
  // Auto-variant moves several services through one hook in a loop.
  const onSuccess = vi.fn()
  const { handleProxyGroupChange } = useProxySelection({ onSuccess })
  handleProxyGroupChange({ name: '🚫 Blocked' }, { name: '🇩🇪 Germany' })
  handleProxyGroupChange({ name: '💬 Discord' }, { name: '🇫🇮 Finland' })
  handleProxyGroupChange({ name: '🎮 Games' }, { name: '🇸🇪 Sweden' })
  await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(3))
  expect(vi.mocked(switchProxyNode).mock.calls).toEqual([
    ['🚫 Blocked', '🇩🇪 Germany', false],
    ['💬 Discord', '🇫🇮 Finland', false],
    ['🎮 Games', '🇸🇪 Sweden', false],
  ])
})

it('applies quick choices in one group in the order they were made', async () => {
  let finishFirst!: () => void
  vi.mocked(switchProxyNode).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishFirst = () => resolve(null)
      }),
  )
  const { changeProxy } = useProxySelection()
  void changeProxy('🚫 Blocked', '🇩🇪 Germany')
  const second = changeProxy('🚫 Blocked', '🇫🇮 Finland')
  await Promise.resolve()
  expect(switchProxyNode).toHaveBeenCalledOnce()
  finishFirst()
  await second
  expect(vi.mocked(switchProxyNode).mock.calls.map((call) => call[1])).toEqual([
    '🇩🇪 Germany',
    '🇫🇮 Finland',
  ])
})

it('unfixes when the pinned server is chosen again', async () => {
  const { handleProxyGroupChange } = useProxySelection()
  handleProxyGroupChange(
    { name: '🚫 Blocked', fixed: '🇩🇪 Germany' },
    { name: '🇩🇪 Germany' },
  )
  await vi.waitFor(() =>
    expect(switchProxyNode).toHaveBeenCalledWith(
      '🚫 Blocked',
      '🇩🇪 Germany',
      true,
    ),
  )
})

it('reports a failed switch', async () => {
  vi.mocked(switchProxyNode).mockRejectedValueOnce(new Error('core restarting'))
  const onError = vi.fn()
  const onSuccess = vi.fn()
  const { changeProxy } = useProxySelection({ onError, onSuccess })
  await changeProxy('🚫 Blocked', '🇩🇪 Germany')
  expect(onError).toHaveBeenCalledOnce()
  expect(onSuccess).not.toHaveBeenCalled()
})
