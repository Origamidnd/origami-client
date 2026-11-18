import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('tauri-plugin-mihomo-api', () => ({
  delayProxyByName: vi.fn(async () => ({ delay: 120 })),
  healthcheckNodeInProvider: vi.fn(async () => ({ delay: 120 })),
}))

import type { ResolvedProxyMember } from '@/types/proxy-view'

import delayManager from './delay'

const node = (name: string) =>
  ({
    kind: 'node',
    ref: { kind: 'node', name, recordId: `r:${name}` },
    node: {
      recordId: `r:${name}`,
      name,
      history: [],
      source: { kind: 'core', proxyName: name },
    },
  }) as unknown as ResolvedProxyMember

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

let settles = 0
let unsubscribe: () => void

beforeEach(() => {
  settles = 0
  unsubscribe = delayManager.addGroupListener('g', () => {
    settles += 1
  })
})

afterEach(() => unsubscribe())

describe('group delay completion', () => {
  test('notifies once after a batch settles', async () => {
    const proxies = Array.from({ length: 6 }, (_, index) => node(`n${index}`))

    await delayManager.checkListDelay(proxies as never, 'g', 5000, 2)
    await flush()

    expect(settles).toBe(1)
  })

  test('notifies only listeners for the completed group', async () => {
    let other = 0
    const stop = delayManager.addGroupListener('other', () => {
      other += 1
    })

    await delayManager.checkDelay(node('a') as never, 'g', 5000)
    await flush()

    expect(settles).toBe(1)
    expect(other).toBe(0)
    stop()
  })
})

const nodeWithHistory = (
  name: string,
  history: { time: string; delay: number }[],
) =>
  ({
    kind: 'node',
    ref: { kind: 'node', name, recordId: `r:${name}` },
    node: {
      recordId: `r:${name}`,
      name,
      history,
      source: { kind: 'core', proxyName: name },
    },
  }) as unknown as ResolvedProxyMember

describe('manual check versus newer core tests', () => {
  test('a newer core result replaces an older manual one', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-16T10:00:00Z'))
    delayManager.setDelay('fresh', 'g', 0)
    vi.setSystemTime(new Date('2026-11-16T10:05:00Z'))
    const member = nodeWithHistory('fresh', [
      { time: '2026-11-16T10:01:00Z', delay: 213 },
    ])

    // Upstream pages keep their own rule (the group's check wins); only our screens take the newer.
    expect(delayManager.getDelayFix(member, 'g')).toBe(0)
    expect(
      delayManager.getFreshDelay('fresh', 'g', memberHistory(member)),
    ).toBe(213)
    vi.useRealTimers()
  })

  test('a manual result newer than the core history stays', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-16T10:02:00Z'))
    delayManager.setDelay('manual', 'g', 512)
    const member = nodeWithHistory('manual', [
      { time: '2026-11-16T10:01:00Z', delay: 213 },
    ])

    expect(delayManager.getDelayFix(member, 'g')).toBe(512)
    expect(
      delayManager.getFreshDelay('manual', 'g', memberHistory(member)),
    ).toBe(512)
    vi.useRealTimers()
  })
})

const memberHistory = (member: ResolvedProxyMember) =>
  (
    member as unknown as {
      node: { history: { time: string; delay: number }[] }
    }
  ).node.history

describe('fresh delay edge cases', () => {
  test('an unreadable core time falls back to the manual result', () => {
    delayManager.setDelay('nan', 'g', 300)
    expect(
      delayManager.getFreshDelay('nan', 'g', [
        { time: 'not a time', delay: 99 },
      ]),
    ).toBe(300)
  })

  test('a running check wins and an empty history changes nothing', () => {
    delayManager.setDelay('busy', 'g', -2)
    expect(
      delayManager.getFreshDelay('busy', 'g', [
        { time: new Date(Date.now() + 60000).toISOString(), delay: 50 },
      ]),
    ).toBe(-2)
    expect(delayManager.getFreshDelay('nothing', 'g', [])).toBe(-1)
  })
})
