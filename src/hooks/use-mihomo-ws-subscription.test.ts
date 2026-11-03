import type { MihomoWebSocket } from 'tauri-plugin-mihomo-api'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { createSharedSubscriptionEntry } from './use-mihomo-ws-subscription'

vi.mock('@/services/query-client', () => ({
  removeCacheData: vi.fn(),
  setCacheData: vi.fn(),
  useQuery: vi.fn(),
}))

const fakeSocket = () => {
  let listener: ((msg: { type: 'Text'; data: string }) => void) | undefined
  const ws = {
    addListener: vi.fn((cb: typeof listener) => {
      listener = cb
      return () => {}
    }),
    close: vi.fn(async () => {}),
  }
  return {
    ws: ws as unknown as MihomoWebSocket,
    close: ws.close,
    tick: () => listener?.({ type: 'Text', data: '{"up":0,"down":0}' }),
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('reconnects a feed that went quiet', async () => {
  const first = fakeSocket()
  const second = fakeSocket()
  const connect = vi
    .fn()
    .mockResolvedValueOnce(first.ws)
    .mockResolvedValueOnce(second.ws)
  const entry = createSharedSubscriptionEntry(connect, 5000)

  await entry.connectWs()
  await vi.advanceTimersByTimeAsync(11_000)

  expect(first.close).toHaveBeenCalled()
  expect(connect).toHaveBeenCalledTimes(2)
})

it('keeps a feed that keeps ticking', async () => {
  const socket = fakeSocket()
  const connect = vi.fn().mockResolvedValue(socket.ws)
  const entry = createSharedSubscriptionEntry(connect, 5000)

  await entry.connectWs()
  for (let second = 0; second < 20; second += 1) {
    socket.tick()
    await vi.advanceTimersByTimeAsync(1000)
  }

  expect(socket.close).not.toHaveBeenCalled()
  expect(connect).toHaveBeenCalledTimes(1)
})

it('leaves feeds without a limit alone', async () => {
  const socket = fakeSocket()
  const connect = vi.fn().mockResolvedValue(socket.ws)
  const entry = createSharedSubscriptionEntry(connect)

  await entry.connectWs()
  await vi.advanceTimersByTimeAsync(60_000)

  expect(socket.close).not.toHaveBeenCalled()
})
