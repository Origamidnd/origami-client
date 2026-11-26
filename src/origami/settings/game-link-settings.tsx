import { Button, TextField } from '@mui/material'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Switch } from '@/components/base'
import { useVerge } from '@/hooks/use-verge'
import { showNotice } from '@/services/notice-service'

/**
 * Game mode (test): the game's packets go over several paths at once (src-tauri core/game_link.rs).
 * The code holds the anchor's password and certificate pin, so it is typed in here and never shown
 * back in full.
 */
export const GameLinkSettings = () => {
  const { t } = useTranslation()
  const { verge, patchVerge } = useVerge()
  const enabled = verge?.origami_game_link?.enabled ?? false
  const savedCode = verge?.origami_game_link?.code ?? ''
  const [code, setCode] = useState('')

  const save = (next: { enabled: boolean; code: string }) =>
    patchVerge({ origami_game_link: next }).catch((err) =>
      showNotice.error(err),
    )

  return (
    <div className="o-set__gamelink">
      <div className="o-set__row">
        <div className="o-set__text">
          <div className="o-set__title">
            {t('origami.settings.gameLink.enable')}
          </div>
          <p className="o-hint">{t('origami.settings.gameLink.enableHint')}</p>
        </div>
        <div className="o-set__control">
          <Switch
            slotProps={{
              input: { 'aria-label': t('origami.settings.gameLink.enable') },
            }}
            checked={enabled}
            disabled={!savedCode}
            onChange={(_, on) => void save({ enabled: on, code: savedCode })}
          />
        </div>
      </div>
      <div className="o-set__row">
        <div className="o-set__text">
          <div className="o-set__title">
            {t('origami.settings.gameLink.code')}
          </div>
          <p className="o-hint">
            {savedCode
              ? t('origami.settings.gameLink.codeSaved')
              : t('origami.settings.gameLink.codeHint')}
          </p>
        </div>
      </div>
      <div className="o-set__row">
        <TextField
          size="small"
          type="password"
          fullWidth
          autoComplete="off"
          value={code}
          placeholder={t('origami.settings.gameLink.codePlaceholder')}
          onChange={(event) => setCode(event.target.value)}
        />
        <Button
          variant="outlined"
          disabled={!code.trim()}
          onClick={() => {
            void save({ enabled: true, code: code.trim() })
            setCode('')
          }}
        >
          {t('origami.settings.gameLink.save')}
        </Button>
      </div>
    </div>
  )
}
