import { Button, Dialog, DialogActions, DialogContent } from '@mui/material'
import { useTranslation } from 'react-i18next'

import { openExternalUrl } from '@/utils/open-external-url'

import {
  closeDiagnosticsCopied,
  useDiagnosticsCopied,
} from './diagnostics-copied-store'

/** Mounted once, in the sidebar. */
export const DiagnosticsCopiedDialog = () => {
  const { t } = useTranslation()
  const url = useDiagnosticsCopied()

  if (!url) return null

  return (
    <Dialog
      open
      className="o-rep o-trouble"
      maxWidth="xs"
      fullWidth
      onClose={closeDiagnosticsCopied}
    >
      <DialogContent className="o-rep__body">
        <div className="o-trouble__title">{t('origami.check.copiedTitle')}</div>
        <p>{t('origami.check.copiedText')}</p>
      </DialogContent>
      <DialogActions>
        <Button onClick={closeDiagnosticsCopied}>
          {t('origami.check.copiedClose')}
        </Button>
        <Button
          variant="contained"
          onClick={() => {
            closeDiagnosticsCopied()
            void openExternalUrl(url)
          }}
        >
          {t('origami.check.copiedOpen')}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
