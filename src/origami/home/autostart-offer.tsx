import { Button } from '@mui/material'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useVerge } from '@/hooks/use-verge'
import { showNotice } from '@/services/notice-service'

const ASKED_KEY = 'origami.autostartAsked'

const wasAsked = () => {
  try {
    return localStorage.getItem(ASKED_KEY) === '1'
  } catch {
    return true
  }
}

const markAsked = () => {
  try {
    localStorage.setItem(ASKED_KEY, '1')
  } catch {
    // Without storage the offer may come again next time.
  }
}

/**
 * New installs have autostart on; older ones kept it off by default, not by choice, so they are
 * asked once. Whoever has it on is never asked, even after turning it off in the settings later.
 */
export const AutostartOffer = () => {
  const { t } = useTranslation()
  const { verge, patchVerge } = useVerge()
  const enabled = verge?.enable_auto_launch
  const [asked, setAsked] = useState(wasAsked)

  useEffect(() => {
    if (enabled) markAsked()
  }, [enabled])

  if (asked || !verge || enabled) return null

  const answer = (yes: boolean) => {
    markAsked()
    setAsked(true)
    if (yes) {
      patchVerge({ enable_auto_launch: true }).catch((error) =>
        showNotice.error(error),
      )
    }
  }

  return (
    <section className="o-plate o-offer">
      <div>
        <b>{t('origami.home.autostart.title')}</b>
        <div className="o-hint">{t('origami.home.autostart.hint')}</div>
      </div>
      <div className="o-offer__actions">
        <Button size="small" onClick={() => answer(false)}>
          {t('origami.home.autostart.no')}
        </Button>
        <Button size="small" variant="contained" onClick={() => answer(true)}>
          {t('origami.home.autostart.yes')}
        </Button>
      </div>
    </section>
  )
}
