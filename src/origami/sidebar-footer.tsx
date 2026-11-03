import {
  AccountCircleOutlined,
  BuildOutlined,
  NorthEastRounded,
  Telegram,
} from '@mui/icons-material'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { DialogRef } from '@/components/base'
import { UpdateViewer } from '@/components/setting/mods/update-viewer'
import { useProfiles } from '@/hooks/use-profiles'
import { useUpdate } from '@/hooks/use-update'
import { openExternalUrl } from '@/utils/open-external-url'

import { setExpertMode, useExpertMode } from './expert-mode'
import { ORIGAMI_LINKS } from './links'
import { useAutoVariantWatch } from './servers/auto-variant'
import { useExpiryReminder } from './use-expiry-reminder'

// Replaces the stock red "New" badge that sat on top of the logo.
const UpdateItem = () => {
  const { t } = useTranslation()
  const viewerRef = useRef<DialogRef>(null)
  const { updateInfo } = useUpdate()

  if (!updateInfo?.available) return null

  return (
    <>
      <UpdateViewer ref={viewerRef} />
      <button
        type="button"
        className="origami-nav-footer__item origami-nav-footer__update"
        onClick={() => viewerRef.current?.open()}
      >
        <i className="origami-nav-footer__dot" aria-hidden="true" />
        <span>{t('origami.nav.update', { version: updateInfo.version })}</span>
      </button>
    </>
  )
}

export const OrigamiSidebarFooter = () => {
  const { t } = useTranslation()
  const expert = useExpertMode()
  // The sidebar is always mounted while the window is open, so it hosts background reminders.
  useExpiryReminder()
  useAutoVariantWatch()
  const { current } = useProfiles()
  const supportUrl = current?.support ?? ORIGAMI_LINKS.support

  const links = [
    {
      icon: <Telegram fontSize="small" />,
      label: 'origami.nav.support',
      url: supportUrl,
    },
    {
      icon: <AccountCircleOutlined fontSize="small" />,
      label: 'origami.nav.cabinet',
      url: ORIGAMI_LINKS.cabinet,
    },
  ] as const

  return (
    <div className="origami-nav-footer">
      <UpdateItem />
      <button
        type="button"
        role="switch"
        aria-checked={expert}
        className={`origami-nav-footer__item${expert ? ' is-on' : ''}`}
        onClick={() => setExpertMode(!expert)}
      >
        <BuildOutlined fontSize="small" />
        <span>{t('origami.nav.expert')}</span>
        <i className="origami-nav-footer__switch" aria-hidden="true" />
      </button>
      <div className="origami-nav-footer__rule" />
      {links.map((link) => (
        <button
          key={link.label}
          type="button"
          className="origami-nav-footer__item"
          title={t('origami.nav.external')}
          onClick={() => void openExternalUrl(link.url)}
        >
          {link.icon}
          <span>{t(link.label)}</span>
          <NorthEastRounded className="origami-nav-footer__out" />
        </button>
      ))}
    </div>
  )
}
