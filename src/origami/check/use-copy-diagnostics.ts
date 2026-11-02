import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { useLockFn } from 'ahooks'
import dayjs from 'dayjs'

import { useProfiles } from '@/hooks/use-profiles'
import { useProxiesData } from '@/providers/app-data-context'
import { getClashLogs, getSystemInfo } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'
import { openExternalUrl } from '@/utils/open-external-url'

import { resolveCurrent } from '../current-server'
import { useConnection } from '../home/use-connection'
import { ORIGAMI_LINKS } from '../links'
import { daysLeft } from '../subscription-status'

import { buildDiagnostics } from './diagnostics'

export interface CheckResults {
  delays: Record<string, number | undefined>
  exit?: { country: string; asn: string }
}

/** Copies the support report and opens the support chat; the home check adds its latest results. */
export const useCopyDiagnostics = () => {
  const { connected, mode } = useConnection()
  const { current } = useProfiles()
  const { proxyView } = useProxiesData()

  return useLockFn(async (results: CheckResults = { delays: {} }) => {
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
      delays: results.delays,
      exit: results.exit,
      coreErrors: logs
        .filter((log) => log.type === 'error' || log.type === 'warning')
        .map((log) => `${log.time ?? ''} ${log.payload}`.trim()),
    })
    await writeText(text)
    showNotice.success('origami.check.copied')
    void openExternalUrl(current?.support ?? ORIGAMI_LINKS.support)
  })
}
