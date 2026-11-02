import { LoginRounded } from '@mui/icons-material'
import { Button, TextField } from '@mui/material'
import { readText } from '@tauri-apps/plugin-clipboard-manager'
import { useLockFn } from 'ahooks'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useProfiles } from '@/hooks/use-profiles'
import { useAppRefreshers } from '@/providers/app-data-context'
import { enhanceProfiles, importProfile } from '@/services/cmds'
import { mutate } from '@/services/mutate'
import { showNotice } from '@/services/notice-service'
import { isValidUrl } from '@/utils/network'
import { openExternalUrl } from '@/utils/open-external-url'

import { explainSubscriptionError } from '../errors'
import { ORIGAMI_LINKS } from '../links'

const looksLikeSubscription = (text: string) =>
  /^https?:\/\/\S+$/.test(text) && isValidUrl(text)

/** First run: sign in through the cabinet or paste a subscription link. */
export const Welcome = () => {
  const { t } = useTranslation()
  const { mutateProfiles } = useProfiles()
  const { refreshAll } = useAppRefreshers()
  const [url, setUrl] = useState('')
  const [fromClipboard, setFromClipboard] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    readText()
      .then((text) => {
        const value = text?.trim() ?? ''
        if (!cancelled && looksLikeSubscription(value)) {
          setUrl((prev) => prev || value)
          setFromClipboard(true)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const add = useLockFn(async () => {
    const value = url.trim()
    if (!looksLikeSubscription(value)) {
      showNotice.error('origami.welcome.invalidLink')
      return
    }
    setLoading(true)
    try {
      await mutate(() => importProfile(value), {
        id: 'import-profile',
        errorNotice: false,
      })
      // The first imported subscription becomes current; the core has to load it.
      await enhanceProfiles()
      await mutateProfiles()
      await refreshAll()
      showNotice.success('origami.welcome.added')
    } catch (error) {
      const reason = explainSubscriptionError(error)
      if (reason) showNotice.error(reason)
      else showNotice.error('origami.welcome.addFailed', error)
    } finally {
      setLoading(false)
    }
  })

  return (
    <section className="o-plate o-welcome">
      <div className="o-big">{t('origami.welcome.title')}</div>
      <p className="o-hint">{t('origami.welcome.lead')}</p>

      <Button
        variant="contained"
        size="large"
        startIcon={<LoginRounded />}
        onClick={() => void openExternalUrl(ORIGAMI_LINKS.appLogin)}
      >
        {t('origami.welcome.login')}
      </Button>
      <p className="o-hint">{t('origami.welcome.loginHint')}</p>

      <div className="o-welcome__divider">
        <span>{t('origami.welcome.or')}</span>
      </div>

      <div className="o-welcome__link">
        <TextField
          fullWidth
          size="small"
          value={url}
          placeholder="https://sub.origamivpn.pro/..."
          label={t('origami.welcome.linkLabel')}
          helperText={fromClipboard ? t('origami.welcome.fromClipboard') : ' '}
          onChange={(event) => {
            setUrl(event.target.value)
            setFromClipboard(false)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void add()
          }}
        />
        <Button variant="outlined" disabled={loading} onClick={add}>
          {t('origami.welcome.add')}
        </Button>
      </div>

      <p className="o-hint">
        {t('origami.welcome.noSubscription')}{' '}
        <button
          type="button"
          className="o-announce__link"
          onClick={() => void openExternalUrl(ORIGAMI_LINKS.bot)}
        >
          {t('origami.welcome.openBot')}
        </button>
      </p>
    </section>
  )
}
