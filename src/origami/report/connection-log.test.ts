import { describe, expect, it } from 'vitest'

import {
  ConnectionLog,
  connectionLines,
  connectionsForSending,
  defaultChosen,
  logTime,
  maskUserFolder,
  recentFailures,
  reportableCoreErrors,
  selectRows,
  withFailures,
} from './connection-log'

const START = Date.parse('2026-11-06T12:00:00Z')
const MINUTE = 60 * 1000

const conn = (
  id: string,
  process: string,
  host: string,
  download = 0,
  chains = ['Finland', 'Games'],
  extra: Partial<IConnectionsItem['metadata']> = {},
) =>
  ({
    id,
    metadata: {
      network: 'tcp',
      type: 'Tun',
      host,
      destinationIP: '1.2.3.4',
      destinationPort: '443',
      process,
      processPath: `C:\\Users\\tester\\Games\\${process}`,
      ...extra,
    },
    upload: 10,
    download,
    start: new Date(START).toISOString(),
    chains,
    rule: 'RuleSet',
    rulePayload: 'games',
  }) as unknown as IConnectionsItem

describe('ConnectionLog', () => {
  it('adds up bytes and connections of one destination', () => {
    const log = new ConnectionLog()
    log.add([conn('a', 'wow.exe', 'x.com', 100)], START)
    log.add([conn('a', 'wow.exe', 'x.com', 300)], START + 5000)
    log.add(
      [conn('a', 'wow.exe', 'x.com', 300), conn('b', 'wow.exe', 'x.com', 50)],
      START + 10000,
    )
    const [row] = log.list(START + 10000)
    expect(row.count).toBe(2)
    expect(row.download).toBe(350)
    expect(row.open).toBe(true)
    expect(row.failed).toBe(false)
  })

  it('keeps a changed server as its own row, so the change can be seen', () => {
    const log = new ConnectionLog()
    log.add([conn('a', 'wow.exe', 'x.com', 5, ['Finland', 'Games'])], START)
    log.add(
      [conn('b', 'wow.exe', 'x.com', 5, ['Turkey', 'Games'])],
      START + 5000,
    )
    const rows = log.list(START + 5000)
    const byChain = (chain: string) => rows.find((row) => row.chain === chain)
    expect(rows).toHaveLength(2)
    expect(byChain('Turkey < Games')?.open).toBe(true)
    expect(byChain('Finland < Games')?.open).toBe(false)
  })

  it('takes a connection closed without an answer for failed', () => {
    const log = new ConnectionLog()
    log.add([conn('a', 'wow.exe', 'x.com', 0)], START)
    log.add([], START + 5000)
    expect(log.list(START + 5000)[0].failed).toBe(true)
  })

  it('does not call a connection open when polling has stopped', () => {
    const log = new ConnectionLog()
    log.add([conn('a', 'wow.exe', 'x.com', 5)], START)
    expect(log.list(START + 5 * MINUTE)[0].open).toBe(false)
  })

  it('forgets what closed long ago', () => {
    const log = new ConnectionLog()
    log.add([conn('a', 'wow.exe', 'x.com', 5)], START)
    log.add([], START + 5000)
    expect(log.list(START + 14 * MINUTE)).toHaveLength(1)
    expect(log.list(START + 16 * MINUTE)).toHaveLength(0)
    log.add([], START + 16 * MINUTE)
    expect(log.list(START + 16 * MINUTE)).toHaveLength(0)
  })

  it('leaves out the core and this app', () => {
    const log = new ConnectionLog()
    log.add(
      [
        conn('a', '', 'dns.google', 5, ['DIRECT'], { type: 'Inner' }),
        conn('b', 'origamivpn.exe', 'x.com', 5),
      ],
      START,
    )
    expect(log.list(START)).toHaveLength(0)
  })

  it('stays within its size', () => {
    const log = new ConnectionLog()
    for (let i = 0; i < 1100; i += 1) {
      log.add([conn(String(i), 'app.exe', `h${i}.com`, 5)], START + i)
    }
    expect(log.list(START + 1100).length).toBeLessThanOrEqual(1000)
  })
})

describe('what is sent', () => {
  const rows = () => {
    const log = new ConnectionLog()
    log.add(
      [
        conn('a', 'wow.exe', 'x.com', 5),
        conn('b', 'chrome.exe', 'private.example', 5),
        conn('c', 'chrome.exe', 'broken.example', 0),
        conn('d', '', 'unknown.example', 5),
        conn('e', 'telegram.exe', 'tg.example', 5),
      ],
      START,
    )
    log.add(
      [
        conn('a', 'wow.exe', 'x.com', 5),
        conn('b', 'chrome.exe', 'private.example', 5),
        conn('d', '', 'unknown.example', 5),
        conn('e', 'telegram.exe', 'tg.example', 5),
      ],
      START + 5000,
    )
    return log.list(START + 5000)
  }

  it('ticks everything except browsers', () => {
    expect(defaultChosen(rows()).sort()).toEqual(['telegram.exe', 'wow.exe'])
  })

  it('takes only logged errors from a browser left unticked', () => {
    const data = withFailures(rows(), [
      {
        network: 'tcp',
        process: 'chrome.exe',
        host: 'logged.example',
        port: '443',
        chain: 'DIRECT',
        rule: 'Match',
        error: 'i/o timeout',
        at: START,
      },
    ])
    const hosts = selectRows(data, defaultChosen(data)).map((row) => row.host)
    expect(hosts).toContain('x.com')
    expect(hosts).toContain('logged.example')
    expect(hosts).not.toContain('private.example')
    expect(hosts).not.toContain('unknown.example')
    // Closed empty, which a browser does with a connection it opened ahead and did not use.
    expect(hosts).not.toContain('broken.example')
  })

  it('takes a browser in full when it is ticked', () => {
    const hosts = selectRows(rows(), ['chrome.exe']).map((row) => row.host)
    expect(hosts).toContain('private.example')
    expect(hosts).not.toContain('x.com')
  })

  it('leaves out a program when it is unticked', () => {
    const data = rows()
    const chosen = defaultChosen(data).filter((n) => n !== 'telegram.exe')
    expect(selectRows(data, chosen).map((row) => row.host)).not.toContain(
      'tg.example',
    )
  })

  it('hides the account name in paths and rules', () => {
    expect(maskUserFolder('C:\\Users\\tester\\Games\\a.exe')).toBe(
      'C:\\Users\\*\\Games\\a.exe',
    )
    expect(maskUserFolder('(?i)^C:\\\\Users\\\\tester\\\\Games\\\\.*')).toBe(
      '(?i)^C:\\\\Users\\\\*\\\\Games\\\\.*',
    )
    expect(maskUserFolder('/home/tester/game/a')).toBe('/home/*/game/a')
    const [row] = connectionsForSending(rows())
    expect(row.path).toContain('Users\\*\\')
    expect(JSON.stringify(connectionsForSending(rows()))).not.toContain(
      'tester',
    )
  })

  it('puts failures first and stays within the limit', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      ...rows()[0],
      host: `h${i}`,
      failed: i === 399,
      last: START + i,
    }))
    const sent = connectionsForSending(many)
    expect(sent).toHaveLength(300)
    expect(sent[0].host).toBe('h399')
    expect(connectionLines(many)).toHaveLength(30)
  })
})

describe('core log', () => {
  const NOW = new Date(2026, 10, 6, 12, 0, 0).getTime()
  const line = (process: string, host: string) =>
    `[TCP] dial Games (match RuleSet/x) 127.0.0.1:5(${process}) --> ${host}:443 error: i/o timeout`

  it('reads the time of a line', () => {
    expect(logTime('11-06 11:59:30', NOW)).toBe(NOW - 30000)
    expect(logTime('12-31 23:59:00', NOW)).toBeLessThan(NOW)
    expect(logTime('no time', NOW)).toBeNull()
    expect(logTime(undefined, NOW)).toBeNull()
  })

  it('adds a failure to its connection or as a new one', () => {
    const logs = [
      {
        type: 'warning',
        time: '11-06 11:59:00',
        payload: line('a.exe', 'new.com'),
      },
      {
        type: 'warning',
        time: '10-06 11:59:00',
        payload: line('a.exe', 'old.com'),
      },
    ]
    const failures = recentFailures(logs, NOW)
    expect(failures).toHaveLength(1)
    const rows = withFailures([], failures)
    expect(rows[0].host).toBe('new.com')
    expect(rows[0].failed).toBe(true)
    expect(rows[0].error).toBe('i/o timeout')
  })

  it('keeps out the addresses of an unticked program and old ones', () => {
    const time = '11-06 11:59:00'
    const logs = [
      { type: 'error', time, payload: 'plain core trouble' },
      { type: 'warning', time, payload: line('wow.exe', 'ok.com') },
      { type: 'warning', time, payload: line('secret.exe', 'secret.com') },
      { type: 'warning', time, payload: line('chrome.exe', 'broken.com') },
      {
        type: 'warning',
        time: '10-06 11:59:00',
        payload: line('wow.exe', 'old.com'),
      },
      { type: 'warning', time, payload: 'unknown form a --> secret.org' },
      { type: 'info', time, payload: 'not an error' },
    ]
    const text = reportableCoreErrors(logs, ['wow.exe'], NOW).join('\n')
    expect(text).toContain('plain core trouble')
    expect(text).toContain('ok.com')
    expect(text).toContain('broken.com')
    expect(text).not.toContain('secret')
    expect(text).not.toContain('old.com')
    expect(text).not.toContain('not an error')
  })
})
