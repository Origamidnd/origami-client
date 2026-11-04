import {
  CloudSyncRounded,
  HelpOutlineRounded,
  RefreshRounded,
} from '@mui/icons-material'
import { Button, Tooltip } from '@mui/material'
import { useLockFn } from 'ahooks'
import dayjs from 'dayjs'
import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router'

import { BasePage } from '@/components/base'
import { useProfiles } from '@/hooks/use-profiles'
import { useProxySelection } from '@/hooks/use-proxy-selection'
import { useVerge } from '@/hooks/use-verge'
import { useAppRefreshers, useProxiesData } from '@/providers/app-data-context'
import delayManager from '@/services/delay'
import { showNotice } from '@/services/notice-service'
import type { ProxyNodeView, ProxyViewV1 } from '@/types/proxy-view'
import { DEFAULT_DELAY_TIMEOUT } from '@/utils/delay'
import { openExternalUrl } from '@/utils/open-external-url'

import { ORIGAMI_LINKS } from '../links'
import { PingBadge } from '../ping-badge'
import { ReportDialog } from '../report/report-dialog'
import type { FocusGroupState } from '../use-focus-group'
import { useRefreshSubscription } from '../use-refresh-subscription'

import {
  pendingSwitches,
  setVariantPinned,
  useApplySwitches,
  usePinnedVariants,
} from './auto-variant'
import {
  countryAnswers,
  fastestVariant,
  groupCountries,
  parseServerName,
  PLAIN_VARIANT,
  serviceTitle,
  type CountryOption,
  type ServerCategory,
} from './model'
import { GlyphTile, ServiceIcon } from './service-icon'
import {
  buildServices,
  CHECK_KEY,
  isServer,
  memberName,
  readDelay,
  serverLabel,
  serverOptions,
  type Service,
} from './services'

const CHECKED_AT_KEY = 'origami.serversCheckedAt'
const RECHECK_AFTER_MS = 5 * 60 * 1000

const readCheckedAt = () => {
  try {
    const value = Number(localStorage.getItem(CHECKED_AT_KEY))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

const writeCheckedAt = (value: number) => {
  try {
    localStorage.setItem(CHECKED_AT_KEY, String(value))
  } catch {
    // Without storage the page simply checks again next time.
  }
}

const nodeByName = (view: ProxyViewV1, name: string) =>
  Object.values(view.records).find((record) => record.name === name)

const nodeDelay = (node: ProxyNodeView | undefined) => {
  if (!node) return undefined
  const fromCheck = delayManager.getDelay(node.name, CHECK_KEY)
  if (fromCheck > 0 && fromCheck < DEFAULT_DELAY_TIMEOUT) return fromCheck
  if (fromCheck === 0 || fromCheck >= DEFAULT_DELAY_TIMEOUT) return null
  const last = node.history.at(-1)?.delay
  return last === undefined ? undefined : last > 0 ? last : null
}

const Ping = ({
  delay,
  checking,
}: {
  delay: number | null | undefined
  checking: boolean
}) => <PingBadge delay={delay} checking={checking} />

const BLOCK_ORDER: ServerCategory[] = ['main', 'extra', 'other']
const GAMES_ORDER: ServerCategory[] = ['other', 'main', 'extra']

/** Servers tab: every service keeps its own server; the stock groups page is the expert Groups tab. */
export const OrigamiServers = () => {
  const { t } = useTranslation()
  const { proxyView } = useProxiesData()
  const { refreshProxy } = useAppRefreshers()
  const { verge } = useVerge()
  const { current } = useProfiles()
  const location = useLocation()
  const [, rerender] = useReducer((tick: number) => tick + 1, 0)
  const [checking, setChecking] = useState(false)
  const [checkedAt, setCheckedAt] = useState(readCheckedAt)
  const [reportOpen, setReportOpen] = useState(false)
  const focus = (location.state as FocusGroupState | null)?.origamiFocusGroup
  const [selected, setSelected] = useState<string | undefined>(focus)

  useEffect(() => delayManager.addGroupListener(CHECK_KEY, rerender), [])

  const services = useMemo(
    () => (proxyView ? buildServices(proxyView) : []),
    [proxyView],
  )
  const service =
    services.find((item) => item.group.name === selected) ?? services[0]

  const { handleProxyGroupChange } = useProxySelection({
    onSuccess: () => void refreshProxy(),
    onError: () => void refreshProxy(),
  })
  const applySwitches = useApplySwitches()
  const pinned = usePinnedVariants()

  const runCheck = useLockFn(async () => {
    const seen = new Set<string>()
    const servers = services
      .flatMap((item) => item.servers)
      .filter((member) => {
        if (seen.has(memberName(member))) return false
        seen.add(memberName(member))
        return isServer(member)
      })
    if (servers.length === 0) return
    setChecking(true)
    try {
      await delayManager.checkListDelay(
        servers,
        CHECK_KEY,
        verge?.default_latency_timeout || DEFAULT_DELAY_TIMEOUT,
      )
      await refreshProxy()
      const now = Date.now()
      writeCheckedAt(now)
      setCheckedAt(now)
      applySwitches(pendingSwitches(services))
      // Name the silent ones: a country row shows its best variant, so a bare count looked wrong.
      const dead = servers
        .filter((member) => readDelay(member) === null)
        .map((member) => serverLabel(memberName(member)))
      if (dead.length) {
        showNotice.info('origami.servers.checkedSome', {
          names: dead.join(', '),
        })
      } else {
        showNotice.success('origami.servers.checkedAll')
      }
    } finally {
      setChecking(false)
    }
  })

  // New servers can come with the subscription, so they get their numbers right away.
  const { refresh, updating, canRefresh } = useRefreshSubscription()
  const refreshAndCheck = useLockFn(async () => {
    await refresh()
    await runCheck()
  })

  // Pick by fresh numbers: check again when the last check is old.
  const autoCheckedRef = useRef(false)
  useEffect(() => {
    if (autoCheckedRef.current || services.length === 0) return
    autoCheckedRef.current = true
    const last = readCheckedAt()
    if (!last || Date.now() - last > RECHECK_AFTER_MS) void runCheck()
  }, [services.length, runCheck])

  if (!proxyView || !service) {
    return (
      <BasePage title={t('origami.servers.title')}>
        <p className="o-hint">{t('origami.home.server.none')}</p>
      </BasePage>
    )
  }

  const describe = (item: Service) => {
    const now = item.group.now
    if (!now) return ''
    if (item.direct && now === item.direct.name)
      return t('origami.servers.direct')
    if (item.auto && now === item.auto.name) {
      const node = item.auto.now
        ? nodeByName(proxyView, item.auto.now)
        : undefined
      const base = node ? parseServerName(node.name, node.type).base : ''
      return { label: t('origami.servers.autoShort', { server: base }), node }
    }
    const node = nodeByName(proxyView, now)
    const parsed = parseServerName(now, node?.type)
    return {
      label:
        parsed.variant === PLAIN_VARIANT
          ? parsed.base
          : `${parsed.base}, ${parsed.variant}`,
      node,
    }
  }

  const choose = (name: string, label: string) => {
    if (service.group.now === name) return
    handleProxyGroupChange(service.group, { name })
    showNotice.success('origami.servers.chosen', {
      service: serviceTitle(service.group.name).title,
      server: label,
    })
  }

  const title = serviceTitle(service.group.name)
  const isGames = /игр/i.test(title.title)
  const countries = groupCountries(serverOptions(service))
  const now = service.group.now
  const autoNode = service.auto?.now
    ? nodeByName(proxyView, service.auto.now)
    : undefined

  const renderCountry = (country: CountryOption): ReactNode => {
    const chosen = country.variants.find((option) => option.name === now)
    const best = fastestVariant(country)
    const shown = chosen ?? best
    const many = country.variants.length > 1
    const label = (variant: string) =>
      variant === PLAIN_VARIANT ? country.base : `${country.base}, ${variant}`
    return (
      <div
        key={`${country.category}:${country.base}`}
        className={`o-srv__country${chosen ? ' is-on' : ''}${
          !checking && !countryAnswers(country) ? ' is-off' : ''
        }`}
      >
        <button
          type="button"
          className="o-srv__country-btn"
          aria-pressed={!!chosen}
          onClick={() => {
            if (!chosen) choose(best.name, label(best.variant))
          }}
        >
          <span className="o-srv__country-name">{country.base}</span>
          {chosen && many && <span className="o-hint">{chosen.variant}</span>}
          <Ping delay={shown.delay} checking={checking} />
        </button>
        {chosen && many && (
          <div className="o-srv__variants">
            <div className="o-srv__variants-title">
              {t('origami.servers.variant')}
              <Tooltip
                arrow
                placement="top-start"
                enterDelay={80}
                enterTouchDelay={0}
                leaveTouchDelay={5000}
                title={t('origami.servers.variantHelp')}
                slotProps={{ tooltip: { className: 'o-tip' } }}
              >
                <button
                  type="button"
                  className="o-srv__q"
                  aria-label={t('origami.servers.variantHelpLabel')}
                >
                  <HelpOutlineRounded />
                </button>
              </Tooltip>
            </div>
            <div className="o-srv__chips">
              {country.variants.map((option) => (
                <button
                  key={option.name}
                  type="button"
                  className={`o-srv__chip${option.name === now ? ' is-on' : ''}`}
                  aria-pressed={option.name === now}
                  onClick={() => {
                    // A variant picked by hand stays; automatic switching skips this country.
                    setVariantPinned(country.base, true)
                    choose(option.name, label(option.variant))
                  }}
                >
                  {option.variant}
                  <Ping delay={option.delay} checking={checking} />
                </button>
              ))}
            </div>
            <label className="o-srv__auto">
              <input
                type="checkbox"
                checked={!pinned.has(country.base)}
                onChange={(event) => {
                  const auto = event.target.checked
                  setVariantPinned(country.base, !auto)
                  if (auto && best.name !== now) {
                    choose(best.name, label(best.variant))
                  }
                }}
              />
              {t('origami.servers.autoVariant')}
            </label>
          </div>
        )}
      </div>
    )
  }

  return (
    <BasePage
      title={t('origami.servers.title')}
      header={
        <div className="o-srv__check">
          <Button
            variant="outlined"
            size="small"
            startIcon={<RefreshRounded fontSize="small" />}
            disabled={checking}
            onClick={() => void runCheck()}
          >
            {checking
              ? t('origami.servers.checking')
              : t('origami.servers.check')}
          </Button>
          {canRefresh && (
            <Button
              variant="outlined"
              size="small"
              startIcon={<CloudSyncRounded fontSize="small" />}
              disabled={updating || checking}
              onClick={() => void refreshAndCheck()}
            >
              {updating
                ? t('origami.servers.refreshingSub')
                : t('origami.servers.refreshSub')}
            </Button>
          )}
          {checkedAt && !checking && (
            <span className="o-hint">
              {t('origami.servers.checkedAt', {
                time: dayjs(checkedAt).format('HH:mm'),
              })}
            </span>
          )}
        </div>
      }
    >
      <div className="o-srv">
        <p className="o-srv__lead">
          <b>{t('origami.servers.lead')}</b>
          <br />
          {t('origami.servers.leadExample')}
        </p>
        <div className="o-srv__cols">
          <nav
            className="o-plate o-srv__services"
            aria-label={t('origami.servers.services')}
          >
            {services.map((item) => {
              const info = serviceTitle(item.group.name)
              const state = describe(item)
              return (
                <Tooltip
                  key={item.group.name}
                  arrow
                  placement="right"
                  enterDelay={400}
                  enterNextDelay={200}
                  title={info.hint ?? ''}
                  slotProps={{ tooltip: { className: 'o-tip' } }}
                >
                  <button
                    type="button"
                    className={`o-srv__service${item === service ? ' is-on' : ''}`}
                    aria-current={item === service}
                    onClick={() => setSelected(item.group.name)}
                  >
                    <ServiceIcon groupName={item.group.name} />
                    <span className="o-srv__service-text">
                      <b>{info.title}</b>
                      <span className="o-hint">
                        {typeof state === 'string' ? (
                          state
                        ) : (
                          <>
                            {state.label}
                            {state.node &&
                            !checking &&
                            nodeDelay(state.node) ? (
                              <>
                                {' '}
                                ·{' '}
                                {t('origami.home.server.ping', {
                                  ms: nodeDelay(state.node),
                                })}
                              </>
                            ) : null}
                          </>
                        )}
                      </span>
                    </span>
                  </button>
                </Tooltip>
              )
            })}
          </nav>

          <section className="o-plate o-srv__pick" aria-live="polite">
            <div className="o-srv__label">
              <ServiceIcon groupName={service.group.name} small />
              {title.title.toUpperCase()}
            </div>
            {title.hint && <p className="o-srv__block-hint">{title.hint}</p>}

            {service.auto && (
              <button
                type="button"
                className={`o-srv__opt${now === service.auto.name ? ' is-on' : ''}`}
                aria-pressed={now === service.auto.name}
                onClick={() =>
                  service.auto &&
                  choose(service.auto.name, t('origami.servers.auto'))
                }
              >
                <GlyphTile glyph="auto" />
                <span className="o-srv__opt-text">
                  {t('origami.servers.autoTitle')}
                  <small>
                    {autoNode
                      ? t('origami.servers.autoNow', {
                          server: parseServerName(autoNode.name, autoNode.type)
                            .base,
                        })
                      : t('origami.servers.autoHint')}
                  </small>
                </span>
                <Ping delay={nodeDelay(autoNode)} checking={checking} />
              </button>
            )}
            {service.direct && (
              <button
                type="button"
                className={`o-srv__opt${now === service.direct.name ? ' is-on' : ''}`}
                aria-pressed={now === service.direct.name}
                onClick={() =>
                  service.direct &&
                  choose(service.direct.name, t('origami.servers.direct'))
                }
              >
                <GlyphTile glyph="direct" />
                <span className="o-srv__opt-text">
                  {t('origami.servers.direct')}
                  <small>{t('origami.servers.directHint')}</small>
                </span>
              </button>
            )}

            <p className="o-srv__tip">
              <b>{t('origami.servers.tipAuto')}</b>
              <br />
              {t('origami.servers.tipVariant')}
            </p>

            {(isGames ? GAMES_ORDER : BLOCK_ORDER).map((category) => {
              const block = countries.filter(
                (country) => country.category === category,
              )
              if (block.length === 0) return null
              return (
                <div key={category}>
                  <div className="o-srv__label">
                    {t(
                      category === 'other' && isGames
                        ? 'origami.servers.blocks.games'
                        : `origami.servers.blocks.${category}`,
                    )}
                  </div>
                  <p className="o-srv__block-hint">
                    {t(`origami.servers.blocks.${category}Hint`)}
                  </p>
                  {block.map(renderCountry)}
                </div>
              )
            })}

            <p className="o-srv__legend o-hint">
              {t('origami.servers.legend')}{' '}
              <span className="o-ping is-fast">
                {t('origami.servers.fast')}
              </span>{' '}
              <span className="o-ping is-mid">{t('origami.servers.mid')}</span>{' '}
              <span className="o-ping is-slow">
                {t('origami.servers.slow')}
              </span>
            </p>
            <p className="o-srv__foot">
              {t('origami.servers.foot')}{' '}
              <button
                type="button"
                className="o-srv__link"
                onClick={() => setReportOpen(true)}
              >
                {t('origami.servers.report')}
              </button>{' '}
              {t('origami.servers.or')}{' '}
              <button
                type="button"
                className="o-srv__link"
                onClick={() =>
                  void openExternalUrl(
                    current?.support ?? ORIGAMI_LINKS.support,
                  )
                }
              >
                {t('origami.servers.support')}
              </button>
            </p>
          </section>
        </div>
      </div>
      <ReportDialog open={reportOpen} onClose={() => setReportOpen(false)} />
    </BasePage>
  )
}
