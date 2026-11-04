import { PowerSettingsNewRounded, RefreshRounded } from '@mui/icons-material'
import { Button, IconButton } from '@mui/material'
import dayjs from 'dayjs'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'

import { BasePage } from '@/components/base'
import { CurrentProxyCard } from '@/components/home/current-proxy-card'
import { useProfiles } from '@/hooks/use-profiles'
import { useTrafficData } from '@/hooks/use-traffic-data'
import { useVisibility } from '@/hooks/use-visibility'
import { showNotice } from '@/services/notice-service'
import { requestService } from '@/services/service-request'
import { openExternalUrl } from '@/utils/open-external-url'
import parseTraffic from '@/utils/parse-traffic'

import { useExpertMode } from '../expert-mode'
import { ORIGAMI_LINKS } from '../links'
import { expiryStage, needsRenew } from '../subscription-status'
import { useRefreshSubscription } from '../use-refresh-subscription'

import { AnnouncePlate } from './announce-plate'
import { CheckPlate } from './check-plate'
import { ServerPlate } from './server-plate'
import { type ConnectMode, useConnection } from './use-connection'
import { Welcome } from './welcome'

const DAY_MS = 24 * 60 * 60 * 1000

const formatBytes = (value: number) => parseTraffic(value).join(' ')

// Current speed sits at the foot of the subscription plate, next to the traffic used so far; the
// connect plate keeps only the button.
const SpeedRow = () => {
  const { t } = useTranslation()
  const visible = useVisibility()
  const {
    response: { data: traffic },
  } = useTrafficData({ enabled: visible })

  return (
    <div className="o-speed">
      <div>
        <div className="o-label">{t('origami.home.speed.down')}</div>
        <div className="o-mono o-value">
          {formatBytes(traffic?.down ?? 0)}/s
        </div>
      </div>
      <div>
        <div className="o-label">{t('origami.home.speed.up')}</div>
        <div className="o-mono o-value">{formatBytes(traffic?.up ?? 0)}/s</div>
      </div>
    </div>
  )
}

const ConnectPlate = () => {
  const { t } = useTranslation()
  const expert = useExpertMode()
  const {
    mode,
    connected,
    isLoading,
    tunNeedsService,
    connect,
    disconnect,
    changeMode,
  } = useConnection()

  // Connecting or disconnecting: the button shows a turning ring until the core answers.
  const [busy, setBusy] = useState(false)

  const run = (action: () => Promise<void>) =>
    action().catch((error) => showNotice.error(error))

  const toggle = async () => {
    setBusy(true)
    try {
      await run(connected ? disconnect : connect)
    } finally {
      setBusy(false)
    }
  }

  const modes: { id: ConnectMode; label: string }[] = [
    { id: 'proxy', label: t('origami.home.mode.proxy') },
    { id: 'tun', label: t('origami.home.mode.tun') },
  ]

  const state = busy ? 'busy' : connected ? 'on' : 'off'

  return (
    <section className="o-plate o-connect">
      <button
        type="button"
        className={`o-power is-${state}`}
        disabled={isLoading || busy}
        aria-pressed={connected}
        aria-label={
          connected
            ? t('origami.home.state.disconnect')
            : t('origami.home.state.connect')
        }
        onClick={toggle}
      >
        <PowerSettingsNewRounded className="o-power__icon" />
      </button>
      <div className="o-power__caption" aria-live="polite">
        <div className={`o-power__state is-${state}`}>
          {busy
            ? connected
              ? t('origami.home.state.disconnecting')
              : t('origami.home.state.connecting')
            : connected
              ? t('origami.home.state.on')
              : t('origami.home.state.off')}
        </div>
        <div className="o-hint">
          {connected
            ? t('origami.home.state.onHint')
            : t('origami.home.state.offHint')}
        </div>
      </div>
      {expert && (
        <div
          className="o-seg"
          role="radiogroup"
          aria-label={t('origami.home.mode.label')}
        >
          {modes.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={mode === item.id}
              className={mode === item.id ? 'is-on' : undefined}
              onClick={() => run(() => changeMode(item.id))}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
      {expert ? (
        <p className="o-hint">
          {mode === 'tun'
            ? tunNeedsService
              ? t('origami.home.mode.tunServiceHint')
              : t('origami.home.mode.tunHint')
            : t('origami.home.mode.proxyHint')}
        </p>
      ) : (
        mode === 'tun' &&
        tunNeedsService &&
        !isLoading && (
          <div className="o-service-warn" role="alert">
            <p>{t('origami.home.service.missing')}</p>
            <Button
              variant="outlined"
              size="small"
              onClick={() =>
                requestService({
                  reason: 'tunNeedsService',
                  restore: { enable_tun_mode: true },
                })
              }
            >
              {t('origami.home.service.install')}
            </Button>
          </div>
        )
      )}
    </section>
  )
}

const pluralDays = (
  count: number,
  language: string,
  t: (key: string, o?: object) => string,
) => {
  const form = new Intl.PluralRules(language).select(count)
  return t(`origami.home.subscription.days.${form}`, { count })
}

const SubscriptionPlate = () => {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { current } = useProfiles()
  const [now] = useState(() => Date.now())
  const { refresh, updating } = useRefreshSubscription()

  if (!current || current.type !== 'remote') {
    return (
      <section className="o-plate o-sub">
        <div className="o-label">{t('origami.home.subscription.title')}</div>
        <p className="o-hint">{t('origami.home.subscription.empty')}</p>
        <Button
          variant="contained"
          fullWidth
          onClick={() => navigate('/profile')}
        >
          {t('origami.home.subscription.add')}
        </Button>
      </section>
    )
  }

  const extra = current.extra
  const expire = extra?.expire ? dayjs(extra.expire * 1000) : null
  const daysLeft = expire
    ? Math.max(0, Math.ceil((expire.valueOf() - now) / DAY_MS))
    : null
  const used = (extra?.upload ?? 0) + (extra?.download ?? 0)
  const total = extra?.total ?? 0
  const share = total > 0 ? Math.min(100, (used / total) * 100) : null
  const stage = expiryStage(extra?.expire, now)

  return (
    <section className={`o-plate o-sub${stage ? ` o-sub--${stage}` : ''}`}>
      <div className="o-sub__head">
        <div className="o-label">{t('origami.home.subscription.title')}</div>
        {current.updated ? (
          <span className="o-hint">
            {t('origami.home.subscription.updated', {
              time: dayjs(current.updated * 1000).fromNow(),
            })}
          </span>
        ) : null}
        <IconButton
          size="small"
          className={updating ? 'o-spin' : undefined}
          disabled={updating}
          aria-label={t('origami.home.subscription.refresh')}
          title={t('origami.home.subscription.refresh')}
          onClick={refresh}
        >
          <RefreshRounded fontSize="small" />
        </IconButton>
      </div>
      <div className="o-big">
        {stage === 'expired'
          ? t('origami.home.subscription.expired')
          : daysLeft === null
            ? t('origami.home.subscription.noExpire')
            : pluralDays(daysLeft, i18n.language, t as never)}
      </div>
      {expire && (
        <div className="o-hint">
          {t('origami.home.subscription.until', {
            date: expire.format('DD.MM.YYYY'),
          })}
        </div>
      )}
      {share !== null && (
        <div className="o-meter" aria-hidden="true">
          <div style={{ width: `${share}%` }} />
        </div>
      )}
      <div className="o-mono o-hint">
        {total > 0
          ? t('origami.home.subscription.traffic', {
              used: formatBytes(used),
              total: formatBytes(total),
            })
          : t('origami.home.subscription.unlimited', {
              used: formatBytes(used),
            })}
      </div>
      {needsRenew(extra?.expire, now) && (
        <Button
          variant="contained"
          fullWidth
          onClick={() => void openExternalUrl(ORIGAMI_LINKS.cabinet)}
        >
          {t('origami.home.subscription.renew')}
        </Button>
      )}
      <SpeedRow />
    </section>
  )
}

const OrigamiHomePage = () => {
  const { t } = useTranslation()
  const expert = useExpertMode()
  const { profiles, current } = useProfiles()
  const needsSubscription = !!profiles && current?.type !== 'remote'

  return (
    <BasePage title={t('layout.components.navigation.tabs.home')}>
      {needsSubscription ? (
        <div className="o-home">
          <Welcome />
        </div>
      ) : (
        <div className="o-home">
          <AnnouncePlate />
          <div className="o-home__grid">
            <ConnectPlate />
            <div className="o-home__side">
              <ServerPlate />
              <SubscriptionPlate />
            </div>
          </div>
          <CheckPlate />
          {expert && (
            <div className="o-home__server">
              <CurrentProxyCard />
            </div>
          )}
        </div>
      )}
    </BasePage>
  )
}

export default OrigamiHomePage
