export type ServiceIconKey =
  | 'other'
  | 'blocked'
  | 'youtube'
  | 'discord'
  | 'telegram'
  | 'games'
  | 'music'
  | 'twitch'
  | 'ai'
  | 'google'
  | 'russia'
  | 'own'
  | 'unknown'

// Group names come from the subscription with an emoji in front, which other apps (Happ, stock
// Clash Verge) show as is. Only this client swaps them for a drawn icon, so the template stays put.
const ICONS: [RegExp, ServiceIconKey][] = [
  // The user's own routes (added by this client, not the template).
  [/свои правила/i, 'own'],
  // "Остальные незаблокированные" also contains "заблокир", so it goes first.
  [/остальн|other/i, 'other'],
  [/заблокир|blocked/i, 'blocked'],
  [/youtube/i, 'youtube'],
  [/discord/i, 'discord'],
  [/telegram/i, 'telegram'],
  [/игр|game/i, 'games'],
  [/музык|music|spotify/i, 'music'],
  [/twitch/i, 'twitch'],
  [/нейросет|\bai\b/i, 'ai'],
  [/google/i, 'google'],
  [/ру-сайт|росси|\bru\b/i, 'russia'],
]

// One calm colour per category for the origami tiles; the tile mixes it with the plate colour,
// so the same values work in both themes.
export const GLYPH_HUES: Record<ServiceIconKey | 'auto' | 'direct', string> = {
  blocked: '#E0702B',
  other: '#5B7BD5',
  youtube: '#E5484D',
  discord: '#5865F2',
  telegram: '#2AABEE',
  games: '#8E4EC6',
  music: '#30A46C',
  twitch: '#9146FF',
  ai: '#D6409F',
  google: '#4285F4',
  russia: '#12A594',
  own: '#C9973A',
  unknown: '#8B8D98',
  auto: '#F5A524',
  direct: '#8B8D98',
}

export const serviceIconKey = (groupName: string): ServiceIconKey =>
  ICONS.find(([pattern]) => pattern.test(groupName))?.[1] ?? 'unknown'

// Leading emoji and marks from the template ("🔷 🇫🇮 Финляндия", "🎲 Авто-выбор"), flags kept.
export const withoutEmoji = (name: string) =>
  name.replace(/^(?:(?![\u{1F1E6}-\u{1F1FF}])[^\p{L}\p{N}])+/u, '').trim() ||
  name
