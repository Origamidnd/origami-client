import { CHECK_TARGETS, isReachable } from './targets'

export interface DiagnosticsInput {
  time: string
  appVersion: string
  system?: { name: string; version: string; arch: string }
  coreMode?: string
  isAdmin?: boolean
  mode: 'tun' | 'proxy'
  connected: boolean
  server?: string
  subscription?: { daysLeft: number | null; updated?: string }
  delays: Record<string, number | undefined>
  exit?: { country: string; asn: string }
  coreErrors: string[]
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
    const { name, version, arch } = input.system
    // Linux distributions repeat the name inside the version string.
    const os = version.includes(name) ? version : `${name} ${version}`
    lines.push(`Система: ${os} (${arch})`)
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
      `Выход: ${input.exit.country}${input.exit.asn ? `, ${input.exit.asn}` : ''}`,
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
  return lines.join('\n')
}
