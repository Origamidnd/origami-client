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
  /** Traffic is ready text, "9.71 МБ из 15.0 МБ", left out without a limit. */
  subscription?: { daysLeft: number | null; updated?: string; traffic?: string }
  /** Which way the clock is off, by the last subscription answer. */
  clock?: 'ahead' | 'behind' | null
  /** The group that carries games and what it picked now. */
  gameGroup?: { name: string; now: string }
  delays: Record<string, number | undefined>
  exit?: { country: string; asn: string }
  coreErrors: string[]
  /** Ready lines about recent connections, for a report that is pasted by hand. */
  connections?: string[]
  /** Game mode (test): left out for everyone who never turned it on or saved a code. */
  gameMode?: GameModeState
}

export interface GameModeState {
  enabled: boolean
  hasCode: boolean
  /** The multiplexer runs now. */
  running: boolean
  /** Its counters, once the game sent anything. */
  stats?: string | null
  secondsAgo?: number | null
}

const gameModeLine = (game: GameModeState): string | null => {
  if (!game.enabled) return game.hasCode ? 'Игровой режим: выключен' : null
  if (!game.running)
    return 'Игровой режим: включён, но не работает (код не читается или порт занят)'
  if (!game.stats) return 'Игровой режим: работает, пакетов от игры не было'
  const age =
    game.secondsAgo == null
      ? ''
      : ` (${Math.round(game.secondsAgo / 60)} мин назад)`
  // The game spoke and nothing came back: the far end or the way to it is the suspect.
  const silent = /from game [1-9]\d*, to game 0\b/.test(game.stats)
    ? ', ответов от сервера не было'
    : ''
  return `Игровой режим: работает, ${game.stats}${age}${silent}`
}

const PROVIDER_PULL = /^(.*?)\[Provider\] (\S+) pull error: (.*)$/
// The reason quotes each list's own URL; the host alone is enough and lets equal reasons meet.
const shortReason = (reason: string) =>
  reason.replace(/"https?:\/\/([^/"]+)[^"]*"/g, '$1')

/**
 * Every rule list fails at once when the subscription host is unreachable, and twenty equal lines
 * would push the other errors out of the report. They become one line per reason, at the last one.
 */
const squeezeProviderErrors = (errors: string[]) => {
  const groups = new Map<
    string,
    { at: number; prefix: string; names: string[] }
  >()
  errors.forEach((error, at) => {
    const match = error.match(PROVIDER_PULL)
    if (!match) return
    const [, prefix, name, reason] = match
    const key = shortReason(reason)
    const group = groups.get(key) ?? { at, prefix, names: [] }
    group.at = at
    group.prefix = prefix
    group.names.push(name)
    groups.set(key, group)
  })
  if (!groups.size) return errors
  const last = new Map([...groups].map(([reason, group]) => [group.at, reason]))
  return errors.flatMap((error, at) => {
    const reason = last.get(at)
    if (reason !== undefined) {
      const { prefix, names } = groups.get(reason)!
      const shown = names.slice(0, 5).join(', ')
      const more = names.length > 5 ? ` и ещё ${names.length - 5}` : ''
      return [
        `${prefix}[Provider] списки правил не обновились (${names.length}: ${shown}${more}): ${reason}`,
      ]
    }
    return PROVIDER_PULL.test(error) ? [] : [error]
  })
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
  if (input.gameGroup)
    lines.push(`${input.gameGroup.name}: ${input.gameGroup.now}`)
  if (input.subscription) {
    const { daysLeft, updated, traffic } = input.subscription
    lines.push(
      `Подписка: ${daysLeft === null ? 'без срока' : `осталось дней ${daysLeft}`}${
        traffic ? `, трафик ${traffic}` : ''
      }${updated ? `, обновлена ${updated}` : ''}`,
    )
  }
  if (input.clock)
    lines.push(
      `Часы: ${input.clock === 'behind' ? 'отстают' : 'спешат'}, VPN может не подключаться`,
    )
  if (input.exit) {
    lines.push(
      `Выход: ${input.exit.country || 'страна неизвестна'}${input.exit.asn ? `, ${input.exit.asn}` : ''}`,
    )
  }
  const game = input.gameMode && gameModeLine(input.gameMode)
  if (game) lines.push(game)
  const checked = CHECK_TARGETS.some(
    (target) => input.delays[target.id] !== undefined,
  )
  lines.push(
    checked ? 'Проверка сервисов:' : 'Проверка сервисов: не запускалась',
  )
  for (const target of checked ? CHECK_TARGETS : []) {
    const delay = input.delays[target.id]
    const result =
      delay === undefined
        ? 'не проверялся'
        : isReachable(delay)
          ? `открывается, ${delay} мс`
          : 'не открывается'
    lines.push(`  ${target.name}: ${result}`)
  }
  const errors = squeezeProviderErrors(input.coreErrors).slice(-MAX_CORE_ERRORS)
  lines.push(errors.length ? 'Последние ошибки ядра:' : 'Ошибок ядра нет')
  for (const error of errors) lines.push(`  ${error}`)
  if (input.connections?.length) {
    lines.push('Соединения за последние минуты:')
    for (const line of input.connections) lines.push(`  ${line}`)
  }
  return lines.join('\n')
}
