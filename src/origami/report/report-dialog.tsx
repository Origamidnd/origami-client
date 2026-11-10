import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
} from '@mui/material'
import { fetch } from '@tauri-apps/plugin-http'
import { useLockFn } from 'ahooks'
import { useEffect, useMemo, useReducer, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useProfiles } from '@/hooks/use-profiles'
import { useProxiesData } from '@/providers/app-data-context'
import { getSystemInfo } from '@/services/cmds'
import { version } from '@root/package.json'

import { ORIGAMI_LINKS } from '../links'
import { openSupportChat } from '../support-chat'

import {
  REPORT_TIMEOUT_MS,
  buildPayload,
  preselectProcesses,
  reportTarget,
  selectEntries,
  suggestRules,
  summarizeProcesses,
  type ReportEntry,
  type ReportKind,
} from './model'
import { MAX_RECORD_MS, useRecorder } from './use-recorder'

type Step = 'what' | 'record' | 'review' | 'sent'

// Template groups the suggested rules point to; the owner can still change them.
const GROUP_PATTERNS: Record<ReportKind, [RegExp, string]> = {
  app: [/игр/i, '🎮 Игры'],
  site: [/заблокирован/i, '🚫 Заблокированные сервисы'],
}

const formatTime = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

interface Props {
  open: boolean
  onClose: () => void
}

/** «Сообщить о блокировке»: what broke, record it, review and send. */
export const ReportDialog = ({ open, onClose }: Props) => {
  const { t } = useTranslation()
  const { current } = useProfiles()
  const { proxyView } = useProxiesData()
  const recorder = useRecorder()
  const [step, setStep] = useState<Step>('what')
  const [kind, setKind] = useState<ReportKind>('app')
  const [title, setTitle] = useState('')
  const [comment, setComment] = useState('')
  const [entries, setEntries] = useState<ReportEntry[]>([])
  const [chosen, setChosen] = useState<string[]>([])
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  // Clock for the recording timer; ticks once a second while recording.
  const [now, tick] = useReducer(() => Date.now(), 0)

  useEffect(() => {
    if (!recorder.recording) return
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [recorder.recording])

  const reset = () => {
    setStep('what')
    setTitle('')
    setComment('')
    setEntries([])
    setChosen([])
    setError('')
  }

  const close = () => {
    if (recorder.recording) void recorder.stop()
    onClose()
    // Keep the typed text while the window closes; start clean next time.
    window.setTimeout(reset, 300)
  }

  const finishRecording = useLockFn(async () => {
    const recorded = await recorder.stop()
    setEntries(recorded)
    setChosen(preselectProcesses(kind, title, summarizeProcesses(recorded)))
    setStep('review')
  })

  const group = useMemo(() => {
    const [pattern, fallback] = GROUP_PATTERNS[kind]
    return (
      proxyView?.groups.find((g) => !g.hidden && pattern.test(g.name)) ?? {
        name: fallback,
        now: undefined,
      }
    )
  }, [kind, proxyView])

  const selected = selectEntries(kind, entries, chosen, title)
  const processes = summarizeProcesses(entries)
  const target = reportTarget(current?.url)

  const send = useLockFn(async () => {
    if (!target) {
      setError(t('origami.report.errors.noSubscription'))
      return
    }
    setSending(true)
    setError('')
    try {
      const system = await getSystemInfo().catch(() => undefined)
      const payload = buildPayload({
        kind,
        title,
        comment,
        site: kind === 'site' ? title : undefined,
        app: {
          version,
          os: system ? `${system.system_name} ${system.system_version}` : '',
        },
        service: group.now ? { name: group.name, now: group.now } : undefined,
        seconds: recorder.startedAt
          ? Math.round(
              Math.min(Date.now() - recorder.startedAt, MAX_RECORD_MS) / 1000,
            )
          : 0,
        processes: chosen,
        entries: selected,
        rules: suggestRules(kind, selected, chosen, group.name),
      })
      const response = await fetch(target.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shortUuid: target.shortUuid, report: payload }),
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      })
      if (response.status === 429) {
        setError(t('origami.report.errors.tooMany'))
        return
      }
      if (!response.ok) {
        setError(t('origami.report.errors.failed'))
        return
      }
      setStep('sent')
    } catch {
      setError(t('origami.report.errors.failed'))
    } finally {
      setSending(false)
    }
  })

  const elapsed = recorder.startedAt ? Math.max(0, now - recorder.startedAt) : 0
  const live = summarizeProcesses(recorder.entries).filter((p) => p.name)

  return (
    <Dialog
      open={open}
      onClose={close}
      maxWidth="sm"
      fullWidth
      className="o-rep"
    >
      <DialogTitle>
        {step === 'sent'
          ? t('origami.report.sentTitle')
          : t('origami.report.title')}
        {step !== 'sent' && (
          <span className="o-rep__step">
            {t('origami.report.step', {
              n: step === 'what' ? 1 : step === 'record' ? 2 : 3,
            })}
          </span>
        )}
      </DialogTitle>
      <DialogContent>
        {step === 'what' && (
          <div className="o-rep__body">
            <p className="o-rep__q">{t('origami.report.what')}</p>
            <div className="o-rep__kinds" role="radiogroup">
              {(['app', 'site'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={kind === value}
                  className={`o-rep__kind${kind === value ? ' is-on' : ''}`}
                  onClick={() => setKind(value)}
                >
                  {t(`origami.report.kinds.${value}`)}
                </button>
              ))}
            </div>
            <TextField
              size="small"
              fullWidth
              autoFocus
              label={t(`origami.report.titleLabel.${kind}`)}
              placeholder={t(`origami.report.titlePlaceholder.${kind}`)}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <TextField
              size="small"
              fullWidth
              multiline
              minRows={2}
              label={t('origami.report.commentLabel')}
              placeholder={t('origami.report.commentPlaceholder')}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </div>
        )}

        {step === 'record' && (
          <div className="o-rep__body">
            <p>{t(`origami.report.recordHint.${kind}`)}</p>
            {recorder.recording ? (
              <div className="o-rep__rec">
                <span className="o-rep__dot" aria-hidden="true" />
                {t('origami.report.recording', { time: formatTime(elapsed) })}
              </div>
            ) : null}
            {live.length > 0 && (
              <ul className="o-rep__live">
                {live.slice(0, 6).map((p) => (
                  <li key={p.name}>
                    <b>{p.name}</b>
                    <span className="o-hint">
                      {t('origami.report.found', {
                        total: p.total,
                        failed: p.failed,
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {step === 'review' && (
          <div className="o-rep__body">
            {processes.filter((p) => p.name).length === 0 ? (
              <p className="o-hint">{t('origami.report.nothing')}</p>
            ) : (
              <>
                <p className="o-rep__q">{t('origami.report.pick')}</p>
                <ul className="o-rep__procs">
                  {processes
                    .filter((p) => p.name)
                    .slice(0, 12)
                    .map((p) => (
                      <li key={p.name}>
                        <label>
                          <Checkbox
                            size="small"
                            checked={chosen.includes(p.name)}
                            onChange={(_, on) =>
                              setChosen(
                                on
                                  ? [...chosen, p.name]
                                  : chosen.filter((name) => name !== p.name),
                              )
                            }
                          />
                          <b>{p.name}</b>
                          <span className="o-hint">
                            {t('origami.report.found', {
                              total: p.total,
                              failed: p.failed,
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
                <b>{t('origami.report.sendsTitle')}</b>{' '}
                {t('origami.report.sends')}
              </p>
              <p>
                <b>{t('origami.report.keepsTitle')}</b>{' '}
                {t('origami.report.keeps')}
              </p>
            </div>
            <p className="o-hint">
              {t('origami.report.summary', { count: selected.length })}
            </p>
            {error && (
              <p className="o-rep__error" role="alert">
                {error}{' '}
                <button
                  type="button"
                  className="o-srv__link"
                  onClick={() =>
                    void openSupportChat(
                      current?.support ?? ORIGAMI_LINKS.support,
                    )
                  }
                >
                  {t('origami.report.support')}
                </button>
              </p>
            )}
          </div>
        )}

        {step === 'sent' && (
          <div className="o-rep__body">
            <p>{t('origami.report.sent')}</p>
          </div>
        )}
      </DialogContent>
      <DialogActions>
        {step === 'what' && (
          <>
            <Button variant="outlined" onClick={close}>
              {t('origami.report.cancel')}
            </Button>
            <Button
              variant="contained"
              disabled={!title.trim()}
              onClick={() => setStep('record')}
            >
              {t('origami.report.next')}
            </Button>
          </>
        )}
        {step === 'record' && (
          <>
            <Button variant="outlined" onClick={close}>
              {t('origami.report.cancel')}
            </Button>
            {recorder.recording ? (
              <Button
                variant="contained"
                onClick={() => void finishRecording()}
              >
                {t('origami.report.done')}
              </Button>
            ) : (
              <Button variant="contained" onClick={() => void recorder.start()}>
                {t('origami.report.start')}
              </Button>
            )}
          </>
        )}
        {step === 'review' && (
          <>
            <Button variant="outlined" onClick={() => setStep('record')}>
              {t('origami.report.again')}
            </Button>
            <Button
              variant="contained"
              loading={sending}
              disabled={selected.length === 0 && !comment.trim()}
              onClick={() => void send()}
            >
              {t('origami.report.send')}
            </Button>
          </>
        )}
        {step === 'sent' && (
          <Button variant="contained" onClick={close}>
            {t('origami.report.close')}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
