import type { IOrigamiRoute } from '@/services/bindings'

export type RouteKind = 'app' | 'site'
export type RouteVia = 'direct' | 'vpn'

/** The selector "through the VPN" routes use; the core adds it (src-tauri enhance/origami_routes.rs). */
export const OWN_GROUP = '⭐ Свои правила'

/** A process name as the core reports it: the file name, without a folder. */
export const cleanProcess = (value: string) => {
  const name = (value.trim().split(/[/\\]/).pop() ?? '').trim()
  return name && !/[,\p{Cc}]/u.test(name) ? name : null
}

/** `https://www.Example.com/path` -> `example.com`; `*.example.com` -> `example.com`. */
export const cleanDomain = (value: string) => {
  let host = value.trim().toLowerCase()
  const scheme = host.indexOf('://')
  if (scheme >= 0) host = host.slice(scheme + 3)
  host = host.split(/[/?#]/)[0] ?? ''
  host = host.slice(host.lastIndexOf('@') + 1).split(':')[0] ?? ''
  // "www." would leave the bare domain and its other subdomains out of the rule.
  host = host
    .replace(/^\*\./, '')
    .replace(/^www\./, '')
    .replace(/^\.+|\.+$/g, '')
  return host && host.includes('.') && !/[,\s\p{Cc}]/u.test(host) ? host : null
}

export const cleanValue = (kind: RouteKind, value: string) =>
  kind === 'app' ? cleanProcess(value) : cleanDomain(value)

// Fields are optional in the generated type (serde defaults), so missing ones read as empty.
const sameTarget = (a: IOrigamiRoute, kind?: string, value = '') =>
  a.kind === kind && (a.value ?? '').toLowerCase() === value.toLowerCase()

/** Adds a route, or changes the way of one already there for the same app or site. */
export const upsertRoute = (
  routes: IOrigamiRoute[],
  route: IOrigamiRoute,
): IOrigamiRoute[] =>
  routes.some((item) => sameTarget(item, route.kind, route.value))
    ? routes.map((item) =>
        sameTarget(item, route.kind, route.value) ? route : item,
      )
    : [...routes, route]

// The VPN core and this client show up in the connection list too; they are not what people mean.
const OWN_PROCESSES = /^(verge-mihomo|mihomo|clash|origamivpn|clash-verge)/i

/** Programs seen in recent connections, busiest first, without the ones already routed. */
export const recentProcesses = (
  connections: IConnectionsItem[],
  routes: IOrigamiRoute[],
  limit = 8,
) => {
  const counts = new Map<string, number>()
  for (const item of connections) {
    const name = item.metadata.process
    if (!name || OWN_PROCESSES.test(name)) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([name]) => !routes.some((route) => sameTarget(route, 'app', name)))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name)
}
