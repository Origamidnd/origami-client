import { Button, Dialog, DialogActions, DialogContent } from '@mui/material'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

const SEEN_KEY = 'origami.trayHintSeen'

const wasSeen = () => {
  try {
    return localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return true
  }
}

const markSeen = () => {
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch {
    // Without storage the hint may come again next time.
  }
}

/**
 * The window's close button only hides it and the VPN goes on. The first time, this is said out
 * loud; a window that silently vanishes looks like the app has stopped, or crashed.
 */
export const useTrayHint = (close: () => unknown) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const guardedClose = () => {
    if (wasSeen()) void close()
    else setOpen(true)
  }

  const understood = () => {
    markSeen()
    setOpen(false)
    void close()
  }

  const trayHint = open ? (
    <Dialog
      open
      className="o-rep o-trouble"
      maxWidth="xs"
      fullWidth
      onClose={() => setOpen(false)}
    >
      <DialogContent className="o-rep__body">
        <div className="o-trouble__title">{t('origami.trayHint.title')}</div>
        <p>{t('origami.trayHint.text')}</p>
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={understood}>
          {t('origami.trayHint.ok')}
        </Button>
      </DialogActions>
    </Dialog>
  ) : null

  return { guardedClose, trayHint }
}
