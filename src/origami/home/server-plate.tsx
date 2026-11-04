import { ChevronRightRounded } from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'

import { useProxiesData } from '@/providers/app-data-context'

import { resolveCurrent } from '../current-server'
import { PingBadge } from '../ping-badge'
import { withoutEmoji } from '../servers/service-names'
import type { FocusGroupState } from '../use-focus-group'

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
          {current ? withoutEmoji(current.name) : t('origami.home.server.none')}
        </div>
        {current?.via && (
          <div className="o-hint">
            {t('origami.home.server.via', { group: withoutEmoji(current.via) })}
          </div>
        )}
      </div>
      {current?.delay !== undefined && (
        <PingBadge
          delay={
            current.delay > 0 && current.delay < 10000 ? current.delay : null
          }
        />
      )}
      <ChevronRightRounded className="o-server__chevron" />
    </button>
  )
}
