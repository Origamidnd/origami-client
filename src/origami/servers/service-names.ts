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
  | 'unknown'

// Group names come from the subscription with an emoji in front, which other apps (Happ, stock
// Clash Verge) show as is. Only this client swaps them for a drawn icon, so the template stays put.
const ICONS: [RegExp, ServiceIconKey][] = [
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

export const serviceIconKey = (groupName: string): ServiceIconKey =>
  ICONS.find(([pattern]) => pattern.test(groupName))?.[1] ?? 'unknown'

// Leading emoji and marks from the template ("🔷 🇫🇮 Финляндия", "🎲 Авто-выбор"), flags kept.
export const withoutEmoji = (name: string) =>
  name.replace(/^(?:(?![\u{1F1E6}-\u{1F1FF}])[^\p{L}\p{N}])+/u, '').trim() ||
  name
