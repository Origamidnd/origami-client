import { describe, expect, it, vi } from 'vitest'

import { staleConnections } from './auto-warmup'

vi.mock('tauri-plugin-mihomo-api', () => ({}))
vi.mock('../home/use-connection', () => ({ useConnection: vi.fn() }))

const AUTO = 'Авто'
const SINCE = Date.UTC(2026, 10, 5, 12, 0, 0)
const after = (seconds: number) =>
  new Date(SINCE + seconds * 1000).toISOString()
const picks = new Map([[AUTO, 'Турция']])

const ids = (connections: { id: string }[]) =>
  connections.map((connection) => connection.id)

describe('staleConnections', () => {
  it('takes what opened after the reload through a server Auto no longer picks', () => {
    const stale = staleConnections(
      [{ id: 'a', start: after(1), chains: ['Финляндия', AUTO, 'YouTube'] }],
      picks,
      SINCE,
    )
    expect(ids(stale)).toEqual(['a'])
  })

  it('leaves what already goes through the picked server', () => {
    const stale = staleConnections(
      [{ id: 'a', start: after(1), chains: ['Турция', AUTO, 'YouTube'] }],
      picks,
      SINCE,
    )
    expect(stale).toEqual([])
  })

  it('leaves older connections: a running game must not be cut', () => {
    const stale = staleConnections(
      [{ id: 'a', start: after(-60), chains: ['Финляндия', AUTO, 'Игры'] }],
      picks,
      SINCE,
    )
    expect(stale).toEqual([])
  })

  it('leaves servers chosen by hand and direct connections', () => {
    const stale = staleConnections(
      [
        { id: 'a', start: after(1), chains: ['Германия', 'YouTube'] },
        { id: 'b', start: after(1), chains: ['DIRECT'] },
        { id: 'c', start: after(1) },
      ],
      picks,
      SINCE,
    )
    expect(stale).toEqual([])
  })
})
