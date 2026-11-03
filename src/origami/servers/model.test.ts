import { describe, expect, it } from 'vitest'

import {
  fastestVariant,
  groupCountries,
  parseServerName,
  pingLevel,
  serviceTitle,
} from './model'

describe('parseServerName', () => {
  it('splits marker, country and transport', () => {
    expect(parseServerName('🔷 🇫🇮 Финляндия (xHTTP)')).toEqual({
      category: 'main',
      base: '🇫🇮 Финляндия',
      variant: 'xHTTP',
    })
    expect(parseServerName('🔶 🇺🇸 США')).toEqual({
      category: 'extra',
      base: '🇺🇸 США',
      variant: 'Обычный',
    })
  })

  it('collapses double spaces and keeps non-transport notes in brackets', () => {
    expect(parseServerName('🔷  🇩🇪  Германия (gRPC)').base).toBe('🇩🇪 Германия')
    expect(parseServerName('🔷 🇫🇮 Финляндия (МСК-2, xHTTP)')).toMatchObject({
      base: '🇫🇮 Финляндия (МСК-2)',
      variant: 'xHTTP',
    })
    expect(parseServerName('🔶 🇷🇺 Россия (Discord/YouTube)')).toMatchObject({
      base: '🇷🇺 Россия (Discord/YouTube)',
      variant: 'Обычный',
    })
  })

  it('knows Hysteria2 by suffix or by type', () => {
    expect(parseServerName('🍔 SweetyHake Hy2')).toEqual({
      category: 'other',
      base: '🍔 SweetyHake',
      variant: 'Hysteria2',
    })
    expect(parseServerName('🎮 Игровой', 'Hysteria2').variant).toBe('Hysteria2')
  })
})

describe('groupCountries and fastestVariant', () => {
  const countries = groupCountries([
    { name: '🔷 🇸🇪 Швеция', delay: 127 },
    { name: '🔷 🇸🇪 Швеция (xHTTP)', delay: null },
    { name: '🔷 🇸🇪 Швеция (gRPC)', delay: 51 },
    { name: '🔶 🇺🇸 США', delay: undefined },
  ])

  it('keeps one entry per country in template order', () => {
    expect(countries.map((c) => c.base)).toEqual(['🇸🇪 Швеция', '🇺🇸 США'])
    expect(countries[0].variants.map((v) => v.variant)).toEqual([
      'Обычный',
      'xHTTP',
      'gRPC',
    ])
  })

  it('picks the fastest variant that answers', () => {
    expect(fastestVariant(countries[0]).name).toBe('🔷 🇸🇪 Швеция (gRPC)')
  })

  it('falls back to the plain variant when nothing was checked', () => {
    expect(fastestVariant(countries[1]).name).toBe('🔶 🇺🇸 США')
  })
})

describe('pingLevel', () => {
  it('maps delays to colours', () => {
    expect(pingLevel(30)).toBe('fast')
    expect(pingLevel(90)).toBe('mid')
    expect(pingLevel(300)).toBe('slow')
    expect(pingLevel(null)).toBe('dead')
    expect(pingLevel(undefined)).toBe('unknown')
  })
})

describe('serviceTitle', () => {
  it('renames template groups that read badly', () => {
    expect(serviceTitle('🇷🇺 Ру-сайты')).toMatchObject({
      icon: '🇷🇺',
      title: 'Российские сайты, банки, Госуслуги',
    })
    expect(serviceTitle('▶️ YouTube')).toMatchObject({
      icon: '▶️',
      title: 'YouTube',
    })
  })

  it('explains what each known group covers', () => {
    expect(serviceTitle('🎵 Музыка').hint).toContain('Spotify')
    expect(serviceTitle('🔍 Google Services').hint).toContain('Gmail')
    expect(serviceTitle('🧪 Новая группа')).toEqual({
      icon: '🧪',
      title: 'Новая группа',
      hint: undefined,
    })
  })
})
