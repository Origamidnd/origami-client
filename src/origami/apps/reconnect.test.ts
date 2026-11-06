import { closeConnection, getConnections } from 'tauri-plugin-mihomo-api'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProgramChoice, ProgramScope } from '../routes/linked'
import { OWN_GROUP } from '../routes/routes'

import { followsChoice, reconnectProgram } from './reconnect'

vi.mock('tauri-plugin-mihomo-api', () => ({
  closeConnection: vi.fn(async () => {}),
  getConnections: vi.fn(),
}))

const usual = { rulePayload: 'ru', chains: ['DIRECT', 'Google'] }
const ownVpn = {
  rulePayload: 'game.exe',
  chains: ['Турция', 'Авто', OWN_GROUP],
}
const ownDirect = { rulePayload: 'game.exe', chains: ['DIRECT'] }
const ownFamily = { rulePayload: '(?i)^family', chains: ['DIRECT'] }
// A rule of the template that also sends a program direct: not ours to undo.
const theirDirect = { rulePayload: '(?i)^steam', chains: ['DIRECT'] }

const PAYLOADS = new Set(['game.exe', '(?i)^family'])

const scope = (...names: string[]): ProgramScope => ({
  key: names[0],
  has: (name) =>
    !!name && names.some((item) => item.toLowerCase() === name.toLowerCase()),
  payloads: PAYLOADS,
})

describe('followsChoice', () => {
  it('tells each way apart', () => {
    const follows = (way: object, choice: ProgramChoice) =>
      followsChoice(way, choice, PAYLOADS)
    expect(follows(ownVpn, 'vpn')).toBe(true)
    expect(follows(usual, 'vpn')).toBe(false)
    expect(follows(ownDirect, 'direct')).toBe(true)
    expect(follows(ownFamily, 'direct')).toBe(true)
    expect(follows(usual, 'direct')).toBe(false)
    expect(follows(theirDirect, 'direct')).toBe(false)
    expect(follows(usual, 'auto')).toBe(true)
    expect(follows(theirDirect, 'auto')).toBe(true)
    expect(follows(ownVpn, 'auto')).toBe(false)
    expect(follows(ownDirect, 'auto')).toBe(false)
    expect(follows(ownFamily, 'auto')).toBe(false)
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
    await run(scope('game.exe'), 'vpn')
    expect(vi.mocked(closeConnection).mock.calls).toEqual([['old']])
  })

  it('closes the other programs of the scope too', async () => {
    listed(
      [
        conn('game', usual),
        conn('launcher', usual, 'Launcher.exe'),
        conn('other', usual, 'browser.exe'),
      ],
      [],
    )
    await run(scope('game.exe', 'launcher.exe'), 'vpn')
    expect(vi.mocked(closeConnection).mock.calls).toEqual([
      ['game'],
      ['launcher'],
    ])
  })

  it('closes again what reopened by the old rule while the core took the new one in', async () => {
    listed(
      [conn('a', usual)],
      [conn('b', usual)],
      [conn('c', ownVpn)],
      [conn('c', ownVpn)],
    )
    await run(scope('game.exe'), 'vpn')
    expect(vi.mocked(closeConnection).mock.calls).toEqual([['a'], ['b']])
  })

  it('keeps trying when the core does not answer for a moment', async () => {
    vi.mocked(getConnections).mockRejectedValueOnce(new Error('reloading'))
    listed([conn('a', usual)], [conn('b', ownVpn)])
    await run(scope('game.exe'), 'vpn')
    expect(vi.mocked(closeConnection).mock.calls).toEqual([['a']])
  })

  it('gives up after a few seconds on a connection that never changes', async () => {
    listed([conn('a', usual)])
    await run(scope('game.exe'), 'vpn')
    expect(vi.mocked(closeConnection).mock.calls.length).toBe(8)
  })

  it('stops when the program is switched again', async () => {
    listed([conn('a', usual)])
    const first = reconnectProgram(scope('game.exe'), 'vpn')
    await vi.advanceTimersByTimeAsync(100)
    listed([conn('a', ownDirect)])
    const second = reconnectProgram(scope('game.exe'), 'direct')
    await vi.runAllTimersAsync()
    await Promise.all([first, second])
    expect(vi.mocked(closeConnection).mock.calls).toEqual([['a']])
  })
})
