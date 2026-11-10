import { describe, expect, it } from 'vitest'

import {
  buildPayload,
  EntryCollector,
  parseLogFailure,
  preselectProcesses,
  registrableDomain,
  reportTarget,
  selectEntries,
  siteDomain,
  suggestRules,
  summarizeProcesses,
  type ReportEntry,
} from './model'

const conn = (
  id: string,
  process: string,
  host: string,
  download: number,
  extra: Partial<IConnectionsItem['metadata']> = {},
): IConnectionsItem => ({
  id,
  metadata: {
    network: 'tcp',
    type: 'Tun',
    host,
    sourceIP: '198.18.0.1',
    sourcePort: '50000',
    destinationPort: '443',
    process,
    ...extra,
  },
  upload: 100,
  download,
  start: '2026-11-02T20:00:00Z',
  chains: ['DIRECT'],
  rule: 'RuleSet',
  rulePayload: 'games-direct',
})

describe('EntryCollector', () => {
  it('merges connections to one destination and adds only growth of totals', () => {
    const c = new EntryCollector()
    c.addConnection(conn('1', 'dota2.exe', 'api.steampowered.com', 1000), false)
    c.addConnection(conn('1', 'dota2.exe', 'api.steampowered.com', 1500), false)
    c.addConnection(conn('2', 'dota2.exe', 'api.steampowered.com', 200), true)
    const [entry] = c.list()
    expect(entry.download).toBe(1700)
    expect(entry.failed).toBe(false)
  })

  it('marks destinations that closed without data or that the core logged as failing', () => {
    const c = new EntryCollector()
    c.addConnection(conn('1', 'dota2.exe', 'dead.example', 0), true)
    c.addConnection(conn('2', 'dota2.exe', 'cdn.example', 5000), false)
    c.addLogError({
      network: 'tcp',
      process: 'dota2.exe',
      host: 'cdn.example',
      port: '443',
      chain: 'DIRECT',
      rule: 'Match',
      error: 'i/o timeout',
    })
    const byHost = Object.fromEntries(c.list().map((e) => [e.host, e]))
    expect(byHost['dead.example'].failed).toBe(true)
    expect(byHost['cdn.example']).toMatchObject({
      failed: true,
      error: 'i/o timeout',
    })
  })
})

describe('parseLogFailure', () => {
  it('reads dial errors from the core log', () => {
    expect(
      parseLogFailure(
        '[TCP] dial DIRECT (match RuleSet/games-direct) 198.18.0.1:54321(dota2.exe) --> api.steampowered.com:443 error: dial tcp 1.2.3.4:443: i/o timeout',
      ),
    ).toEqual({
      network: 'tcp',
      chain: 'DIRECT',
      rule: 'RuleSet/games-direct',
      process: 'dota2.exe',
      host: 'api.steampowered.com',
      port: '443',
      error: 'dial tcp 1.2.3.4:443: i/o timeout',
    })
    expect(
      parseLogFailure('[TCP] 1.1.1.1:1 --> a.b:443 match Match using DIRECT'),
    ).toBeNull()
  })
})

const entry = (
  process: string,
  host: string,
  failed: boolean,
  ip?: string,
): ReportEntry => ({
  process,
  host,
  ip,
  port: '443',
  network: 'tcp',
  rule: '',
  rulePayload: '',
  chain: 'DIRECT',
  upload: 0,
  download: failed ? 0 : 10,
  failed,
})

describe('picking programs and entries', () => {
  const entries = [
    entry('dota2.exe', 'api.steampowered.com', true),
    entry('dota2.exe', '', true, '155.133.248.12'),
    entry('steam.exe', 'store.steampowered.com', false),
    entry('chrome.exe', 'www.example.com', false),
    entry('chrome.exe', 'cdn.other.net', true),
    entry('chrome.exe', 'news.ok.ru', false),
  ]
  const processes = summarizeProcesses(entries)

  it('ticks the program that looks like the typed name', () => {
    expect(preselectProcesses('app', 'Dota 2', processes)).toEqual([
      'dota2.exe',
    ])
  })

  it('falls back to the program with most failures', () => {
    expect(preselectProcesses('app', 'Танки', processes)).toEqual(['dota2.exe'])
  })

  it('ticks browsers for a site and keeps its domain plus failures', () => {
    const picked = preselectProcesses('site', 'example.com', processes)
    expect(picked).toEqual(['chrome.exe'])
    const kept = selectEntries(
      'site',
      entries,
      picked,
      'https://www.example.com/page',
    )
    expect(kept.map((e) => e.host)).toEqual([
      'www.example.com',
      'cdn.other.net',
    ])
  })

  it('keeps only chosen programs for an app', () => {
    expect(selectEntries('app', entries, ['dota2.exe'])).toHaveLength(2)
  })
})

describe('suggestRules', () => {
  it('writes rules in the template format, failures first', () => {
    const rules = suggestRules(
      'app',
      [
        entry('dota2.exe', 'cdn.dota2.com', false),
        entry('dota2.exe', 'api.steampowered.com', true),
        entry('dota2.exe', '', true, '155.133.248.12'),
      ],
      ['dota2.exe'],
      '🎮 Игры',
    )
    expect(rules).toEqual([
      'PROCESS-NAME-REGEX,(?i)^dota2\\.exe$,🎮 Игры',
      'DOMAIN-SUFFIX,steampowered.com,🎮 Игры',
      'DOMAIN-SUFFIX,dota2.com,🎮 Игры',
      'IP-CIDR,155.133.248.0/24,🎮 Игры,no-resolve',
    ])
  })
})

describe('domains and target', () => {
  it('reduces hosts to the registrable domain', () => {
    expect(registrableDomain('api.cdn.steampowered.com')).toBe(
      'steampowered.com',
    )
    expect(registrableDomain('news.bbc.co.uk')).toBe('bbc.co.uk')
    expect(siteDomain('https://www.Example.com/path')).toBe('example.com')
    expect(siteDomain('')).toBe('')
  })

  it('sends only to OrigamiVPN subscriptions', () => {
    expect(reportTarget('https://sub.origamivpn.pro/AbCdEf123456')).toEqual({
      endpoint: 'https://sub.origamivpn.pro/api/report',
      shortUuid: 'AbCdEf123456',
    })
    expect(reportTarget('https://other.example/sub/abc')).toBeNull()
  })

  it('sends over https even when the subscription was added over http', () => {
    expect(
      reportTarget('http://sub.origamivpn.pro/AbCdEf123456')?.endpoint,
    ).toBe('https://sub.origamivpn.pro/api/report')
  })

  it('keeps the account name out of program paths', () => {
    const entry = {
      process: 'game.exe',
      path: 'C:\\Users\\Ivan\\Games\\game.exe',
      host: 'example.com',
      port: '443',
      network: 'tcp',
      rule: 'Match',
      rulePayload: '',
      chain: 'DIRECT',
      upload: 0,
      download: 0,
      failed: true,
    }
    const payload = buildPayload({
      kind: 'app',
      title: 't',
      comment: '',
      app: { version: '0', os: 'Windows' },
      seconds: 60,
      processes: ['game.exe'],
      entries: [entry],
      rules: [],
    })
    expect(payload.entries[0].path).toBe('C:\\Users\\*\\Games\\game.exe')
  })
})
