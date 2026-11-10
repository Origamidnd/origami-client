import { describe, expect, it } from 'vitest'

import {
  cleanDomain,
  cleanProcess,
  recentProcesses,
  upsertRoute,
} from './routes'

describe('cleanProcess', () => {
  it('refuses the spaces the core rule would refuse (only a plain space is kept)', () => {
    // src-tauri enhance/origami_routes.rs valid_field: any other whitespace drops the rule.
    expect(cleanProcess('My\u00a0Game.exe')).toBeNull()
    expect(cleanProcess('My\tGame.exe')).toBeNull()
    expect(cleanProcess('My Game.exe')).toBe('My Game.exe')
  })

  it('keeps only the file name', () => {
    expect(cleanProcess('C:\\Games\\Tarkov\\EscapeFromTarkov.exe')).toBe(
      'EscapeFromTarkov.exe',
    )
    expect(cleanProcess('/usr/bin/firefox')).toBe('firefox')
  })

  it('allows spaces but not commas', () => {
    expect(cleanProcess(' League of Legends.exe ')).toBe(
      'League of Legends.exe',
    )
    expect(cleanProcess('evil.exe,DIRECT')).toBeNull()
    expect(cleanProcess('   ')).toBeNull()
  })
})

describe('cleanDomain', () => {
  it('takes the host out of a link', () => {
    expect(cleanDomain('https://www.Example.com/a?b#c')).toBe('example.com')
    expect(cleanDomain('*.example.org')).toBe('example.org')
    expect(cleanDomain('example.org:8443')).toBe('example.org')
  })

  it('refuses what is not a domain', () => {
    expect(cleanDomain('localhost')).toBeNull()
    expect(cleanDomain('not a domain')).toBeNull()
  })
})

describe('upsertRoute', () => {
  it('changes the way of an app already routed instead of adding it twice', () => {
    const routes = [{ kind: 'app', value: 'Steam.exe', via: 'direct' }]
    expect(
      upsertRoute(routes, { kind: 'app', value: 'steam.exe', via: 'vpn' }),
    ).toEqual([{ kind: 'app', value: 'steam.exe', via: 'vpn' }])
  })

  it('adds a new one at the end', () => {
    const routes = [{ kind: 'app', value: 'a.exe', via: 'direct' }]
    expect(
      upsertRoute(routes, { kind: 'site', value: 'a.com', via: 'vpn' }),
    ).toHaveLength(2)
  })
})

describe('recentProcesses', () => {
  const conn = (process?: string) =>
    ({ metadata: { process } }) as unknown as IConnectionsItem

  it('lists busy programs first, without the core and routed ones', () => {
    const list = recentProcesses(
      [
        conn('chrome.exe'),
        conn('steam.exe'),
        conn('chrome.exe'),
        conn('verge-mihomo.exe'),
        conn('Discord.exe'),
        conn(undefined),
      ],
      [{ kind: 'app', value: 'discord.exe', via: 'vpn' }],
    )
    expect(list).toEqual(['chrome.exe', 'steam.exe'])
  })
})
