import { expect, it, vi } from 'vitest'

import { countriesOf, shortList, silentCountries } from './services'

vi.mock('@/services/delay', () => ({ default: {} }))

const FI = '🔷 🇫🇮 Финляндия'
const FI_X = '🔷 🇫🇮 Финляндия (xHTTP)'
const TR = '🔶 🇹🇷 Турция'
const ALL = [FI, FI_X, TR]

it('says nothing about a country with a variant that answers', () => {
  expect(silentCountries(ALL, [FI_X])).toEqual([])
})

it('names a country once when none of its variants answer', () => {
  expect(silentCountries(ALL, [FI, FI_X])).toEqual(['🇫🇮 Финляндия'.slice(5)])
})

it('tells countries, not variants', () => {
  expect(countriesOf([FI, FI_X, TR]).length).toBe(2)
})

it('keeps a long list short', () => {
  expect(shortList(['a', 'b', 'c', 'd', 'e'])).toEqual({
    shown: ['a', 'b', 'c'],
    more: 2,
  })
})
