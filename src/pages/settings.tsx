import { useTranslation } from 'react-i18next'

import { BasePage } from '@/components/base'
import { useExpertMode } from '@/origami/expert-mode'
import { ExpertSettings } from '@/origami/settings/expert-settings'
import { OrigamiSettings } from '@/origami/settings/origami-settings'
import { showNotice } from '@/services/notice-service'

const SettingPage = () => {
  const { t } = useTranslation()
  const expert = useExpertMode()

  const onError = (err: any) => {
    showNotice.error(err)
  }

  // OrigamiVPN: our settings first; in expert mode the stock ones follow in folding sections.
  return (
    <BasePage title={t('settings.page.title')}>
      <OrigamiSettings>
        {expert && <ExpertSettings onError={onError} />}
      </OrigamiSettings>
    </BasePage>
  )
}

export default SettingPage
