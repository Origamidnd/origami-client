import type { TranslationKey } from '@/types/generated/i18n-keys'

const detailOf = (error: unknown): string => {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const candidate = error as { detail?: unknown; message?: unknown }
    if (typeof candidate.detail === 'string') return candidate.detail
    if (typeof candidate.message === 'string') return candidate.message
  }
  return String(error ?? '')
}

/** Plain-language reason for a failed subscription download, or null when it is not recognised. */
export const explainSubscriptionError = (
  error: unknown,
): TranslationKey | null => {
  const text = detailOf(error).toLowerCase()
  // Set by the client when the panel marks the answer as over the device limit (prfitem.rs).
  if (text.includes('subscription device limit reached'))
    return 'origami.errors.deviceLimit'
  if (text.includes('subscription refused this device'))
    return 'origami.errors.deviceRefused'

  const status = /status (\d{3})/.exec(text)?.[1]

  if (status === '404') return 'origami.errors.notFound'
  if (status === '401' || status === '403') return 'origami.errors.forbidden'
  if (status === '429') return 'origami.errors.tooMany'
  if (status?.startsWith('5')) return 'origami.errors.server'
  if (text.includes('tls 1.0/1.1')) return null
  if (
    text.includes('invalid yaml') ||
    text.includes('does not contain `proxies`')
  ) {
    return 'origami.errors.badFormat'
  }
  if (
    /timed out|timeout|dns|error sending request|connection|connect|network|unreachable/.test(
      text,
    )
  ) {
    return 'origami.errors.network'
  }
  return null
}
