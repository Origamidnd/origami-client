import dayjs from 'dayjs'
import { useCallback } from 'react'

import { useProfiles } from '@/hooks/use-profiles'
import { useSystemState } from '@/hooks/use-system-state'
import { useVerge } from '@/hooks/use-verge'
import { useProxiesData } from '@/providers/app-data-context'
import { getGameLinkStatus, getSystemInfo } from '@/services/cmds'
import { version } from '@root/package.json'

import { resolveCurrent } from '../current-server'
import { useConnection } from '../home/use-connection'
import { daysLeft } from '../subscription-status'

import { buildDiagnostics } from './diagnostics'

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

export interface DiagnosticsParts {
  results: CheckResults
  /** Core errors that may leave this computer. */
  coreErrors: string[]
  connections?: string[]
}

/** Builds the plain report for support; the home check adds its latest results. */
export const useDiagnosticsText = () => {
  const { connected, mode } = useConnection()
  const { current } = useProfiles()
  const { proxyView } = useProxiesData()
  const { runState } = useSystemState()
  const { verge } = useVerge()
  const gameLink = verge?.origami_game_link

  return useCallback(
    async ({ results, coreErrors, connections }: DiagnosticsParts) => {
      const [system, game] = await Promise.all([
        getSystemInfo().catch(() => undefined),
        getGameLinkStatus().catch(() => undefined),
      ])
      const server = proxyView ? resolveCurrent(proxyView) : null
      const expire = current?.extra?.expire
      return buildDiagnostics({
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
        coreErrors,
        connections,
        gameMode: {
          enabled: gameLink?.enabled ?? false,
          hasCode: Boolean(gameLink?.code?.trim()),
          running: game?.running ?? false,
          stats: game?.stats,
          secondsAgo: game?.secondsAgo,
        },
      })
    },
    [connected, current, gameLink, mode, proxyView, runState],
  )
}
