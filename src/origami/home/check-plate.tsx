import {
  CheckCircleOutlineRounded,
  ContentCopyRounded,
  HighlightOffRounded,
  ReportProblemOutlined,
} from '@mui/icons-material'
import { Button } from '@mui/material'
import { useLockFn } from 'ahooks'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { getIpInfo } from '@/services/api'
import { cmdTestDelay } from '@/services/cmds'

import { exitCountryName } from '../check/exit-country'
import { CHECK_TARGETS, isReachable } from '../check/targets'
import { useCopyDiagnostics } from '../check/use-copy-diagnostics'
import { useLinkState } from '../link-state'
import { diagnoseLink } from '../network-recovery'
import { PingBadge } from '../ping-badge'
import { ReportDialog } from '../report/report-dialog'

import { useConnection } from './use-connection'

interface ExitInfo {
  country: string
  asn: string
}

const AUTO_CHECK_DELAY_MS = 2000
// Right after the app starts the core is still warming up and every request fails, so the
// automatic check tries again before calling anything broken. A real block fails every time.
const AUTO_CHECK_ATTEMPTS = 3
const AUTO_CHECK_RETRY_MS = 3000
// While the result says there is no internet, how often to look whether it is back.
const NO_INTERNET_RECHECK_MS = 15 * 1000

const sleep = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms))

/** «VPN работает?»: checks popular services through the core and shows the exit country. */
export const CheckPlate = () => {
  const { t, i18n } = useTranslation()
  const { connected } = useConnection()
  const [running, setRunning] = useState(false)
  const [delays, setDelays] = useState<Record<string, number | undefined>>({})
  const [exit, setExit] = useState<ExitInfo | null>(null)
  const [noInternet, setNoInternet] = useState(false)
  const wasConnectedRef = useRef(connected)

  const run = useLockFn(async (auto = false) => {
    setRunning(true)
    setDelays({})
    setNoInternet(false)
    try {
      // A manual check shows each service as it answers; the automatic one only its final try.
      const probe = () =>
        Promise.all(
          CHECK_TARGETS.map(async (target) => {
            const delay = await cmdTestDelay(target.url).catch(() => undefined)
            if (!auto) setDelays((prev) => ({ ...prev, [target.id]: delay }))
            return delay
          }),
        )
      let results = await probe()
      for (
        let attempt = 1;
        auto &&
        attempt < AUTO_CHECK_ATTEMPTS &&
        !results.every((delay) => isReachable(delay));
        attempt++
      ) {
        await sleep(AUTO_CHECK_RETRY_MS)
        results = await probe()
      }
      if (auto) {
        setDelays(
          Object.fromEntries(
            CHECK_TARGETS.map((target, index) => [target.id, results[index]]),
          ),
        )
      }
      // Every service failing says little: advice to change the server is wrong with no internet.
      if (!results.some((delay) => isReachable(delay))) {
        const offline = (await diagnoseLink()) === 'noInternet'
        setNoInternet(offline)
        if (offline) {
          setExit(null)
          return results
        }
      }
      const info = await getIpInfo().catch(() => null)
      setExit(
        info
          ? {
              country: exitCountryName(info, i18n.language),
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
      () => void runRef.current(true),
      AUTO_CHECK_DELAY_MS,
    )
    return () => window.clearTimeout(timer)
  }, [connected])

  // A red result must not outlive the outage that caused it.
  const link = useLinkState()
  const wasLinkRef = useRef(link)
  const anyFailedRef = useRef(false)
  useEffect(() => {
    const cameBack = link === 'ok' && wasLinkRef.current !== 'ok'
    wasLinkRef.current = link
    if (cameBack && connected && anyFailedRef.current) void runRef.current(true)
  }, [link, connected])

  useEffect(() => {
    if (!noInternet || !connected) return
    const timer = window.setInterval(() => {
      void diagnoseLink().then((verdict) => {
        if (verdict !== 'noInternet') void runRef.current(true)
      })
    }, NO_INTERNET_RECHECK_MS)
    return () => window.clearInterval(timer)
  }, [noInternet, connected])

  const copyDiagnostics = useCopyDiagnostics()
  const [reportOpen, setReportOpen] = useState(false)

  const checked = Object.keys(delays).length > 0
  const failed = CHECK_TARGETS.filter(
    (target) =>
      delays[target.id] !== undefined && !isReachable(delays[target.id]),
  )
  anyFailedRef.current = failed.length > 0

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
                : noInternet
                  ? t('origami.check.noInternet')
                  : failed.length === 0
                    ? t('origami.check.allGood')
                    : t('origami.check.someFailed')}
          </div>
          {exit?.country && !running && !noInternet && (
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
                {delay === undefined ? null : ok ? (
                  <PingBadge delay={delay} tone="plain" />
                ) : (
                  <span className="o-ping is-dead">
                    {t('origami.check.unreachable')}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {!running && (
        <div className="o-check__foot">
          {failed.length > 0 && (
            <p className="o-hint">
              {noInternet
                ? t('origami.check.noInternetHint')
                : t('origami.check.tryOther')}
            </p>
          )}
          <Button
            size="small"
            startIcon={<ReportProblemOutlined fontSize="small" />}
            onClick={() => setReportOpen(true)}
          >
            {t('origami.report.open')}
          </Button>
          <Button
            size="small"
            startIcon={<ContentCopyRounded fontSize="small" />}
            onClick={() =>
              void copyDiagnostics({ delays, exit: exit ?? undefined })
            }
          >
            {t('origami.check.diagnostics')}
          </Button>
        </div>
      )}
      <ReportDialog open={reportOpen} onClose={() => setReportOpen(false)} />
    </section>
  )
}
