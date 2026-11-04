import {
  ContentCopyRounded,
  ExpandMoreRounded,
  Telegram,
} from '@mui/icons-material'
import { Button, MenuItem, Select } from '@mui/material'
import { useLockFn } from 'ahooks'
import dayjs from 'dayjs'
import { type ReactNode, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { DialogRef, Switch } from '@/components/base'
import { UpdateViewer } from '@/components/setting/mods/update-viewer'
import { useSystemState } from '@/hooks/use-system-state'
import { readLastCheckTime, updateLastCheckTime } from '@/hooks/use-update'
import { useVerge } from '@/hooks/use-verge'
import { useWindowDecorations } from '@/hooks/use-window'
import { exitApp, reinstallService, restartCore } from '@/services/cmds'
import { supportedLanguages } from '@/services/i18n'
import { mutate } from '@/services/mutate'
import { showNotice } from '@/services/notice-service'
import { requestService } from '@/services/service-request'
import { checkUpdateSafe } from '@/services/update'
import { openExternalUrl } from '@/utils/open-external-url'
import { version } from '@root/package.json'

import { useCopyDiagnostics } from '../check/use-copy-diagnostics'
import { setExpertMode, useExpertMode } from '../expert-mode'
import { ORIGAMI_LINKS } from '../links'
import { usePackageManager } from '../use-package-manager'

// Native names, so people find their language whatever the current one is.
const LANGUAGE_NAMES: Record<string, string> = {
  ru: 'Русский',
  en: 'English',
  tt: 'Татар',
  de: 'Deutsch',
  es: 'Español',
  pt: 'Português',
  tr: 'Türkçe',
  fa: 'فارسی',
  ar: 'العربية',
  id: 'Bahasa Indonesia',
  ko: '한국어',
  jp: '日本語',
  zh: '简体中文',
  zhtw: '繁體中文',
}

const THEMES = ['light', 'dark', 'system'] as const

interface RowProps {
  title: string
  hint?: string
  children?: ReactNode
}

const Row = ({ title, hint, children }: RowProps) => (
  <div className="o-set__row">
    <div className="o-set__text">
      <div className="o-set__title">{title}</div>
      {hint && <p className="o-hint">{hint}</p>}
    </div>
    {children && <div className="o-set__control">{children}</div>}
  </div>
)

const Section = ({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) => (
  <section className="o-plate o-set__plate">
    <div className="o-set__label">{label}</div>
    {children}
  </section>
)

/** Settings for everyone; the stock sections stay behind expert mode. */
/** `children` go right under the expert switch: the stock settings, when expert mode is on. */
export const OrigamiSettings = ({ children }: { children?: ReactNode }) => {
  const { t } = useTranslation()
  const { verge, patchVerge } = useVerge()
  const { decorated, toggleDecorations } = useWindowDecorations()
  const { runState } = useSystemState()
  const expert = useExpertMode()
  const copyDiagnostics = useCopyDiagnostics()
  const updateRef = useRef<DialogRef>(null)
  const packageManager = usePackageManager()

  const patch = (value: Partial<IVergeConfig>) =>
    patchVerge(value).catch((err) => showNotice.error(err))

  const serviceOk = runState.serviceUsable

  const fixService = useLockFn(async () => {
    if (!serviceOk) {
      requestService({ reason: 'tunNeedsService' })
      return
    }
    showNotice.info('settings.statuses.clashService.installing')
    const result = await mutate(() => reinstallService(), {
      id: 'reinstall-service',
      errorNotice: false,
    }).catch((err) => {
      showNotice.error(err)
      return null
    })
    if (!result?.ok) return
    if (result.value.status === 'sidecar') {
      showNotice.warning(
        'settings.feedback.notifications.clashService.permissionFallback',
        { reason: result.value.reason },
        0,
      )
      return
    }
    await mutate(() => restartCore(), {
      id: 'restart-core',
      errorNotice: false,
    }).catch((err) => showNotice.error(err))
    showNotice.success('origami.settings.service.reinstalled')
  })

  const checkUpdate = useLockFn(async () => {
    try {
      const info = await checkUpdateSafe()
      updateLastCheckTime()
      if (info?.available && packageManager) {
        // The built-in updater cannot install over a pacman package: send people to the release.
        showNotice.info('origami.settings.updates.newPackage', {
          version: info.version,
        })
        void openExternalUrl(ORIGAMI_LINKS.releases)
      } else if (info?.available) {
        updateRef.current?.open()
      } else {
        showNotice.success('origami.settings.updates.latest')
      }
    } catch (err) {
      showNotice.warning(err)
    }
  })

  const lastCheck = readLastCheckTime()
  const themeMode = verge?.theme_mode ?? 'system'

  return (
    <div className="o-set">
      <UpdateViewer ref={updateRef} />

      <Section label={t('origami.settings.sections.connection')}>
        <Row
          title={t('origami.settings.service.title')}
          hint={t('origami.settings.service.hint')}
        >
          <span className={`o-set__badge${serviceOk ? ' is-ok' : ' is-bad'}`}>
            {serviceOk
              ? t('origami.settings.service.ok')
              : t('origami.settings.service.missing')}
          </span>
          <Button
            variant="outlined"
            size="small"
            onClick={() => void fixService()}
          >
            {serviceOk
              ? t('origami.settings.service.reinstall')
              : t('origami.settings.service.install')}
          </Button>
        </Row>
        <Row
          title={t('origami.settings.autoLaunch.title')}
          hint={t('origami.settings.autoLaunch.hint')}
        >
          <Switch
            checked={verge?.enable_auto_launch ?? false}
            onChange={(_, value) => void patch({ enable_auto_launch: value })}
          />
        </Row>
        <Row
          title={t('origami.settings.silentStart.title')}
          hint={t('origami.settings.silentStart.hint')}
        >
          <Switch
            checked={verge?.enable_silent_start ?? false}
            onChange={(_, value) => void patch({ enable_silent_start: value })}
          />
        </Row>
      </Section>

      <Section label={t('origami.settings.sections.look')}>
        <Row title={t('origami.settings.theme.title')}>
          <div
            className="o-seg o-set__seg"
            role="radiogroup"
            aria-label={t('origami.settings.theme.title')}
          >
            {THEMES.map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={themeMode === mode}
                className={themeMode === mode ? 'is-on' : ''}
                onClick={() => void patch({ theme_mode: mode })}
              >
                {t(`origami.settings.theme.${mode}`)}
              </button>
            ))}
          </div>
        </Row>
        <Row title={t('origami.settings.language')}>
          <Select
            size="small"
            value={verge?.language ?? 'ru'}
            IconComponent={ExpandMoreRounded}
            onChange={(e) => void patch({ language: e.target.value })}
            sx={{ minWidth: 160 }}
          >
            {supportedLanguages.map((code) => (
              <MenuItem key={code} value={code}>
                {LANGUAGE_NAMES[code] ?? code}
              </MenuItem>
            ))}
          </Select>
        </Row>
        <Row
          title={t('origami.settings.titlebar.title')}
          hint={t('origami.settings.titlebar.hint')}
        >
          <Switch
            checked={decorated === true}
            onChange={() => void toggleDecorations()}
          />
        </Row>
      </Section>

      <Section label={t('origami.settings.sections.updates')}>
        {packageManager ? (
          <Row
            title={t('origami.settings.updates.version', { version })}
            hint={t('origami.settings.updates.byManager', {
              manager: packageManager,
            })}
          >
            <Button
              variant="outlined"
              size="small"
              onClick={() => void checkUpdate()}
            >
              {t('origami.settings.updates.check')}
            </Button>
          </Row>
        ) : (
          <>
            <Row
              title={t('origami.settings.updates.version', { version })}
              hint={
                lastCheck
                  ? t('origami.settings.updates.checked', {
                      time: dayjs(lastCheck).format('DD.MM HH:mm'),
                    })
                  : undefined
              }
            >
              <Button
                variant="outlined"
                size="small"
                onClick={() => void checkUpdate()}
              >
                {t('origami.settings.updates.check')}
              </Button>
            </Row>
            <Row
              title={t('origami.settings.updates.auto')}
              hint={t('origami.settings.updates.autoHint')}
            >
              <Switch
                checked={verge?.auto_check_update ?? true}
                onChange={(_, value) =>
                  void patch({ auto_check_update: value })
                }
              />
            </Row>
          </>
        )}
      </Section>

      <Section label={t('origami.settings.sections.help')}>
        <Row
          title={t('origami.settings.help.diagnostics')}
          hint={t('origami.settings.help.diagnosticsHint')}
        >
          <Button
            variant="outlined"
            size="small"
            startIcon={<ContentCopyRounded fontSize="small" />}
            onClick={() => void copyDiagnostics()}
          >
            {t('origami.settings.help.diagnosticsButton')}
          </Button>
        </Row>
        <Row
          title={t('origami.settings.help.links')}
          hint={t('origami.settings.help.linksHint')}
        >
          <Button
            variant="outlined"
            size="small"
            startIcon={<Telegram fontSize="small" />}
            onClick={() => void openExternalUrl(ORIGAMI_LINKS.channel)}
          >
            {t('origami.settings.help.channel')}
          </Button>
          <Button
            variant="outlined"
            size="small"
            onClick={() => void openExternalUrl(ORIGAMI_LINKS.site)}
          >
            {t('origami.settings.help.site')}
          </Button>
        </Row>
      </Section>

      <section className="o-plate o-set__plate o-set__expert">
        <Row
          title={t('origami.settings.expert.title')}
          hint={t('origami.settings.expert.hint')}
        >
          <Switch
            checked={expert}
            onChange={(_, value) => setExpertMode(value)}
          />
        </Row>
      </section>

      {children}

      <div className="o-set__foot">
        <span className="o-hint">
          {t('origami.settings.footer', { version })}
        </span>
        <Button
          size="small"
          color="error"
          variant="outlined"
          onClick={() => {
            void mutate(() => exitApp(), {
              id: 'exit-app',
              errorNotice: false,
            }).catch(() => {})
          }}
        >
          {t('origami.settings.exit')}
        </Button>
      </div>
    </div>
  )
}
