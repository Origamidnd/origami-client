import { ChevronRightRounded } from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'

import { useProxiesData } from '@/providers/app-data-context'
import {
  findCurrentGroupMember,
  type ProxyGroupView,
  type ProxyViewV1,
} from '@/types/proxy-view'

import type { FocusGroupState } from '../use-focus-group'

interface CurrentServer {
  group: ProxyGroupView
  name: string
  via?: string
  delay?: number
}

const lastDelay = (history: { delay: number }[]) => history.at(-1)?.delay

// Follows auto-select groups down to the node that actually carries traffic.
const resolveCurrent = (view: ProxyViewV1): CurrentServer | null => {
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

const delayTone = (delay?: number) => {
  if (!delay || delay <= 0 || delay >= 10000) return 'is-bad'
  if (delay < 200) return 'is-good'
  if (delay < 500) return 'is-mid'
  return 'is-bad'
}

export const ServerPlate = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { proxyView } = useProxiesData()
  const current = proxyView ? resolveCurrent(proxyView) : null

  const open = () => {
    const state: FocusGroupState = { origamiFocusGroup: current?.group.name }
    navigate('/proxies', { state })
  }

  return (
    <button type="button" className="o-plate o-server" onClick={open}>
      <div className="o-server__text">
        <div className="o-label">{t('origami.home.server.title')}</div>
        <div className="o-server__name">
          {current?.name ?? t('origami.home.server.none')}
        </div>
        {current?.via && (
          <div className="o-hint">
            {t('origami.home.server.via', { group: current.via })}
          </div>
        )}
      </div>
      {current?.delay !== undefined && (
        <span className={`o-ping o-mono ${delayTone(current.delay)}`}>
          {current.delay > 0 && current.delay < 10000
            ? t('origami.home.server.ping', { ms: current.delay })
            : t('origami.home.server.timeout')}
        </span>
      )}
      <ChevronRightRounded className="o-server__chevron" />
    </button>
  )
}
