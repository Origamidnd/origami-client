import { isOwnProcess } from '../routes/routes'

export interface ProgramStat {
  /** Process name; empty when the core could not tell which program opened the connection. */
  name: string
  /** The file, when the core could tell; shows what the program belongs to. */
  path?: string
  direct: number
  vpn: number
  /** Connections open right now, by how they go. */
  activeDirect: number
  activeVpn: number
  /** The server of its latest connection through the VPN. */
  server?: string
}

export interface TrafficState {
  // Bytes already counted for each open connection, so a repeated poll only adds what is new.
  seen: Map<string, number>
  programs: Map<string, ProgramStat>
}

export const emptyTraffic = (): TrafficState => ({
  seen: new Map(),
  programs: new Map(),
})

/**
 * Adds one snapshot of open connections to the running totals. The core reports totals per open
 * connection and forgets it when it closes, so the sums live here. `isDirect` tells a chain's last
 * hop that goes without a server.
 */
export const addSnapshot = (
  state: TrafficState,
  connections: IConnectionsItem[],
  isDirect: (node: string) => boolean,
): TrafficState => {
  const seen = new Map<string, number>()
  const programs = new Map(
    [...state.programs].map(([name, stat]) => [
      name,
      { ...stat, activeDirect: 0, activeVpn: 0 },
    ]),
  )

  for (const connection of connections) {
    const name = connection.metadata.process ?? ''
    if (isOwnProcess(name)) continue

    const bytes = (connection.upload ?? 0) + (connection.download ?? 0)
    const delta = Math.max(0, bytes - (state.seen.get(connection.id) ?? 0))
    seen.set(connection.id, bytes)

    const stat = programs.get(name) ?? {
      name,
      direct: 0,
      vpn: 0,
      activeDirect: 0,
      activeVpn: 0,
    }
    if (connection.metadata.processPath) {
      stat.path = connection.metadata.processPath
    }
    const node = connection.chains?.[0] ?? ''
    if (isDirect(node)) {
      stat.direct += delta
      stat.activeDirect += 1
    } else {
      stat.vpn += delta
      stat.activeVpn += 1
      if (node) stat.server = node
    }
    programs.set(name, stat)
  }

  return { seen, programs }
}

export type ProgramWay = 'vpn' | 'direct' | 'both' | 'idle'

/** How a program goes right now, by its open connections: the totals also hold what came before. */
export const programWay = (stat: ProgramStat): ProgramWay => {
  if (stat.activeDirect > 0 && stat.activeVpn > 0) return 'both'
  if (stat.activeVpn > 0) return 'vpn'
  if (stat.activeDirect > 0) return 'direct'
  return 'idle'
}

/** The given order; programs new since it was taken go last. */
export const keepOrder = (list: ProgramStat[], order: string[]) => {
  const place = new Map(order.map((name, index) => [name, index]))
  const at = (stat: ProgramStat) => place.get(stat.name) ?? order.length
  // A stable sort, so the new ones stay busiest first among themselves.
  return [...list].sort((a, b) => at(a) - at(b))
}

/** Busiest first; programs that have used no traffic yet go last, by name. */
export const sortPrograms = (programs: Iterable<ProgramStat>) =>
  [...programs].sort(
    (a, b) =>
      b.direct + b.vpn - (a.direct + a.vpn) || a.name.localeCompare(b.name),
  )
