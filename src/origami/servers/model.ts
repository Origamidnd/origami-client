// Turns the Mihomo template's groups and server names into what the simple Servers tab shows.
// Server names follow the panel template: "🔷 🇫🇮 Финляндия (xHTTP)", "🔶 🇺🇸 США", "🎮 Игровой".

export type ServerCategory = 'main' | 'extra' | 'other'

export interface ParsedServer {
  category: ServerCategory
  /** Country or server name without the marker and the transport, e.g. "🇫🇮 Финляндия". */
  base: string
  /** Transport shown to people: "Обычный", "xHTTP", "gRPC" or "Hysteria2". */
  variant: string
}

export const PLAIN_VARIANT = 'Обычный'

const TRANSPORTS: Record<string, string> = {
  xhttp: 'xHTTP',
  grpc: 'gRPC',
  hysteria2: 'Hysteria2',
  hy2: 'Hysteria2',
}

// 🔷 marks the main servers, 🔶 the extra ones (AI, work, other countries).
const MARKERS: [string, ServerCategory][] = [
  ['🔷', 'main'],
  ['🔶', 'extra'],
]

export const parseServerName = (name: string, type?: string): ParsedServer => {
  let rest = name.replace(/\s+/g, ' ').trim()
  let category: ServerCategory = 'other'
  for (const [marker, value] of MARKERS) {
    if (rest.startsWith(marker)) {
      category = value
      rest = rest.slice(marker.length).trim()
      break
    }
  }

  let variant: string | undefined
  const brackets = /\s*\(([^)]*)\)\s*$/.exec(rest)
  if (brackets) {
    const parts = brackets[1].split(',').map((part) => part.trim())
    const transport = parts.find((part) => TRANSPORTS[part.toLowerCase()])
    if (transport) {
      variant = TRANSPORTS[transport.toLowerCase()]
      const kept = parts.filter((part) => part !== transport)
      rest =
        rest.slice(0, brackets.index) +
        (kept.length ? ` (${kept.join(', ')})` : '')
    }
  }
  if (!variant) {
    const suffix = /\s+(Hy2)$/i.exec(rest)
    if (suffix) {
      variant = TRANSPORTS.hy2
      rest = rest.slice(0, suffix.index)
    }
  }
  variant ??= type?.toLowerCase() === 'hysteria2' ? 'Hysteria2' : PLAIN_VARIANT

  return { category, base: rest.trim(), variant }
}

export interface ServerOption {
  /** Exact proxy name to select in the group. */
  name: string
  variant: string
  /** Last delay in ms; null when it did not answer, undefined when not checked yet. */
  delay: number | null | undefined
}

export interface CountryOption {
  base: string
  category: ServerCategory
  variants: ServerOption[]
}

/** Groups variants of one country together, keeping the template's order of countries. */
export const groupCountries = (
  servers: { name: string; type?: string; delay: number | null | undefined }[],
): CountryOption[] => {
  const countries = new Map<string, CountryOption>()
  for (const server of servers) {
    const parsed = parseServerName(server.name, server.type)
    const key = `${parsed.category}:${parsed.base}`
    let country = countries.get(key)
    if (!country) {
      country = { base: parsed.base, category: parsed.category, variants: [] }
      countries.set(key, country)
    }
    country.variants.push({
      name: server.name,
      variant: parsed.variant,
      delay: server.delay,
    })
  }
  return [...countries.values()]
}

const isAlive = (option: ServerOption) =>
  typeof option.delay === 'number' && option.delay > 0

/** A click on a country takes its fastest answering variant, like Auto does across countries. */
export const fastestVariant = (country: CountryOption): ServerOption => {
  const alive = country.variants.filter(isAlive)
  if (alive.length === 0) {
    return (
      country.variants.find((option) => option.variant === PLAIN_VARIANT) ??
      country.variants[0]
    )
  }
  return alive.reduce((best, option) =>
    (option.delay as number) < (best.delay as number) ? option : best,
  )
}

export const countryAnswers = (country: CountryOption) =>
  country.variants.some((option) => option.delay !== null)

export type PingLevel = 'fast' | 'mid' | 'slow' | 'dead' | 'unknown'

export const pingLevel = (delay: number | null | undefined): PingLevel => {
  if (delay === null) return 'dead'
  if (delay === undefined) return 'unknown'
  if (delay < 60) return 'fast'
  if (delay < 120) return 'mid'
  return 'slow'
}

// Friendlier names for template groups and a line on what each one covers.
// Kept in step with the Default Mihomo template rules (origami-infra panel/templates).
const SERVICE_TITLES: Record<string, { title?: string; hint: string }> = {
  '🚫 Заблокированные сервисы': {
    title: 'Заблокированные сайты',
    hint: 'Instagram, Facebook, X, TikTok, GitHub и другие сайты, которые в России не открываются без VPN',
  },
  '🌐 Остальные незаблокированные сервисы': {
    title: 'Остальные сайты',
    hint: 'Всё, что не попало в другие пункты: остальные зарубежные сайты и программы',
  },
  '▶️ YouTube': { hint: 'YouTube и YouTube Music, в браузере и в приложениях' },
  '💬 Discord': { hint: 'Discord целиком: чаты, голосовые каналы и стримы' },
  '➤ Telegram': { hint: 'Telegram и AyuGram: сообщения, звонки, файлы' },
  '🎮 Игры': {
    hint: 'Игры, которые настроены отдельно, и античиты (EAC, BattlEye, Vanguard, FACEIT). Обычно лучше без VPN - так ниже пинг',
  },
  '🎵 Музыка': { hint: 'Spotify, SoundCloud, Deezer, Tidal и Apple Music' },
  '📺 Twitch': { hint: 'Twitch: стримы, чат и записи' },
  '🤖 Нейросети (AI)': {
    title: 'Нейросети',
    hint: 'ChatGPT, Claude, Gemini, Google AI Studio и другие. Gemini идёт отсюда, даже если открыт из сервисов Google',
  },
  '🔍 Google Services': {
    title: 'Google',
    hint: 'Поиск (с его ИИ-ответами), Gmail, Диск, Документы, Таблицы, Meet, Карты и другие сервисы Google. YouTube и Gemini - в своих пунктах',
  },
  '🇷🇺 Ру-сайты': {
    title: 'Российские сайты, банки, Госуслуги',
    hint: 'Российские сайты и приложения. Лучше без VPN: так быстрее, и они не ругаются на зарубежный IP',
  },
}

export interface ServiceTitle {
  icon: string
  title: string
  hint?: string
}

/** Splits "▶️ YouTube" into an icon and a title, renaming a few template groups. */
export const serviceTitle = (groupName: string): ServiceTitle => {
  const space = groupName.indexOf(' ')
  const icon = space > 0 ? groupName.slice(0, space) : ''
  const known = SERVICE_TITLES[groupName]
  const title = space > 0 ? groupName.slice(space + 1).trim() : groupName
  return { icon, title: known?.title ?? title, hint: known?.hint }
}
