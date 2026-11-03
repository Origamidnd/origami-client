import { HelpOutlineRounded, RefreshRounded } from '@mui/icons-material'
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
import {
  resolveMember,
  type InteractableProxyMember,
  type ProxyGroupView,
  type ProxyNodeView,
  type ProxyViewV1,
} from '@/types/proxy-view'
import { DEFAULT_DELAY_TIMEOUT } from '@/utils/delay'
import { openExternalUrl } from '@/utils/open-external-url'

import { ORIGAMI_LINKS } from '../links'
import { ReportDialog } from '../report/report-dialog'
import type { FocusGroupState } from '../use-focus-group'

import {
  countryAnswers,
  fastestVariant,
  groupCountries,
  parseServerName,
  pingLevel,
  PLAIN_VARIANT,
  serviceTitle,
  type CountryOption,
  type ServerCategory,
} from './model'

// Delays measured here are kept under one key, separate from the stock page's groups.
const CHECK_KEY = 'origami-servers'
const CHECKED_AT_KEY = 'origami.serversCheckedAt'
const RECHECK_AFTER_MS = 5 * 60 * 1000
const AUTO_TYPES = new Set(['URLTest', 'Fallback', 'LoadBalance'])

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

interface Service {
  group: ProxyGroupView
  auto?: ProxyGroupView
  direct?: ProxyNodeView
  servers: InteractableProxyMember[]
}

const buildServices = (view: ProxyViewV1): Service[] =>
  view.groups
    .filter((group) => !group.hidden && group.type === 'Selector')
    .map((group) => {
      const service: Service = { group, servers: [] }
      for (const ref of group.members) {
        const member = resolveMember(view, ref)
        if (member.kind === 'unresolved') continue
        if (member.kind === 'group') {
          if (AUTO_TYPES.has(member.group.type)) service.auto ??= member.group
          else service.servers.push(member)
        } else if (member.node.type === 'Direct') {
          service.direct ??= member.node
        } else {
          service.servers.push(member)
        }
      }
      return service
    })

const memberName = (member: InteractableProxyMember) => member.ref.name

const memberType = (member: InteractableProxyMember) =>
  member.kind === 'node' ? member.node.type : member.group.type

/** null when the server did not answer, undefined when it was not checked yet. */
const readDelay = (
  member: InteractableProxyMember,
): number | null | undefined => {
  const delay = delayManager.getDelayFix(member, CHECK_KEY)
  if (delay === -2) return undefined
  if (delay < 0) return undefined
  if (delay === 0 || delay >= DEFAULT_DELAY_TIMEOUT) return null
  return delay
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
  unit = true,
}: {
  delay: number | null | undefined
  checking: boolean
  unit?: boolean
}) => {
  const { t } = useTranslation()
  if (checking) return <span className="o-srv__ping is-wait">…</span>
  const level = pingLevel(delay)
  return (
    <span className={`o-srv__ping is-${level}`}>
      {level === 'dead'
        ? t('origami.servers.noAnswer')
        : level === 'unknown'
          ? ''
          : unit
            ? t('origami.home.server.ping', { ms: delay })
            : delay}
    </span>
  )
}

const BLOCK_ORDER: ServerCategory[] = ['main', 'extra', 'other']
const GAMES_ORDER: ServerCategory[] = ['other', 'main', 'extra']

/** Simple Servers tab: every service keeps its own server; the stock tab stays in expert mode. */
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

  const runCheck = useLockFn(async () => {
    const seen = new Set<string>()
    const servers = services
      .flatMap((item) => item.servers)
      .filter((member) => {
        if (seen.has(memberName(member))) return false
        seen.add(memberName(member))
        return member.kind === 'node'
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
      const dead = servers.filter((member) => readDelay(member) === null)
      if (dead.length) {
        showNotice.info('origami.servers.checkedSome', { count: dead.length })
      } else {
        showNotice.success('origami.servers.checkedAll')
      }
    } finally {
      setChecking(false)
    }
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
  const countries = groupCountries(
    service.servers.map((member) => ({
      name: memberName(member),
      type: memberType(member),
      delay: readDelay(member),
    })),
  )
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
                  onClick={() => choose(option.name, label(option.variant))}
                >
                  {option.variant}
                  <Ping delay={option.delay} checking={checking} unit={false} />
                </button>
              ))}
            </div>
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
                <button
                  key={item.group.name}
                  type="button"
                  className={`o-srv__service${item === service ? ' is-on' : ''}`}
                  aria-current={item === service}
                  onClick={() => setSelected(item.group.name)}
                >
                  <b>
                    {info.icon} {info.title}
                  </b>
                  <span className="o-hint">
                    {typeof state === 'string' ? (
                      state
                    ) : (
                      <>
                        {state.label}
                        {state.node && !checking && nodeDelay(state.node) ? (
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
                </button>
              )
            })}
          </nav>

          <section className="o-plate o-srv__pick" aria-live="polite">
            <div className="o-srv__label">
              {title.icon} {title.title.toUpperCase()}
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
              <span className="o-srv__ping is-fast">
                {t('origami.servers.fast')}
              </span>
              {' · '}
              <span className="o-srv__ping is-mid">
                {t('origami.servers.mid')}
              </span>
              {' · '}
              <span className="o-srv__ping is-slow">
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
