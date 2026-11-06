import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
} from '@mui/material'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { fetch } from '@tauri-apps/plugin-http'
import { useLockFn } from 'ahooks'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useProfiles } from '@/hooks/use-profiles'
import { useProxiesData } from '@/providers/app-data-context'
import { getClashLogs, getSystemInfo } from '@/services/cmds'
import { version } from '@root/package.json'

import { ORIGAMI_LINKS } from '../links'
import {
  connectionLines,
  connectionLog,
  connectionsForSending,
  defaultChosen,
  LOG_WINDOW_MINUTES,
  MAX_DIAGNOSTICS_TEXT,
  maskUserFolder,
  recentFailures,
  reportableCoreErrors,
  selectRows,
  withFailures,
  type DiagnosticsPayload,
} from '../report/connection-log'
import { reportTarget, summarizeProcesses } from '../report/model'
import { openSupportChat } from '../support-chat'

import {
  closeSendDiagnostics,
  useSendDiagnosticsRequest,
} from './send-diagnostics-store'
import { useDiagnosticsText, type CheckResults } from './use-diagnostics-text'

const SendDiagnosticsBody = ({ results }: { results: CheckResults }) => {
  const { t } = useTranslation()
  const { current } = useProfiles()
  const { proxyView } = useProxiesData()
  const buildText = useDiagnosticsText()
  const [now] = useState(() => Date.now())
  const [logs, setLogs] = useState<ILogItem[]>([])
  // Nothing ticked by hand yet: the default follows what the log adds.
  const [picked, setPicked] = useState<string[] | null>(null)
  const [comment, setComment] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let active = true
    void getClashLogs()
      .catch(() => [] as ILogItem[])
      .then((items) => {
        if (active) setLogs(items)
      })
    return () => {
      active = false
    }
  }, [])

  const rows = useMemo(
    () => withFailures(connectionLog.list(now), recentFailures(logs, now)),
    [logs, now],
  )
  const programs = useMemo(
    () => summarizeProcesses(rows).filter((program) => program.name),
    [rows],
  )
  const chosen = picked ?? defaultChosen(rows)
  const selected = selectRows(rows, chosen)
  const target = reportTarget(current?.url)
  const coreErrors = () => reportableCoreErrors(logs, chosen, Date.now())

  // The link never leaves in the report, even if a core error happens to quote it.
  const clean = (text: string) => {
    const masked = maskUserFolder(text)
    return target ? masked.split(target.shortUuid).join('***') : masked
  }

  /** Always on the clipboard too, so that a failed send costs nothing. */
  const copyReport = async () => {
    const text = await buildText({
      results,
      coreErrors: coreErrors(),
      connections: connectionLines(selected),
    })
    return writeText(clean(text)).then(
      () => true,
      () => false,
    )
  }

  const openChat = () => {
    closeSendDiagnostics()
    void openSupportChat(current?.support ?? ORIGAMI_LINKS.support)
  }

  const send = useLockFn(async () => {
    setSending(true)
    setError('')
    setCopied(await copyReport())
    if (!target) {
      setError(t('origami.report.errors.noSubscription'))
      setSending(false)
      return
    }
    try {
      const [system, text] = await Promise.all([
        getSystemInfo().catch(() => undefined),
        buildText({ results, coreErrors: coreErrors() }),
      ])
      const report: DiagnosticsPayload = {
        version: 1,
        comment: comment.trim().slice(0, 500),
        app: {
          version,
          os: system
            ? `${system.system_name} ${system.system_version}`.slice(0, 120)
            : '',
        },
        minutes: LOG_WINDOW_MINUTES,
        text: clean(text).slice(0, MAX_DIAGNOSTICS_TEXT),
        groups: (proxyView?.groups ?? [])
          .filter((group) => !group.hidden && group.now)
          .slice(0, 40)
          .map((group) => ({
            name: group.name.slice(0, 80),
            now: (group.now as string).slice(0, 160),
          })),
        programs: chosen.slice(0, 60).map((name) => name.slice(0, 120)),
        connections: connectionsForSending(selected),
      }
      const response = await fetch(`${target.endpoint}/diagnostics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shortUuid: target.shortUuid, report }),
      })
      if (response.status === 429) {
        setError(t('origami.report.errors.tooMany'))
        return
      }
      if (!response.ok) {
        setError(t('origami.report.errors.failed'))
        return
      }
      setSent(true)
    } catch {
      setError(t('origami.report.errors.failed'))
    } finally {
      setSending(false)
    }
  })

  if (sent) {
    return (
      <>
        <DialogTitle>{t('origami.sendDiagnostics.sentTitle')}</DialogTitle>
        <DialogContent>
          <div className="o-rep__body">
            <p>{t('origami.sendDiagnostics.sent')}</p>
            {copied && (
              <p className="o-hint">
                {t('origami.sendDiagnostics.sentCopied')}
              </p>
            )}
          </div>
        </DialogContent>
        <DialogActions>
          <Button variant="contained" onClick={closeSendDiagnostics}>
            {t('origami.sendDiagnostics.close')}
          </Button>
        </DialogActions>
      </>
    )
  }

  return (
    <>
      <DialogTitle>{t('origami.sendDiagnostics.title')}</DialogTitle>
      <DialogContent>
        <div className="o-rep__body">
          <TextField
            size="small"
            fullWidth
            multiline
            minRows={2}
            label={t('origami.sendDiagnostics.commentLabel')}
            placeholder={t('origami.sendDiagnostics.commentPlaceholder')}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          {programs.length === 0 ? (
            <p className="o-hint">
              {t('origami.sendDiagnostics.empty', {
                minutes: LOG_WINDOW_MINUTES,
              })}
            </p>
          ) : (
            <>
              <p className="o-rep__q">
                {t('origami.sendDiagnostics.pick', {
                  minutes: LOG_WINDOW_MINUTES,
                })}
              </p>
              <ul className="o-rep__procs o-rep__procs--scroll">
                {programs.map((program) => (
                  <li key={program.name}>
                    <label>
                      <Checkbox
                        size="small"
                        checked={chosen.includes(program.name)}
                        onChange={(_, on) =>
                          setPicked(
                            on
                              ? [...chosen, program.name]
                              : chosen.filter((name) => name !== program.name),
                          )
                        }
                      />
                      <b>{program.name}</b>
                      <span className="o-hint">
                        {t('origami.sendDiagnostics.found', {
                          total: program.total,
                          failed: program.failed,
                        })}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="o-rep__privacy">
            <p>
              <b>{t('origami.sendDiagnostics.sendsTitle')}</b>{' '}
              {t('origami.sendDiagnostics.sends')}
            </p>
            <p>
              <b>{t('origami.sendDiagnostics.keepsTitle')}</b>{' '}
              {t('origami.sendDiagnostics.keeps')}
            </p>
          </div>
          <p className="o-hint">
            {t('origami.sendDiagnostics.summary', { count: selected.length })}
          </p>
          {error && (
            <p className="o-rep__error" role="alert">
              {error}{' '}
              {t(
                copied
                  ? 'origami.sendDiagnostics.failedCopied'
                  : 'origami.sendDiagnostics.failedNotCopied',
              )}
            </p>
          )}
        </div>
      </DialogContent>
      <DialogActions>
        <Button onClick={closeSendDiagnostics}>
          {t('origami.sendDiagnostics.cancel')}
        </Button>
        {error && (
          <Button variant="outlined" onClick={openChat}>
            {t('origami.sendDiagnostics.openChat')}
          </Button>
        )}
        <Button
          variant="contained"
          loading={sending}
          onClick={() => void send()}
        >
          {t(
            error
              ? 'origami.sendDiagnostics.retry'
              : 'origami.sendDiagnostics.send',
          )}
        </Button>
      </DialogActions>
    </>
  )
}

/** Mounted once, in the sidebar. */
export const SendDiagnosticsDialog = () => {
  const results = useSendDiagnosticsRequest()

  if (!results) return null

  return (
    <Dialog
      open
      onClose={closeSendDiagnostics}
      maxWidth="sm"
      fullWidth
      className="o-rep"
    >
      <SendDiagnosticsBody results={results} />
    </Dialog>
  )
}
