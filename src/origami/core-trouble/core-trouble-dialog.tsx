import { SendRounded } from '@mui/icons-material'
import { Button, Dialog, DialogActions, DialogContent } from '@mui/material'
import { useLockFn } from 'ahooks'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useProfiles } from '@/hooks/use-profiles'
import { reinstallService, restartCore, updateProfile } from '@/services/cmds'
import { mutate } from '@/services/mutate'
import { showNotice } from '@/services/notice-service'

import { openSendDiagnostics } from '../check/send-diagnostics-store'

import { closeCoreTrouble, useCoreTrouble } from './store'

/** Plain-words dialog for a core that would not start or stopped, with the fixes that usually work. */
export const CoreTroubleDialog = () => {
  const { t } = useTranslation()
  const trouble = useCoreTrouble()
  const { current } = useProfiles()
  const [busy, setBusy] = useState(false)
  const [details, setDetails] = useState(false)

  const attempt = useLockFn(async (fix: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fix()
      closeCoreTrouble()
      showNotice.success('origami.coreTrouble.fixed')
    } catch (error) {
      showNotice.error(error)
    } finally {
      setBusy(false)
    }
  })

  if (!trouble) return null

  const restart = () =>
    attempt(() =>
      mutate(() => restartCore(), { id: 'restart-core', errorNotice: false }),
    )

  const reinstall = () =>
    attempt(async () => {
      await mutate(() => reinstallService(), {
        id: 'reinstall-service',
        errorNotice: false,
      })
      await mutate(() => restartCore(), {
        id: 'restart-core',
        errorNotice: false,
      })
    })

  const refresh = () =>
    attempt(async () => {
      if (!current?.uid) return
      await updateProfile(current.uid, current.option ?? undefined)
    })

  return (
    <Dialog
      open
      className="o-rep o-trouble"
      maxWidth="xs"
      fullWidth
      onClose={busy ? undefined : closeCoreTrouble}
    >
      <DialogContent className="o-rep__body">
        <div className="o-trouble__title">{t('origami.coreTrouble.title')}</div>
        <p>{t(`origami.coreTrouble.${trouble.kind}`)}</p>
        <div className="o-trouble__fixes">
          {trouble.kind === 'config' ? (
            <Button variant="contained" disabled={busy} onClick={refresh}>
              {t('origami.coreTrouble.refresh')}
            </Button>
          ) : (
            <Button variant="contained" disabled={busy} onClick={restart}>
              {t('origami.coreTrouble.restart')}
            </Button>
          )}
          {trouble.kind !== 'config' && (
            <Button variant="outlined" disabled={busy} onClick={reinstall}>
              {t('origami.coreTrouble.reinstall')}
            </Button>
          )}
        </div>
        <p className="o-hint">{t('origami.coreTrouble.stillBroken')}</p>
        {trouble.detail && (
          <>
            <button
              type="button"
              className="o-srv__link"
              onClick={() => setDetails(!details)}
            >
              {t('origami.coreTrouble.details')}
            </button>
            {details && (
              <pre className="o-trouble__detail">{trouble.detail}</pre>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button
          startIcon={<SendRounded />}
          disabled={busy}
          onClick={() => openSendDiagnostics()}
        >
          {t('origami.coreTrouble.send')}
        </Button>
        <Button disabled={busy} onClick={closeCoreTrouble}>
          {t('origami.coreTrouble.close')}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
