import { AccessTimeRounded } from '@mui/icons-material'
import { useTranslation } from 'react-i18next'

import { useClockSkew } from '../clock-skew'

/** Stays while the computer's clock is off: it goes away once the subscription sees it right. */
export const ClockPlate = () => {
  const { t } = useTranslation()
  const skew = useClockSkew()
  if (!skew) return null

  return (
    <section className="o-announce" role="alert">
      <AccessTimeRounded className="o-announce__icon" />
      <div className="o-announce__text">
        {skew === 'ahead'
          ? t('origami.notices.clockAhead')
          : t('origami.notices.clockBehind')}
      </div>
    </section>
  )
}
