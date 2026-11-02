import { GitHub, HelpOutlineRounded, Telegram } from '@mui/icons-material'
import { Box, ButtonGroup, IconButton, Grid } from '@mui/material'
import { useLockFn } from 'ahooks'
import { useTranslation } from 'react-i18next'

import { BasePage } from '@/components/base'
import SettingClash from '@/components/setting/setting-clash'
import SettingSystem from '@/components/setting/setting-system'
import SettingVergeAdvanced from '@/components/setting/setting-verge-advanced'
import SettingVergeBasic from '@/components/setting/setting-verge-basic'
import { showNotice } from '@/services/notice-service'
import { openExternalUrl } from '@/utils/open-external-url'

const SettingPage = () => {
  const { t } = useTranslation()

  const onError = (err: any) => {
    showNotice.error(err)
  }

  const toGithubRepo = useLockFn(() =>
    openExternalUrl('https://github.com/Origamidnd/origami-client').catch(
      onError,
    ),
  )

  const toGithubDoc = useLockFn(() =>
    openExternalUrl('https://origamivpn.pro').catch(onError),
  )

  const toTelegramChannel = useLockFn(() =>
    openExternalUrl('https://t.me/origamivpn').catch(onError),
  )

  return (
    <BasePage
      title={t('settings.page.title')}
      header={
        <ButtonGroup
          variant="contained"
          aria-label={t('settings.page.actionsGroupLabel')}
        >
          <IconButton
            size="medium"
            color="inherit"
            title={t('settings.page.actions.manual')}
            onClick={toGithubDoc}
          >
            <HelpOutlineRounded fontSize="inherit" />
          </IconButton>
          <IconButton
            size="medium"
            color="inherit"
            title={t('settings.page.actions.telegram')}
            onClick={toTelegramChannel}
          >
            <Telegram fontSize="inherit" />
          </IconButton>

          <IconButton
            size="medium"
            color="inherit"
            title={t('settings.page.actions.github')}
            onClick={toGithubRepo}
          >
            <GitHub fontSize="inherit" />
          </IconButton>
        </ButtonGroup>
      }
    >
      <Grid container spacing={1.5} columns={{ xs: 6, sm: 6, md: 12 }}>
        <Grid size={6}>
          <Box
            sx={{
              borderRadius: 2,
              marginBottom: 1.5,
              backgroundColor: 'var(--o-plate)',
              border: '1.5px solid var(--o-line)',
            }}
          >
            <SettingSystem onError={onError} />
          </Box>
          <Box
            sx={{
              borderRadius: 2,
              backgroundColor: 'var(--o-plate)',
              border: '1.5px solid var(--o-line)',
            }}
          >
            <SettingClash onError={onError} />
          </Box>
        </Grid>
        <Grid size={6}>
          <Box
            sx={{
              borderRadius: 2,
              marginBottom: 1.5,
              backgroundColor: 'var(--o-plate)',
              border: '1.5px solid var(--o-line)',
            }}
          >
            <SettingVergeBasic onError={onError} />
          </Box>
          <Box
            sx={{
              borderRadius: 2,
              backgroundColor: 'var(--o-plate)',
              border: '1.5px solid var(--o-line)',
            }}
          >
            <SettingVergeAdvanced onError={onError} />
          </Box>
        </Grid>
      </Grid>
    </BasePage>
  )
}

export default SettingPage
