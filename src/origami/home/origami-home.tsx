import { PowerSettingsNewRounded } from '@mui/icons-material'
import { Button } from '@mui/material'
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
import { openExternalUrl } from '@/utils/open-external-url'
import parseTraffic from '@/utils/parse-traffic'

import { ORIGAMI_LINKS } from '../links'

import { type ConnectMode, useConnection } from './use-connection'

const DAY_MS = 24 * 60 * 60 * 1000

const formatBytes = (value: number) => parseTraffic(value).join(' ')

const ConnectPlate = () => {
  const { t } = useTranslation()
  const {
    mode,
    connected,
    isLoading,
    tunNeedsService,
    connect,
    disconnect,
    changeMode,
  } = useConnection()

  const run = (action: () => Promise<void>) =>
    action().catch((error) => showNotice.error(error))

  const modes: { id: ConnectMode; label: string }[] = [
    { id: 'proxy', label: t('origami.home.mode.proxy') },
    { id: 'tun', label: t('origami.home.mode.tun') },
  ]

  return (
    <section className="o-plate o-connect">
      <div className={`o-status${connected ? ' is-on' : ''}`}>
        {connected ? t('origami.home.status.on') : t('origami.home.status.off')}
      </div>
      <button
        type="button"
        className={`o-power${connected ? ' is-on' : ''}`}
        disabled={isLoading}
        aria-pressed={connected}
        onClick={() => run(connected ? disconnect : connect)}
      >
        <PowerSettingsNewRounded className="o-power__icon" />
        <span className="o-power__label">
          {connected ? t('origami.home.power.on') : t('origami.home.power.off')}
        </span>
      </button>
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
      <p className="o-hint">
        {mode === 'tun'
          ? tunNeedsService
            ? t('origami.home.mode.tunServiceHint')
            : t('origami.home.mode.tunHint')
          : t('origami.home.mode.proxyHint')}
      </p>
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

  return (
    <section className="o-plate o-sub">
      <div className="o-label">{t('origami.home.subscription.title')}</div>
      <div className="o-big">
        {daysLeft === null
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
      <Button
        variant="contained"
        fullWidth
        onClick={() => void openExternalUrl(ORIGAMI_LINKS.cabinet)}
      >
        {t('origami.home.subscription.renew')}
      </Button>
    </section>
  )
}

const SpeedPlate = () => {
  const { t } = useTranslation()
  const visible = useVisibility()
  const {
    response: { data: traffic },
  } = useTrafficData({ enabled: visible })

  return (
    <section className="o-plate o-speed">
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
    </section>
  )
}

const OrigamiHomePage = () => {
  const { t } = useTranslation()

  return (
    <BasePage title={t('layout.components.navigation.tabs.home')}>
      <div className="o-home">
        <div className="o-home__grid">
          <ConnectPlate />
          <div className="o-home__side">
            <SubscriptionPlate />
            <SpeedPlate />
          </div>
        </div>
        <div className="o-home__server">
          <CurrentProxyCard />
        </div>
      </div>
    </BasePage>
  )
}

export default OrigamiHomePage
