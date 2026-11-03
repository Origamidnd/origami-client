import delayManager from '@/services/delay'
import {
  resolveMember,
  type InteractableProxyMember,
  type ProxyGroupView,
  type ProxyNodeView,
  type ProxyViewV1,
} from '@/types/proxy-view'
import { DEFAULT_DELAY_TIMEOUT } from '@/utils/delay'

// Delays measured by the simple Servers tab and the background variant check share one key,
// separate from the stock page's groups.
export const CHECK_KEY = 'origami-servers'

const AUTO_TYPES = new Set(['URLTest', 'Fallback', 'LoadBalance'])

export interface Service {
  group: ProxyGroupView
  auto?: ProxyGroupView
  direct?: ProxyNodeView
  servers: InteractableProxyMember[]
}

/** Every visible selector of the subscription, with its Auto, Direct and server members apart. */
export const buildServices = (view: ProxyViewV1): Service[] =>
  view.groups
    .filter((group) => !group.hidden && group.type === 'Selector')
    .map((group) => {
      const service: Service = { group, servers: [] }
      for (const ref of group.members) {
        const member = resolveMember(view, ref)
        if (member.kind === 'unresolved') continue
        if (member.kind === 'group') {
          if (AUTO_TYPES.has(member.group.type)) service.auto ??= member.group
          else service.servers.push(member)
        } else if (member.node.type === 'Direct') {
          service.direct ??= member.node
        } else {
          service.servers.push(member)
        }
      }
      return service
    })

export const memberName = (member: InteractableProxyMember) => member.ref.name

export const memberType = (member: InteractableProxyMember) =>
  member.kind === 'node' ? member.node.type : member.group.type

// Built-in outbounds have no server behind them, so they are not pinged or counted.
const NOT_SERVERS = new Set([
  'Direct',
  'Reject',
  'RejectDrop',
  'Pass',
  'Dns',
  'Compatible',
])

export const isServer = (member: InteractableProxyMember) =>
  member.kind === 'node' && !NOT_SERVERS.has(member.node.type)

// "🔷 🇪🇪 Эстония (Hysteria2)" -> "Эстония (Hysteria2)" for notices.
export const serverLabel = (name: string) =>
  name.replace(/^[^\p{L}\p{N}]+/u, '').trim() || name

/** null when the server did not answer, undefined when it was not checked yet. */
export const readDelay = (
  member: InteractableProxyMember,
): number | null | undefined => {
  const delay = delayManager.getDelayFix(member, CHECK_KEY)
  if (delay === -2) return undefined
  if (delay < 0) return undefined
  if (delay === 0 || delay >= DEFAULT_DELAY_TIMEOUT) return null
  return delay
}

/** The service's servers in the shape the country model works with. */
export const serverOptions = (service: Service) =>
  service.servers.map((member) => ({
    name: memberName(member),
    type: memberType(member),
    delay: readDelay(member),
  }))
