import { describe, expect, it } from 'vitest'

import {
  addSnapshot,
  emptyTraffic,
  keepOrder,
  programWay,
  sortPrograms,
} from './program-traffic'

const conn = (
  id: string,
  process: string | undefined,
  bytes: number,
  chains = ['Финляндия', 'Авто'],
) =>
  ({
    id,
    metadata: { process },
    upload: bytes / 2,
    download: bytes / 2,
    chains,
  }) as unknown as IConnectionsItem

const isDirect = (node: string) => node === 'DIRECT'

describe('addSnapshot', () => {
  it('counts only what is new between polls', () => {
    let state = addSnapshot(
      emptyTraffic(),
      [conn('a', 'game.exe', 100)],
      isDirect,
    )
    state = addSnapshot(state, [conn('a', 'game.exe', 300)], isDirect)
    expect(state.programs.get('game.exe')?.vpn).toBe(300)
  })

  it('keeps the total after a connection closes', () => {
    let state = addSnapshot(
      emptyTraffic(),
      [conn('a', 'game.exe', 100)],
      isDirect,
    )
    state = addSnapshot(state, [conn('b', 'game.exe', 50)], isDirect)
    state = addSnapshot(state, [], isDirect)
    const stat = state.programs.get('game.exe')
    expect(stat?.vpn).toBe(150)
    expect(stat && programWay(stat)).toBe('idle')
  })

  it('splits direct and VPN traffic and remembers the server', () => {
    const state = addSnapshot(
      emptyTraffic(),
      [
        conn('a', 'edge.exe', 100, ['DIRECT', 'Ру-сайты']),
        conn('b', 'edge.exe', 40, ['Швеция', 'YouTube']),
      ],
      isDirect,
    )
    const stat = state.programs.get('edge.exe')
    expect(stat).toMatchObject({ direct: 100, vpn: 40, server: 'Швеция' })
    expect(stat && programWay(stat)).toBe('both')
  })

  it('leaves out the client and its core, groups unknown programs', () => {
    const state = addSnapshot(
      emptyTraffic(),
      [
        conn('a', 'verge-mihomo.exe', 100),
        conn('b', 'origamivpn.exe', 100),
        conn('c', undefined, 70),
      ],
      isDirect,
    )
    expect([...state.programs.keys()]).toEqual([''])
  })
})

describe('programWay', () => {
  it('follows open connections, not the totals, after the way is changed', () => {
    let state = addSnapshot(
      emptyTraffic(),
      [conn('a', 'game.exe', 100)],
      isDirect,
    )
    state = addSnapshot(
      state,
      [conn('b', 'game.exe', 10, ['DIRECT', 'Игры'])],
      isDirect,
    )
    const stat = state.programs.get('game.exe')
    expect(stat).toMatchObject({ vpn: 100, direct: 10 })
    expect(stat && programWay(stat)).toBe('direct')
  })
})

describe('sortPrograms', () => {
  it('puts the busiest first', () => {
    const list = sortPrograms([
      { name: 'small', direct: 1, vpn: 0, activeDirect: 0, activeVpn: 0 },
      { name: 'big', direct: 5, vpn: 5, activeDirect: 0, activeVpn: 0 },
    ])
    expect(list.map((item) => item.name)).toEqual(['big', 'small'])
  })
})

describe('keepOrder', () => {
  const stat = (name: string, bytes: number) => ({
    name,
    direct: bytes,
    vpn: 0,
    activeDirect: 0,
    activeVpn: 0,
  })

  it('holds the rows where they were while the traffic changes the sums', () => {
    const list = sortPrograms([stat('game', 50), stat('browser', 10)])
    const held = keepOrder(
      sortPrograms([stat('game', 50), stat('browser', 99)]),
      list.map((item) => item.name),
    )
    expect(held.map((item) => item.name)).toEqual(['game', 'browser'])
  })

  it('adds programs new since then at the end', () => {
    const held = keepOrder(sortPrograms([stat('new', 500), stat('game', 50)]), [
      'game',
    ])
    expect(held.map((item) => item.name)).toEqual(['game', 'new'])
  })
})
