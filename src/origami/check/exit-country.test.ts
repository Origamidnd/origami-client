import { describe, expect, it } from 'vitest'

import { exitCountryName } from './exit-country'

describe('exitCountryName', () => {
  it('names the country by its code in the UI language', () => {
    expect(
      exitCountryName({ country: 'Finland', country_code: 'FI' }, 'ru'),
    ).toBe('Финляндия')
    expect(
      exitCountryName({ country: 'The Netherlands', country_code: 'nl' }, 'ru'),
    ).toBe('Нидерланды')
  })

  it('treats a two-letter country as a code', () => {
    expect(exitCountryName({ country: 'DE' }, 'ru')).toBe('Германия')
  })

  it('keeps the service name when there is no code', () => {
    expect(exitCountryName({ country: 'Finland' }, 'ru')).toBe('Finland')
  })

  it('is empty when the service said nothing', () => {
    expect(exitCountryName({ country: '', country_code: '' }, 'ru')).toBe('')
    expect(exitCountryName({}, 'ru')).toBe('')
  })
})
