import { useTranslation } from 'react-i18next'

import { pingLevel } from './servers/model'

/**
 * The one look for a ping anywhere in the client: a small tinted badge, green / amber / red by the
 * same thresholds everywhere. `tone="plain"` keeps the shape without the colour, for values that are
 * not a server's ping (a site opened through the VPN is slower by nature).
 */
export const PingBadge = ({
  delay,
  checking = false,
  tone = 'level',
  noAddress = false,
}: {
  /** Milliseconds; null means no answer, undefined means not measured yet. */
  delay: number | null | undefined
  checking?: boolean
  tone?: 'level' | 'plain'
  /** The server did not answer because its address does not resolve. */
  noAddress?: boolean
}) => {
  const { t } = useTranslation()
  if (checking) return <span className="o-ping is-wait">…</span>
  const level = pingLevel(delay)
  if (level === 'unknown') return null
  if (level === 'dead' && noAddress) {
    return (
      <span
        className="o-ping is-dead"
        title={t('origami.servers.noAddressHint')}
      >
        {t('origami.servers.noAddress')}
      </span>
    )
  }
  return (
    <span
      className={`o-ping is-${tone === 'plain' && level !== 'dead' ? 'plain' : level}`}
    >
      {level === 'dead'
        ? t('origami.servers.noAnswer')
        : t('origami.home.server.ping', { ms: delay })}
    </span>
  )
}
