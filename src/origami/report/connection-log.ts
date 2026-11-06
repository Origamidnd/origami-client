import dayjs from 'dayjs'

import { isOwnProcess } from '../routes/routes'

import {
  isBrowser,
  parseLogFailure,
  processName,
  type LogFailure,
  type ReportEntry,
} from './model'

// What the program did lately, for a report sent after the trouble has already happened. Kept in
// memory only and never written to disk, so it is gone when the app closes.

export const LOG_WINDOW_MINUTES = 15
const LOG_WINDOW_MS = LOG_WINDOW_MINUTES * 60 * 1000
const MAX_ROWS = 1000
// Polling stops with the VPN, and then nothing says that the open connections have closed.
const OPEN_FRESH_MS = 20 * 1000
const MAX_SENT_ROWS = 300
const MAX_PASTED_ROWS = 30

/** One program, destination and way; the way is part of it, as a changed server is often the cause. */
export interface LoggedConnection extends ReportEntry {
  /** Connections seen, which is more than one when the program keeps reconnecting. */
  count: number
  first: number
  last: number
  open: boolean
}

interface Row extends Omit<LoggedConnection, 'open' | 'failed'> {
  closed: number
}

interface LiveConnection {
  key: string
  up: number
  down: number
}

const keyOf = (
  process: string,
  host: string,
  ip: string,
  port: string,
  network: string,
  chain: string,
) => [process, host, ip, port, network, chain].join('|')

export class ConnectionLog {
  private rows = new Map<string, Row>()
  private live = new Map<string, LiveConnection>()

  /** One snapshot of the open connections. One that opens and closes between two is not seen. */
  add(connections: IConnectionsItem[], now: number) {
    const live = new Map<string, LiveConnection>()
    for (const item of connections) {
      const meta = item.metadata
      const process = processName(meta.process, meta.processPath)
      // The core's own lookups and this app say nothing about a program of the person.
      if (meta.type === 'Inner' || isOwnProcess(process)) continue
      const host = meta.host || ''
      const ip = meta.destinationIP || meta.remoteDestination || ''
      const port = meta.destinationPort || ''
      const network = meta.network || ''
      const chain = (item.chains ?? []).join(' < ')
      const key = keyOf(process, host, ip, port, network, chain)
      const row = this.rows.get(key) ?? {
        process,
        path: meta.processPath || undefined,
        host,
        ip: ip || undefined,
        port,
        network,
        rule: item.rule || '',
        rulePayload: item.rulePayload || '',
        chain,
        upload: 0,
        download: 0,
        count: 0,
        closed: 0,
        first: Date.parse(item.start) || now,
        last: now,
      }
      this.rows.set(key, row)
      const before = this.live.get(item.id)
      if (!before) row.count += 1
      const up = item.upload ?? 0
      const down = item.download ?? 0
      row.upload += Math.max(0, up - (before?.up ?? 0))
      row.download += Math.max(0, down - (before?.down ?? 0))
      row.last = now
      live.set(item.id, { key, up, down })
    }
    for (const [id, gone] of this.live) {
      if (live.has(id)) continue
      const row = this.rows.get(gone.key)
      if (!row) continue
      row.closed += 1
      row.last = now
    }
    this.live = live
    this.prune(now)
  }

  private prune(now: number) {
    const open = new Set([...this.live.values()].map(({ key }) => key))
    for (const [key, row] of this.rows) {
      if (!open.has(key) && now - row.last > LOG_WINDOW_MS)
        this.rows.delete(key)
    }
    if (this.rows.size <= MAX_ROWS) return
    const oldest = [...this.rows]
      .filter(([key]) => !open.has(key))
      .sort(([, a], [, b]) => a.last - b.last)
    for (const [key] of oldest.slice(0, this.rows.size - MAX_ROWS)) {
      this.rows.delete(key)
    }
  }

  /** Newest first. Closed without receiving anything counts as failed, as in a recording. */
  list(now: number): LoggedConnection[] {
    const open = new Set([...this.live.values()].map(({ key }) => key))
    return [...this.rows]
      .filter(([key, row]) => open.has(key) || now - row.last <= LOG_WINDOW_MS)
      .map(([key, { closed, ...row }]) => ({
        ...row,
        open: open.has(key) && now - row.last <= OPEN_FRESH_MS,
        failed: closed > 0 && row.download === 0 && !open.has(key),
      }))
      .sort((a, b) => b.last - a.last)
  }

  clear() {
    this.rows.clear()
    this.live.clear()
  }
}

/** Mounted polling feeds it all the time while the VPN is on. */
export const connectionLog = new ConnectionLog()

/** The core writes "MM-DD HH:mm:ss" without a year. */
export const logTime = (time: string | undefined, now: number) => {
  if (!time) return null
  const short = /^(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(time)
  if (!short) {
    const parsed = Date.parse(time)
    return Number.isNaN(parsed) ? null : parsed
  }
  const [month, day, hour, minute, second] = short.slice(1).map(Number)
  const year = new Date(now).getFullYear()
  const at = new Date(year, month - 1, day, hour, minute, second).getTime()
  // Just after the New Year the last lines are from the year before.
  return at > now + 24 * 60 * 60 * 1000
    ? new Date(year - 1, month - 1, day, hour, minute, second).getTime()
    : at
}

export type TimedFailure = LogFailure & { at: number }

export const recentFailures = (logs: ILogItem[], now: number) =>
  logs.flatMap((log): TimedFailure[] => {
    const failure = parseLogFailure(log.payload)
    const at = logTime(log.time, now)
    if (!failure || at === null || now - at > LOG_WINDOW_MS) return []
    return [{ ...failure, at }]
  })

/** Adds what the core logged, which also catches a connection too short for a snapshot. */
export const withFailures = (
  rows: LoggedConnection[],
  failures: TimedFailure[],
) => {
  const result = rows.map((row) => ({ ...row }))
  for (const failure of failures) {
    const row = result.find(
      (item) =>
        item.host === failure.host &&
        item.port === failure.port &&
        (!failure.process || item.process === failure.process),
    )
    if (row) {
      row.failed = true
      row.error ??= failure.error
      continue
    }
    result.push({
      process: failure.process,
      host: failure.host,
      port: failure.port,
      network: failure.network,
      rule: failure.rule,
      rulePayload: '',
      chain: failure.chain,
      upload: 0,
      download: 0,
      failed: true,
      error: failure.error,
      count: 1,
      first: failure.at,
      last: failure.at,
      open: false,
    })
  }
  return result
}

/** A connection without a program may well be a browser, so it is treated like one. */
const isPrivateByDefault = (process: string) => !process || isBrowser(process)

export const defaultChosen = (rows: LoggedConnection[]) => [
  ...new Set(
    rows
      .map((row) => row.process)
      .filter((process) => !isPrivateByDefault(process)),
  ),
]

/**
 * Ticked programs in full; from a browser left unticked only what the core logged as an error. A
 * browser often opens a connection ahead and closes it unused, so closing empty proves nothing and
 * would give away a site it merely looked at.
 */
export const selectRows = (rows: LoggedConnection[], chosen: string[]) => {
  const ticked = new Set(chosen)
  return rows.filter(
    (row) =>
      ticked.has(row.process) ||
      (isPrivateByDefault(row.process) && !!row.error),
  )
}

/** Core errors, without the addresses of a program left unticked or older than the window. */
export const reportableCoreErrors = (
  logs: ILogItem[],
  chosen: string[],
  now: number,
) => {
  const ticked = new Set(chosen)
  return logs
    .filter((log) => log.type === 'error' || log.type === 'warning')
    .filter((log) => {
      const failure = parseLogFailure(log.payload)
      if (!failure) return !log.payload.includes('-->')
      const at = logTime(log.time, now)
      if (at === null || now - at > LOG_WINDOW_MS) return false
      return ticked.has(failure.process) || isPrivateByDefault(failure.process)
    })
    .map((log) => `${log.time ?? ''} ${log.payload}`.trim())
}

/** The name of the account on this computer stays here. */
export const maskUserFolder = (text: string) =>
  text
    .replace(/(\b[A-Za-z]:[\\/]+Users[\\/]+)[^\\/]+/g, '$1*')
    .replace(/(\/(?:home|Users)\/)[^/]+/g, '$1*')

const failedFirst = (rows: LoggedConnection[]) =>
  [...rows].sort(
    (a, b) => Number(b.failed) - Number(a.failed) || b.last - a.last,
  )

export interface SentConnection
  extends Omit<LoggedConnection, 'first' | 'last'> {
  first: string
  last: string
}

export const connectionsForSending = (
  rows: LoggedConnection[],
): SentConnection[] =>
  failedFirst(rows)
    .slice(0, MAX_SENT_ROWS)
    .map((row) => ({
      ...row,
      process: row.process.slice(0, 120),
      path: row.path ? maskUserFolder(row.path).slice(0, 300) : undefined,
      host: row.host.slice(0, 255),
      ip: row.ip?.slice(0, 64),
      port: row.port.slice(0, 8),
      network: row.network.slice(0, 8),
      rule: row.rule.slice(0, 64),
      rulePayload: maskUserFolder(row.rulePayload).slice(0, 200),
      chain: row.chain.slice(0, 300),
      error: row.error?.slice(0, 200),
      first: new Date(row.first).toISOString(),
      last: new Date(row.last).toISOString(),
    }))

/** Short lines for a report pasted into a chat by hand. */
export const connectionLines = (rows: LoggedConnection[]) =>
  failedFirst(rows)
    .slice(0, MAX_PASTED_ROWS)
    .map((row) => {
      const where = `${row.host || row.ip || '?'}:${row.port}${row.network === 'udp' ? ' udp' : ''}`
      const times = row.count > 1 ? `, ${row.count} раз` : ''
      const until = `${dayjs(row.first).format('HH:mm:ss')}-${dayjs(row.last).format('HH:mm:ss')}`
      const result = row.failed
        ? `, ошибка${row.error ? `: ${row.error}` : ''}`
        : row.open
          ? ', открыто'
          : ''
      return `${row.process || '?'} ${where} -> ${row.chain || '?'} (${row.rule}), ${until}${times}${result}`
    })

export const MAX_DIAGNOSTICS_TEXT = 8000

export interface DiagnosticsPayload {
  version: 1
  comment: string
  app: { version: string; os: string }
  minutes: number
  /** The plain report: state of the app, checks and core errors. */
  text: string
  /** What each group uses right now, as a choice in one group often explains a disconnect. */
  groups: { name: string; now: string }[]
  programs: string[]
  connections: SentConnection[]
}
