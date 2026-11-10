// «Сообщить о блокировке»: what the recording keeps, which rules to suggest and what is sent.
// The sub-page receiver (POST /api/report) forwards it to the owner's Telegram.

export type ReportKind = 'app' | 'site'

export interface ReportEntry {
  process: string
  path?: string
  host: string
  ip?: string
  port: string
  network: string
  rule: string
  rulePayload: string
  /** Proxy chain, e.g. "DIRECT" or "🔷 🇫🇮 Финляндия < 🚫 Заблокированные сервисы". */
  chain: string
  upload: number
  download: number
  /** The core logged an error for it, or it closed without receiving anything. */
  failed: boolean
  error?: string
}

const keyOf = (
  e: Pick<ReportEntry, 'process' | 'host' | 'ip' | 'port' | 'network'>,
) => [e.process, e.host, e.ip ?? '', e.port, e.network].join('|')

export const processName = (process?: string, path?: string) => {
  if (process) return process
  if (!path) return ''
  return path.split(/[\\/]/).pop() ?? ''
}

/** One entry per program and destination; bytes add up over its connections. */
export class EntryCollector {
  private entries = new Map<string, ReportEntry & { closed: boolean }>()
  private seen = new Map<string, { up: number; down: number }>()

  addConnection(item: IConnectionsItem, closed: boolean) {
    const meta = item.metadata
    const entry = {
      process: processName(meta.process, meta.processPath),
      path: meta.processPath || undefined,
      host: meta.host || '',
      ip: meta.destinationIP || meta.remoteDestination || undefined,
      port: meta.destinationPort || '',
      network: meta.network || '',
      rule: item.rule || '',
      rulePayload: item.rulePayload || '',
      chain: (item.chains ?? []).join(' < '),
    }
    // Connections report running totals: add only what grew since the last look at this id.
    const before = this.seen.get(item.id) ?? { up: 0, down: 0 }
    const up = Math.max(0, (item.upload ?? 0) - before.up)
    const down = Math.max(0, (item.download ?? 0) - before.down)
    this.seen.set(item.id, { up: item.upload ?? 0, down: item.download ?? 0 })

    const key = keyOf(entry)
    const existing = this.entries.get(key)
    if (existing) {
      existing.upload += up
      existing.download += down
      existing.closed ||= closed
      return
    }
    this.entries.set(key, {
      ...entry,
      upload: up,
      download: down,
      failed: false,
      closed,
    })
  }

  addLogError(failure: LogFailure) {
    const key = keyOf({
      process: failure.process,
      host: failure.host,
      ip: undefined,
      port: failure.port,
      network: failure.network,
    })
    const existing =
      this.entries.get(key) ??
      [...this.entries.values()].find(
        (e) => e.host === failure.host && e.port === failure.port,
      )
    if (existing) {
      existing.failed = true
      existing.error ??= failure.error
      return
    }
    this.entries.set(key, {
      closed: true,
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
    })
  }

  /** A destination failed when the core logged an error or every connection closed empty. */
  list(): ReportEntry[] {
    return [...this.entries.values()].map(({ closed, ...entry }) => ({
      ...entry,
      failed: entry.failed || (closed && entry.download === 0),
    }))
  }
}

export interface LogFailure {
  network: string
  process: string
  host: string
  port: string
  chain: string
  rule: string
  error: string
}

// [TCP] dial DIRECT (match RuleSet/games-direct) 192.168.1.5:54321(dota2.exe) --> api.steampowered.com:443 error: i/o timeout
const DIAL_ERROR =
  /\[(TCP|UDP)\]\s+dial\s+(.+?)\s+\(match\s+([^)]*)\)\s+\S+?:\d+(?:\(([^)]*)\))?\s+-->\s+(\S+):(\d+)\s+error:\s*(.+)$/

export const parseLogFailure = (payload: string): LogFailure | null => {
  const match = DIAL_ERROR.exec(payload)
  if (!match) return null
  const [, network, chain, rule, process = '', host, port, error] = match
  return {
    network: network.toLowerCase(),
    chain,
    rule,
    process,
    host,
    port,
    error: error.trim().slice(0, 160),
  }
}

export interface ProcessSummary {
  name: string
  total: number
  failed: number
}

export const summarizeProcesses = (
  entries: ReportEntry[],
): ProcessSummary[] => {
  const map = new Map<string, ProcessSummary>()
  for (const entry of entries) {
    const name = entry.process || ''
    const item = map.get(name) ?? { name, total: 0, failed: 0 }
    item.total += 1
    if (entry.failed) item.failed += 1
    map.set(name, item)
  }
  return [...map.values()].sort(
    (a, b) => b.failed - a.failed || b.total - a.total,
  )
}

const BROWSERS =
  /^(chrome|google-chrome|msedge|msedgewebview2|firefox|firefox-bin|opera|opera_gx|brave|brave-browser|browser|yandex|vivaldi|chromium|chromium-browser|librewolf|zen|zen-bin|thorium|arc|iexplore|safari|tor|waterfox|floorp|whale|maxthon)(\.exe)?$/i

export const isBrowser = (name: string) => BROWSERS.test(name)

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/[^a-zа-я0-9]/gi, '')

/** Programs to tick at the start: those that look like the name people typed, or browsers for a site. */
export const preselectProcesses = (
  kind: ReportKind,
  title: string,
  processes: ProcessSummary[],
): string[] => {
  const wanted = normalize(title)
  const picked = processes.filter((p) => {
    if (!p.name) return false
    if (kind === 'site') return isBrowser(p.name)
    const name = normalize(p.name)
    return !!wanted && (name.includes(wanted) || wanted.includes(name))
  })
  if (picked.length > 0 || kind === 'site') return picked.map((p) => p.name)
  // Nothing matched the typed name: the program with the most failures is the best guess.
  const failing = processes.find((p) => p.name && p.failed > 0)
  return failing ? [failing.name] : []
}

/** Turns "https://www.Example.com/path" or "example.com" into "example.com". */
export const siteDomain = (input: string) => {
  const raw = input.trim().toLowerCase()
  if (!raw) return ''
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`)
    return url.hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const hostMatches = (host: string, domain: string) =>
  !!domain && (host === domain || host.endsWith(`.${domain}`))

/** Entries that go into the report: chosen programs; for a site, its domain and anything that failed. */
export const selectEntries = (
  kind: ReportKind,
  entries: ReportEntry[],
  processes: string[],
  site = '',
) => {
  const chosen = new Set(processes)
  const domain = siteDomain(site)
  return entries.filter((entry) => {
    if (kind === 'app') return chosen.has(entry.process)
    if (hostMatches(entry.host, domain)) return true
    return chosen.has(entry.process) && entry.failed
  })
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

// Second-level public suffixes common for our users' sites; enough to avoid "co.uk"-style rules.
const PUBLIC_SECOND_LEVEL = new Set([
  'co.uk',
  'org.uk',
  'com.au',
  'com.br',
  'com.tr',
  'com.ua',
  'com.cn',
  'co.jp',
  'co.kr',
  'com.ru',
  'msk.ru',
  'spb.ru',
  'org.ru',
  'net.ru',
  'co.in',
  'com.kz',
  'appspot.com',
  'github.io',
  'cloudfront.net',
  'herokuapp.com',
  'vercel.app',
  'pages.dev',
  'workers.dev',
])

/** "api.cdn.steampowered.com" -> "steampowered.com". */
export const registrableDomain = (host: string) => {
  const labels = host
    .toLowerCase()
    .replace(/\.$/, '')
    .split('.')
    .filter(Boolean)
  if (labels.length <= 2) return labels.join('.')
  const lastTwo = labels.slice(-2).join('.')
  if (PUBLIC_SECOND_LEVEL.has(lastTwo)) return labels.slice(-3).join('.')
  return lastTwo
}

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const MAX_DOMAIN_RULES = 20
const MAX_IP_RULES = 10

/** Rules in the template's own format; the owner decides what to paste. */
export const suggestRules = (
  kind: ReportKind,
  entries: ReportEntry[],
  processes: string[],
  group: string,
) => {
  const rules: string[] = []
  if (kind === 'app') {
    for (const name of processes) {
      if (!name) continue
      rules.push(`PROCESS-NAME-REGEX,(?i)^${escapeRegex(name)}$,${group}`)
    }
  }
  const ordered = [...entries].sort(
    (a, b) => Number(b.failed) - Number(a.failed),
  )
  const domains = new Set<string>()
  const networks = new Set<string>()
  for (const entry of ordered) {
    const host = entry.host && !IPV4.test(entry.host) ? entry.host : ''
    if (host) {
      const domain = registrableDomain(host)
      if (domain && domains.size < MAX_DOMAIN_RULES) domains.add(domain)
      continue
    }
    const ip = IPV4.test(entry.host) ? entry.host : entry.ip
    if (ip && IPV4.test(ip) && networks.size < MAX_IP_RULES) {
      networks.add(ip.split('.').slice(0, 3).join('.') + '.0/24')
    }
  }
  for (const domain of domains) rules.push(`DOMAIN-SUFFIX,${domain},${group}`)
  for (const network of networks)
    rules.push(`IP-CIDR,${network},${group},no-resolve`)
  return rules
}

const MAX_ENTRIES = 200

export interface ReportPayload {
  version: 1
  kind: ReportKind
  title: string
  comment: string
  site?: string
  app: { version: string; os: string }
  service?: { name: string; now: string }
  seconds: number
  processes: string[]
  entries: ReportEntry[]
  rules: string[]
}

/** The name of the account on this computer stays here. */
export const maskUserFolder = (text: string) =>
  text
    .replace(/(\b[A-Za-z]:[\\/]+Users[\\/]+)[^\\/]+/g, '$1*')
    .replace(/(\/(?:home|Users)\/)[^/]+/g, '$1*')

/** A send that hangs would keep the button spinning for good. */
export const REPORT_TIMEOUT_MS = 20 * 1000

export const buildPayload = (
  input: Omit<ReportPayload, 'version'>,
): ReportPayload => ({
  version: 1,
  ...input,
  title: input.title.trim().slice(0, 80),
  comment: input.comment.trim().slice(0, 500),
  entries: input.entries.slice(0, MAX_ENTRIES).map((entry) => ({
    ...entry,
    path: entry.path ? maskUserFolder(entry.path) : undefined,
  })),
})

/** sub.origamivpn.pro/<shortUuid> -> where to send the report and as whom. */
export const reportTarget = (subscriptionUrl?: string | null) => {
  if (!subscriptionUrl) return null
  try {
    const url = new URL(subscriptionUrl)
    if (!/(^|\.)origamivpn\.pro$/.test(url.hostname)) return null
    const shortUuid = url.pathname.split('/').filter(Boolean)[0]
    if (!shortUuid) return null
    // Always https: the short id must not cross the network in the clear.
    return { endpoint: `https://${url.host}/api/report`, shortUuid }
  } catch {
    return null
  }
}
