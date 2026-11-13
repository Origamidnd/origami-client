import { ChevronRightRounded } from '@mui/icons-material'
import { useTranslation } from 'react-i18next'

import { PingBadge } from '../ping-badge'
import { withoutEmoji } from '../servers/service-names'

import { useCurrentServer, useOpenServers } from './use-open-servers'

export const ServerPlate = () => {
  const { t } = useTranslation()
  const current = useCurrentServer()
  const open = useOpenServers()

  return (
    <button type="button" className="o-plate o-server" onClick={open}>
      <div className="o-server__text">
        <div className="o-label">{t('origami.home.server.title')}</div>
        <div className="o-server__name">
          {current ? withoutEmoji(current.name) : t('origami.home.server.none')}
        </div>
        {/* The auto group's own name comes from the panel template; people only need to know
            the choice is automatic. */}
        {current?.via && (
          <div className="o-hint">{t('origami.home.server.auto')}</div>
        )}
        <div className="o-hint">{t('origami.home.server.hint')}</div>
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
