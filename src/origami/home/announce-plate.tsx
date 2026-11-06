import { CloseRounded, CampaignOutlined } from '@mui/icons-material'
import { IconButton } from '@mui/material'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useProfiles } from '@/hooks/use-profiles'

import { openSupportChat } from '../support-chat'

const DISMISSED_KEY = 'origami.dismissedAnnounce'

const readDismissed = () => {
  try {
    return localStorage.getItem(DISMISSED_KEY)
  } catch {
    return null
  }
}

/** Message from the provider, taken from the `announce` subscription header. */
export const AnnouncePlate = () => {
  const { t } = useTranslation()
  const { current } = useProfiles()
  const [dismissed, setDismissed] = useState(readDismissed)
  const text = current?.announce

  if (!text || text === dismissed) return null

  const dismiss = () => {
    setDismissed(text)
    try {
      localStorage.setItem(DISMISSED_KEY, text)
    } catch {
      // Without storage the message comes back on the next start.
    }
  }

  return (
    <section className="o-announce" role="status">
      <CampaignOutlined className="o-announce__icon" />
      <div className="o-announce__text">
        {text}
        {current?.support && (
          <button
            type="button"
            className="o-announce__link"
            onClick={() => void openSupportChat(current.support!)}
          >
            {t('origami.home.announce.support')}
          </button>
        )}
      </div>
      <IconButton
        size="small"
        aria-label={t('origami.home.announce.dismiss')}
        title={t('origami.home.announce.dismiss')}
        onClick={dismiss}
      >
        <CloseRounded fontSize="small" />
      </IconButton>
    </section>
  )
}
