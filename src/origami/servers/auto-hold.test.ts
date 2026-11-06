import {
  delayProxyByName,
  getProxies,
  selectNodeForGroup,
  unfixedProxy,
} from 'tauri-plugin-mihomo-api'
import { beforeEach, expect, it, vi } from 'vitest'

import { autoGroupsSettled, keepAutoServers } from './auto-hold'

vi.mock('tauri-plugin-mihomo-api', () => ({
  delayProxyByName: vi.fn(),
  getProxies: vi.fn(),
  selectNodeForGroup: vi.fn(),
  unfixedProxy: vi.fn(),
}))

const URL = 'https://example.com/204'
const calls: string[] = []

const group = (name: string, now: string, fixed = '') => ({
  name,
  now,
  fixed,
  type: 'URLTest',
  testUrl: URL,
})

const setGroups = (...groups: object[]) => {
  vi.mocked(getProxies).mockImplementation(async () => {
    calls.push('read')
    return { proxies: Object.fromEntries(groups.entries()) } as never
  })
}

beforeEach(() => {
  calls.length = 0
  vi.mocked(selectNodeForGroup).mockReset()
  vi.mocked(selectNodeForGroup).mockImplementation(async (name, node) => {
    calls.push(`pin ${name} ${node}`)
  })
  vi.mocked(delayProxyByName).mockReset()
  vi.mocked(delayProxyByName).mockImplementation(async (server) => {
    calls.push(`test ${server}`)
    return { delay: 80 } as never
  })
  vi.mocked(unfixedProxy).mockReset()
  vi.mocked(unfixedProxy).mockImplementation(async (name) => {
    calls.push(`unpin ${name}`)
  })
})

const change = async () => {
  calls.push('change')
  return 'done'
}

it('holds the server through the reload, measures it and lets go', async () => {
  setGroups(group('Auto', 'Turkey'))
  expect(await keepAutoServers(change)).toBe('done')
  await autoGroupsSettled()
  expect(calls).toEqual([
    'read',
    'change',
    'pin Auto Turkey',
    // Without this read the group would forget the server as soon as it is let go.
    'read',
    'test Turkey',
    'unpin Auto',
  ])
  expect(delayProxyByName).toHaveBeenCalledWith('Turkey', URL, 5000)
})

it('leaves alone a server someone pinned', async () => {
  setGroups(group('Auto', 'Turkey', 'Turkey'))
  await keepAutoServers(change)
  await autoGroupsSettled()
  expect(calls).toEqual(['read', 'change'])
})

it('leaves alone a group of another kind', async () => {
  setGroups({ name: 'Choice', now: 'Turkey', type: 'Selector' })
  await keepAutoServers(change)
  expect(calls).toEqual(['read', 'change'])
})

it('lets go also when the server does not answer', async () => {
  setGroups(group('Auto', 'Turkey'))
  vi.mocked(delayProxyByName).mockRejectedValue(new Error('Timeout'))
  await keepAutoServers(change)
  await autoGroupsSettled()
  expect(unfixedProxy).toHaveBeenCalledWith('Auto')
})

it('still makes the change when the core does not answer first', async () => {
  vi.mocked(getProxies).mockRejectedValue(new Error('pipe'))
  expect(await keepAutoServers(change)).toBe('done')
  expect(selectNodeForGroup).not.toHaveBeenCalled()
})

it('makes changes one after another, so a held group is not taken for a pinned one', async () => {
  let answer = () => {}
  setGroups(group('Auto', 'Turkey'))
  vi.mocked(delayProxyByName).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = () => resolve({ delay: 80 } as never)
      }),
  )
  await keepAutoServers(change)
  const second = keepAutoServers(change)
  await Promise.resolve()
  expect(calls.filter((call) => call === 'change')).toHaveLength(1)
  answer()
  await second
  await autoGroupsSettled()
  expect(calls.filter((call) => call === 'change')).toHaveLength(2)
  expect(vi.mocked(unfixedProxy).mock.calls).toHaveLength(2)
})

it('does not wait for ever for a core that does not answer', async () => {
  vi.useFakeTimers()
  try {
    vi.mocked(getProxies).mockImplementation(() => new Promise(() => {}))
    const run = keepAutoServers(change)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await run).toBe('done')
    expect(selectNodeForGroup).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('touches nothing when the change fails', async () => {
  setGroups(group('Auto', 'Turkey'))
  await expect(
    keepAutoServers(async () => {
      throw new Error('no')
    }),
  ).rejects.toThrow('no')
  expect(selectNodeForGroup).not.toHaveBeenCalled()
})
