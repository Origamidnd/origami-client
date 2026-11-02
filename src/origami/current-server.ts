import {
  findCurrentGroupMember,
  type ProxyGroupView,
  type ProxyViewV1,
} from '@/types/proxy-view'

export interface CurrentServer {
  group: ProxyGroupView
  name: string
  via?: string
  delay?: number
}

const lastDelay = (history: { delay: number }[]) => history.at(-1)?.delay

// Follows auto-select groups down to the node that actually carries traffic.
export const resolveCurrent = (view: ProxyViewV1): CurrentServer | null => {
  const group =
    view.groups.find((item) => !item.hidden && item.type === 'Selector') ??
    view.groups.find((item) => !item.hidden)
  if (!group) return null

  let current = group
  let via: string | undefined
  for (let depth = 0; depth < 4; depth++) {
    const found = findCurrentGroupMember(view, current)
    if (!found) return { group, name: current.now ?? group.name, via }
    const { member } = found
    if (member.kind === 'node') {
      return {
        group,
        name: member.node.name,
        via,
        delay: lastDelay(member.node.history),
      }
    }
    via ??= member.group.name
    current = member.group
  }
  return { group, name: current.now ?? current.name, via }
}
