import {
  AccountCircleOutlined,
  BuildOutlined,
  Telegram,
} from '@mui/icons-material'
import { useTranslation } from 'react-i18next'

import { useProfiles } from '@/hooks/use-profiles'
import { openExternalUrl } from '@/utils/open-external-url'

import { setExpertMode, useExpertMode } from './expert-mode'
import { ORIGAMI_LINKS } from './links'

export const OrigamiSidebarFooter = () => {
  const { t } = useTranslation()
  const expert = useExpertMode()
  const { current } = useProfiles()
  const supportUrl = current?.support ?? ORIGAMI_LINKS.support

  return (
    <div className="origami-nav-footer">
      <button
        type="button"
        className={`origami-nav-footer__item${expert ? ' is-on' : ''}`}
        aria-pressed={expert}
        onClick={() => setExpertMode(!expert)}
      >
        <BuildOutlined fontSize="small" />
        <span>{t('origami.nav.expert')}</span>
      </button>
      <button
        type="button"
        className="origami-nav-footer__item"
        onClick={() => void openExternalUrl(supportUrl)}
      >
        <Telegram fontSize="small" />
        <span>{t('origami.nav.support')}</span>
      </button>
      <button
        type="button"
        className="origami-nav-footer__item"
        onClick={() => void openExternalUrl(ORIGAMI_LINKS.cabinet)}
      >
        <AccountCircleOutlined fontSize="small" />
        <span>{t('origami.nav.cabinet')}</span>
      </button>
    </div>
  )
}
