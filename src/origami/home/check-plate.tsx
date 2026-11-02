import {
  CheckCircleOutlineRounded,
  ContentCopyRounded,
  HighlightOffRounded,
} from '@mui/icons-material'
import { Button } from '@mui/material'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { useLockFn } from 'ahooks'
import dayjs from 'dayjs'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useProfiles } from '@/hooks/use-profiles'
import { useProxiesData } from '@/providers/app-data-context'
import { getIpInfo } from '@/services/api'
import { cmdTestDelay, getClashLogs, getSystemInfo } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'
import { openExternalUrl } from '@/utils/open-external-url'

import { buildDiagnostics } from '../check/diagnostics'
import { CHECK_TARGETS, isReachable } from '../check/targets'
import { resolveCurrent } from '../current-server'
import { ORIGAMI_LINKS } from '../links'
import { daysLeft } from '../subscription-status'

import { useConnection } from './use-connection'

interface ExitInfo {
  country: string
  asn: string
}

const AUTO_CHECK_DELAY_MS = 2000

/** «VPN работает?»: checks popular services through the core and shows the exit country. */
export const CheckPlate = () => {
  const { t } = useTranslation()
  const { connected, mode } = useConnection()
  const { current } = useProfiles()
  const { proxyView } = useProxiesData()
  const [running, setRunning] = useState(false)
  const [delays, setDelays] = useState<Record<string, number | undefined>>({})
  const [exit, setExit] = useState<ExitInfo | null>(null)
  const wasConnectedRef = useRef(connected)

  const run = useLockFn(async () => {
    setRunning(true)
    setDelays({})
    try {
      const results = await Promise.all(
        CHECK_TARGETS.map(async (target) => {
          const delay = await cmdTestDelay(target.url).catch(() => undefined)
          setDelays((prev) => ({ ...prev, [target.id]: delay }))
          return delay
        }),
      )
      const info = await getIpInfo().catch(() => null)
      setExit(
        info
          ? {
              country: info.country || info.country_code,
              asn: info.asn
                ? `AS${info.asn} ${info.asn_organization}`.trim()
                : '',
            }
          : null,
      )
      return results
    } finally {
      setRunning(false)
    }
  })

  const runRef = useRef(run)
  useEffect(() => {
    runRef.current = run
  })

  // Check once right after connecting, so people see the result without pressing anything.
  useEffect(() => {
    const justConnected = connected && !wasConnectedRef.current
    wasConnectedRef.current = connected
    if (!justConnected) return
    const timer = window.setTimeout(
      () => void runRef.current(),
      AUTO_CHECK_DELAY_MS,
    )
    return () => window.clearTimeout(timer)
  }, [connected])

  const copyDiagnostics = useLockFn(async () => {
    const [system, logs] = await Promise.all([
      getSystemInfo().catch(() => undefined),
      getClashLogs().catch(() => [] as ILogItem[]),
    ])
    const server = proxyView ? resolveCurrent(proxyView) : null
    const expire = current?.extra?.expire
    const text = buildDiagnostics({
      time: dayjs().format('DD.MM.YYYY HH:mm Z'),
      appVersion: system?.app_version ?? '',
      system: system
        ? {
            name: system.system_name,
            version: system.system_version,
            arch: system.system_arch,
          }
        : undefined,
      coreMode: system?.app_core_mode,
      isAdmin: system?.app_is_admin,
      mode,
      connected,
      server: server
        ? [server.name, server.via ? `через ${server.via}` : '']
            .filter(Boolean)
            .join(', ')
        : undefined,
      subscription: current
        ? {
            daysLeft: expire ? daysLeft(expire, Date.now()) : null,
            updated: current.updated
              ? dayjs(current.updated * 1000).format('DD.MM HH:mm')
              : undefined,
          }
        : undefined,
      delays,
      exit: exit ?? undefined,
      coreErrors: logs
        .filter((log) => log.type === 'error' || log.type === 'warning')
        .map((log) => `${log.time ?? ''} ${log.payload}`.trim()),
    })
    await writeText(text)
    showNotice.success('origami.check.copied')
    void openExternalUrl(current?.support ?? ORIGAMI_LINKS.support)
  })

  const checked = Object.keys(delays).length > 0
  const failed = CHECK_TARGETS.filter(
    (target) =>
      delays[target.id] !== undefined && !isReachable(delays[target.id]),
  )

  return (
    <section className="o-plate o-check">
      <div className="o-check__head">
        <div>
          <div className="o-label">{t('origami.check.title')}</div>
          <div className="o-check__summary">
            {running
              ? t('origami.check.running')
              : !checked
                ? connected
                  ? t('origami.check.idle')
                  : t('origami.check.connectFirst')
                : failed.length === 0
                  ? t('origami.check.allGood')
                  : t('origami.check.someFailed')}
          </div>
          {exit && !running && (
            <div className="o-hint">
              {t('origami.check.exit', { country: exit.country })}
            </div>
          )}
        </div>
        <Button
          variant="outlined"
          size="small"
          disabled={running || !connected}
          onClick={() => void run()}
        >
          {checked ? t('origami.check.again') : t('origami.check.run')}
        </Button>
      </div>
      {checked && (
        <ul className="o-check__list">
          {CHECK_TARGETS.map((target) => {
            const delay = delays[target.id]
            const ok = isReachable(delay)
            return (
              <li
                key={target.id}
                className={
                  delay === undefined ? 'is-wait' : ok ? 'is-ok' : 'is-bad'
                }
              >
                {delay === undefined ? (
                  <span className="o-spin-dot" aria-hidden="true" />
                ) : ok ? (
                  <CheckCircleOutlineRounded fontSize="small" />
                ) : (
                  <HighlightOffRounded fontSize="small" />
                )}
                <span className="o-check__name">{target.name}</span>
                <span className="o-mono o-hint">
                  {delay === undefined
                    ? ''
                    : ok
                      ? t('origami.home.server.ping', { ms: delay })
                      : t('origami.check.unreachable')}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {!running && (
        <div className="o-check__foot">
          {failed.length > 0 && (
            <p className="o-hint">{t('origami.check.tryOther')}</p>
          )}
          <Button
            size="small"
            startIcon={<ContentCopyRounded fontSize="small" />}
            onClick={() => void copyDiagnostics()}
          >
            {t('origami.check.diagnostics')}
          </Button>
        </div>
      )}
    </section>
  )
}
