import i18n from 'i18next'

import parseTraffic from '@/utils/parse-traffic'

// The stock formatter speaks Latin units; next to "мс" and Russian words "MB/s" looks foreign.
const RU_UNITS: Record<string, string> = {
  B: 'Б',
  KB: 'КБ',
  MB: 'МБ',
  GB: 'ГБ',
  TB: 'ТБ',
  PB: 'ПБ',
}

const russian = () => (i18n.language ?? '').startsWith('ru')

/** "13.3 ГБ" in Russian, "13.3 GB" elsewhere. */
export const formatBytes = (value: number) => {
  const [amount, unit] = parseTraffic(value)
  return `${amount} ${russian() ? (RU_UNITS[unit] ?? unit) : unit}`
}

/** "1.20 МБ/с" in Russian, "1.20 MB/s" elsewhere. */
export const formatSpeed = (value: number) =>
  `${formatBytes(value)}${russian() ? '/с' : '/s'}`
