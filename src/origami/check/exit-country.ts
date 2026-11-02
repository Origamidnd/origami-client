const REGION_CODE = /^[A-Z]{2}$/

/**
 * Exit country in the UI language. The IP services disagree: some answer with a name
 * ("Finland"), some with a code ("FI"), some with nothing, so the code wins when there is one.
 * Empty string when no service said where the exit is.
 */
export const exitCountryName = (
  info: { country?: string; country_code?: string },
  language: string,
): string => {
  const country = info.country?.trim() ?? ''
  const code = (info.country_code?.trim() || country).toUpperCase()
  if (REGION_CODE.test(code)) {
    try {
      const name = new Intl.DisplayNames([language], { type: 'region' }).of(
        code,
      )
      if (name && name !== code) return name
    } catch {
      // Unknown language tag: fall back to what the service said.
    }
  }
  return country
}
