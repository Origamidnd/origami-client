import { CHECK_TARGETS, isReachable } from './targets'

export interface DiagnosticsInput {
  time: string
  appVersion: string
  system?: { name: string; version: string }
  coreMode?: string
  isAdmin?: boolean
  /** Service health and, when it refuses to run, the reason it gives. */
  service?: { state: string; reason?: string | null }
  mode: 'tun' | 'proxy'
  connected: boolean
  server?: string
  subscription?: { daysLeft: number | null; updated?: string }
  delays: Record<string, number | undefined>
  exit?: { country: string; asn: string }
  coreErrors: string[]
  /** Ready lines about recent connections, for a report that is pasted by hand. */
  connections?: string[]
}

const MAX_CORE_ERRORS = 20

/**
 * Plain-text report for support. It never includes the subscription link or the full exit IP,
 * so it is safe to paste into a chat.
 */
export const buildDiagnostics = (input: DiagnosticsInput): string => {
  const lines = [
    'OrigamiVPN: диагностика',
    `Время: ${input.time}`,
    `Приложение: ${input.appVersion}${input.coreMode ? `, ядро: ${input.coreMode}` : ''}${
      input.isAdmin === undefined
        ? ''
        : `, админ: ${input.isAdmin ? 'да' : 'нет'}`
    }`,
  ]
  if (input.system) {
    const { name, version } = input.system
    // Linux distributions repeat the name inside the version string.
    const os = version.includes(name) ? version : `${name} ${version}`
    lines.push(`Система: ${os}`)
  }
  if (input.service) {
    const { state, reason } = input.service
    lines.push(`Служба: ${state}${reason ? `, причина: ${reason}` : ''}`)
  }
  lines.push(
    `Режим: ${input.mode === 'tun' ? 'весь компьютер (TUN)' : 'браузер и программы (прокси)'}, подключено: ${
      input.connected ? 'да' : 'нет'
    }`,
  )
  if (input.server) lines.push(`Сервер: ${input.server}`)
  if (input.subscription) {
    const { daysLeft, updated } = input.subscription
    lines.push(
      `Подписка: ${daysLeft === null ? 'без срока' : `осталось дней ${daysLeft}`}${
        updated ? `, обновлена ${updated}` : ''
      }`,
    )
  }
  if (input.exit) {
    lines.push(
      `Выход: ${input.exit.country || 'страна неизвестна'}${input.exit.asn ? `, ${input.exit.asn}` : ''}`,
    )
  }
  lines.push('Проверка сервисов:')
  for (const target of CHECK_TARGETS) {
    const delay = input.delays[target.id]
    const result =
      delay === undefined
        ? 'не проверялся'
        : isReachable(delay)
          ? `открывается, ${delay} мс`
          : 'не открывается'
    lines.push(`  ${target.name}: ${result}`)
  }
  const errors = input.coreErrors.slice(-MAX_CORE_ERRORS)
  lines.push(errors.length ? 'Последние ошибки ядра:' : 'Ошибок ядра нет')
  for (const error of errors) lines.push(`  ${error}`)
  if (input.connections?.length) {
    lines.push('Соединения за последние минуты:')
    for (const line of input.connections) lines.push(`  ${line}`)
  }
  return lines.join('\n')
}
