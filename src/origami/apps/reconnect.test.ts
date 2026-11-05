import { closeConnection, getConnections } from 'tauri-plugin-mihomo-api'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OWN_GROUP } from '../routes/routes'

import { followsChoice, reconnectProgram } from './reconnect'

vi.mock('tauri-plugin-mihomo-api', () => ({
  closeConnection: vi.fn(async () => {}),
  getConnections: vi.fn(),
}))

const usual = { rule: 'RuleSet', chains: ['DIRECT', 'Google'] }
const ownVpn = { rule: 'ProcessName', chains: ['Турция', 'Авто', OWN_GROUP] }
const ownDirect = { rule: 'ProcessName', chains: ['DIRECT'] }

describe('followsChoice', () => {
  it('tells each way apart', () => {
    expect(followsChoice(ownVpn, 'vpn')).toBe(true)
    expect(followsChoice(usual, 'vpn')).toBe(false)
    expect(followsChoice(ownDirect, 'direct')).toBe(true)
    expect(followsChoice(usual, 'direct')).toBe(false)
    expect(followsChoice(usual, 'auto')).toBe(true)
    expect(followsChoice(ownVpn, 'auto')).toBe(false)
    expect(followsChoice(ownDirect, 'auto')).toBe(false)
  })
})

const conn = (id: string, way: object, process = 'Game.exe') => ({
  id,
  metadata: { process },
  ...way,
})

const listed = (...lists: object[][]) => {
  const mocked = vi.mocked(getConnections)
  lists.forEach((connections) =>
    mocked.mockResolvedValueOnce({ connections } as never),
  )
  mocked.mockResolvedValue({ connections: lists.at(-1) } as never)
}

const run = async (...args: Parameters<typeof reconnectProgram>) => {
  const done = reconnectProgram(...args)
  await vi.runAllTimersAsync()
  await done
}

describe('reconnectProgram', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(closeConnection).mockClear()
    vi.mocked(getConnections).mockReset()
  })

  it('closes only this program, and only what goes the old way', async () => {
    listed(
      [
        conn('old', usual),
        conn('new', ownVpn),
        conn('other', usual, 'browser.exe'),
      ],
      [conn('new', ownVpn)],
    )
    await run('game.exe', 'vpn')
    expect(vi.mocked(closeConnection).mock.calls).toEqual([['old']])
  })

  it('closes again what reopened by the old rule while the core took the new one in', async () => {
    listed(
      [conn('a', usual)],
      [conn('b', usual)],
      [conn('c', ownVpn)],
      [conn('c', ownVpn)],
    )
    await run('game.exe', 'vpn')
    expect(vi.mocked(closeConnection).mock.calls).toEqual([['a'], ['b']])
  })

  it('keeps trying when the core does not answer for a moment', async () => {
    vi.mocked(getConnections).mockRejectedValueOnce(new Error('reloading'))
    listed([conn('a', usual)], [conn('b', ownVpn)])
    await run('game.exe', 'vpn')
    expect(vi.mocked(closeConnection).mock.calls).toEqual([['a']])
  })

  it('gives up after a few seconds on a connection that never changes', async () => {
    listed([conn('a', usual)])
    await run('game.exe', 'vpn')
    expect(vi.mocked(closeConnection).mock.calls.length).toBe(8)
  })

  it('stops when the program is switched again', async () => {
    listed([conn('a', usual)])
    const first = reconnectProgram('game.exe', 'vpn')
    await vi.advanceTimersByTimeAsync(100)
    listed([conn('a', ownDirect)])
    const second = reconnectProgram('game.exe', 'direct')
    await vi.runAllTimersAsync()
    await Promise.all([first, second])
    expect(vi.mocked(closeConnection).mock.calls).toEqual([['a']])
  })
})
