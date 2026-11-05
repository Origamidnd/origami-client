import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { useLockFn } from 'ahooks'
import dayjs from 'dayjs'

import { useProfiles } from '@/hooks/use-profiles'
import { useSystemState } from '@/hooks/use-system-state'
import { useProxiesData } from '@/providers/app-data-context'
import { getClashLogs, getSystemInfo } from '@/services/cmds'
import { version } from '@root/package.json'

import { resolveCurrent } from '../current-server'
import { useConnection } from '../home/use-connection'
import { ORIGAMI_LINKS } from '../links'
import { daysLeft } from '../subscription-status'

import { buildDiagnostics } from './diagnostics'
import { showDiagnosticsCopied } from './diagnostics-copied-store'

// Plain words for support; the raw kind is kept in brackets for searching upstream issues.
const SERVICE_STATES: Record<string, string> = {
  ready: 'работает',
  notInstalled: 'не установлена',
  versionMismatch: 'другая версия, нужна переустановка',
  unavailable: 'не запускается',
  unknown: 'неизвестно',
}

export interface CheckResults {
  delays: Record<string, number | undefined>
  exit?: { country: string; asn: string }
}

/** Copies the support report and says what to do with it; the home check adds its latest results. */
export const useCopyDiagnostics = () => {
  const { connected, mode } = useConnection()
  const { current } = useProfiles()
  const { proxyView } = useProxiesData()
  const { runState } = useSystemState()

  return useLockFn(async (results: CheckResults = { delays: {} }) => {
    const [system, logs] = await Promise.all([
      getSystemInfo().catch(() => undefined),
      getClashLogs().catch(() => [] as ILogItem[]),
    ])
    const server = proxyView ? resolveCurrent(proxyView) : null
    const expire = current?.extra?.expire
    const text = buildDiagnostics({
      time: dayjs().format('DD.MM.YYYY HH:mm Z'),
      appVersion: version,
      system: system
        ? {
            name: system.system_name,
            version: system.system_version,
          }
        : undefined,
      coreMode: runState.mode,
      isAdmin: runState.isAdmin,
      service: {
        state: `${SERVICE_STATES[runState.service] ?? runState.service} (${runState.service})`,
        reason: runState.serviceUnavailableReason,
      },
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
      delays: results.delays,
      exit: results.exit,
      coreErrors: logs
        .filter((log) => log.type === 'error' || log.type === 'warning')
        .map((log) => `${log.time ?? ''} ${log.payload}`.trim()),
    })
    await writeText(text)
    showDiagnosticsCopied(current?.support ?? ORIGAMI_LINKS.support)
  })
}
