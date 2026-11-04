import {
  CloudSyncRounded,
  NorthEastRounded,
  QrCode2Rounded,
} from '@mui/icons-material'
import { Button, MenuItem, Select } from '@mui/material'
import dayjs from 'dayjs'
import { QRCodeSVG } from 'qrcode.react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Switch } from '@/components/base'
import { useProfiles } from '@/hooks/use-profiles'
import { patchProfile } from '@/services/cmds'
import { mutate } from '@/services/mutate'
import { showNotice } from '@/services/notice-service'
import { openExternalUrl } from '@/utils/open-external-url'
import parseTraffic from '@/utils/parse-traffic'

import { ORIGAMI_LINKS } from '../links'
import { daysLeft, expiryStage } from '../subscription-status'
import { useRefreshSubscription } from '../use-refresh-subscription'

const formatBytes = (value: number) => parseTraffic(value).join(' ')

// Minutes, as the profile stores them.
const INTERVALS = [6 * 60, 12 * 60, 24 * 60]
const DEFAULT_INTERVAL = 12 * 60

const pluralDays = (
  count: number,
  language: string,
  t: (key: string, o?: object) => string,
) => {
  const form = new Intl.PluralRules(language).select(count)
  return t(`origami.home.subscription.days.${form}`, { count })
}

// Renew links lead to our cabinet and bot, so other providers' subscriptions go without them.
const isOrigami = (url?: string | null) => /origamivpn/i.test(url ?? '')

/** Tiles under a subscription row: term, traffic, server-list updates and a QR code for other devices. */
export const OrigamiSubscription = ({ item }: { item: IProfileItem }) => {
  const { t, i18n } = useTranslation()
  const { mutateProfiles } = useProfiles()
  const { refresh, updating } = useRefreshSubscription(item)
  const [now] = useState(() => Date.now())
  const [qrShown, setQrShown] = useState(false)

  if (item.type !== 'remote') return null

  const extra = item.extra
  const stage = expiryStage(extra?.expire, now)
  const left = extra?.expire ? daysLeft(extra.expire, now) : null
  const upload = extra?.upload ?? 0
  const download = extra?.download ?? 0
  const used = upload + download
  const total = extra?.total ?? 0
  const share = total > 0 ? Math.min(100, (used / total) * 100) : null

  const option: IProfileOption = item.option ?? {}
  // The core runs the update timer only with an interval set, so no interval means off.
  const autoUpdate =
    (option.allow_auto_update ?? true) && !!option.update_interval
  const interval = option.update_interval || DEFAULT_INTERVAL

  const patchOption = async (patch: IProfileOption) => {
    const uid = item.uid
    if (!uid) return
    try {
      await mutate(
        () => patchProfile(uid, { option: { ...option, ...patch } }),
        {
          id: `patch-profile:${uid}`,
          errorNotice: false,
        },
      )
      await mutateProfiles()
    } catch (error) {
      showNotice.error(error)
    }
  }

  return (
    <div className="o-subp">
      <section
        className={`o-plate o-subp__tile${stage ? ` o-sub--${stage}` : ''}`}
      >
        <div className="o-label">{t('origami.subscription.term')}</div>
        <div className="o-big">
          {stage === 'expired'
            ? t('origami.home.subscription.expired')
            : left === null
              ? t('origami.home.subscription.noExpire')
              : pluralDays(left, i18n.language, t as never)}
        </div>
        {extra?.expire ? (
          <p className="o-hint">
            {t('origami.home.subscription.until', {
              date: dayjs(extra.expire * 1000).format('DD.MM.YYYY'),
            })}
          </p>
        ) : null}
        {isOrigami(item.url) && (
          <div className="o-subp__actions">
            <Button
              variant="contained"
              size="small"
              onClick={() => void openExternalUrl(ORIGAMI_LINKS.cabinet)}
            >
              {t('origami.home.subscription.renew')}
            </Button>
            <Button
              variant="outlined"
              size="small"
              endIcon={<NorthEastRounded fontSize="small" />}
              onClick={() => void openExternalUrl(ORIGAMI_LINKS.bot)}
            >
              {t('origami.subscription.viaBot')}
            </Button>
          </div>
        )}
      </section>

      <section className="o-plate o-subp__tile">
        <div className="o-label">{t('origami.subscription.traffic')}</div>
        <div className="o-big">{formatBytes(used)}</div>
        {share !== null && (
          <div className="o-meter" aria-hidden="true">
            <div style={{ width: `${share}%` }} />
          </div>
        )}
        <p className="o-hint">
          {total > 0
            ? t('origami.subscription.limit', { total: formatBytes(total) })
            : t('origami.subscription.noLimit')}
        </p>
        <p className="o-hint o-mono">
          {t('origami.subscription.split', {
            down: formatBytes(download),
            up: formatBytes(upload),
          })}
        </p>
      </section>

      <section className="o-plate o-subp__tile">
        <div className="o-label">{t('origami.subscription.servers')}</div>
        <div className="o-value">
          {item.updated
            ? t('origami.subscription.updatedAgo', {
                time: dayjs(item.updated * 1000).fromNow(),
              })
            : t('origami.subscription.neverUpdated')}
        </div>
        <div className="o-subp__auto">
          <Switch
            checked={autoUpdate}
            onChange={(_, value) =>
              void patchOption(
                value
                  ? { allow_auto_update: true, update_interval: interval }
                  : { allow_auto_update: false },
              )
            }
          />
          <span>{t('origami.subscription.auto')}</span>
          <Select
            size="small"
            value={INTERVALS.includes(interval) ? interval : ''}
            displayEmpty
            disabled={!autoUpdate}
            onChange={(event) =>
              void patchOption({ update_interval: Number(event.target.value) })
            }
            renderValue={(value) =>
              t('origami.subscription.every', {
                hours: Math.round((Number(value) || interval) / 60),
              })
            }
          >
            {INTERVALS.map((minutes) => (
              <MenuItem key={minutes} value={minutes}>
                {t('origami.subscription.every', { hours: minutes / 60 })}
              </MenuItem>
            ))}
          </Select>
        </div>
        <p className="o-hint">{t('origami.subscription.autoHint')}</p>
        <div className="o-subp__actions">
          <Button
            variant="outlined"
            size="small"
            startIcon={<CloudSyncRounded fontSize="small" />}
            disabled={updating}
            onClick={() => void refresh()}
          >
            {updating
              ? t('origami.servers.refreshingSub')
              : t('origami.servers.refreshSub')}
          </Button>
        </div>
      </section>

      <section className="o-plate o-subp__tile o-subp__phone">
        <div className="o-label">{t('origami.subscription.phone')}</div>
        <div className="o-subp__qr-row">
          <button
            type="button"
            className={`o-subp__qr${qrShown ? ' is-shown' : ''}`}
            aria-label={t('origami.subscription.showQr')}
            onClick={() => setQrShown(!qrShown)}
          >
            {qrShown && item.url ? (
              <QRCodeSVG value={item.url} size={132} level="M" />
            ) : (
              <QrCode2Rounded />
            )}
          </button>
          <div className="o-subp__qr-text">
            <div className="o-set__title">
              {t('origami.subscription.phoneTitle')}
            </div>
            <p className="o-hint">{t('origami.subscription.phoneHint')}</p>
            <Button
              variant="outlined"
              size="small"
              onClick={() => setQrShown(!qrShown)}
            >
              {qrShown
                ? t('origami.subscription.hideQr')
                : t('origami.subscription.showQr')}
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}
