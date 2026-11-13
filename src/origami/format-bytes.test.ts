import i18n from 'i18next'
import { afterEach, describe, expect, it } from 'vitest'

import { formatBytes, formatSpeed } from './format-bytes'

describe('formatBytes', () => {
  const before = i18n.language
  afterEach(() => {
    ;(i18n as { language: string }).language = before
  })

  it('speaks Russian units in Russian', () => {
    ;(i18n as { language: string }).language = 'ru'
    expect(formatBytes(13.3 * 1024 ** 3)).toBe('13.3 ГБ')
    expect(formatSpeed(0)).toBe('0.00 Б/с')
  })

  it('keeps Latin units elsewhere', () => {
    ;(i18n as { language: string }).language = 'en'
    expect(formatBytes(2048)).toBe('2.00 KB')
    expect(formatSpeed(2048)).toBe('2.00 KB/s')
  })
})
