import {
  AccountBalanceRounded,
  AutoAwesomeRounded,
  CategoryRounded,
  HeadsetMicRounded,
  LanguageRounded,
  LiveTvRounded,
  LockOpenRounded,
  MusicNoteRounded,
  SearchRounded,
  SendRounded,
  SmartDisplayRounded,
  SportsEsportsRounded,
} from '@mui/icons-material'
import type { ReactElement } from 'react'

import { serviceIconKey, type ServiceIconKey } from './service-names'

const props = { className: 'o-srv__icon', 'aria-hidden': true } as const

const ICONS: Record<ServiceIconKey, ReactElement> = {
  other: <LanguageRounded {...props} />,
  blocked: <LockOpenRounded {...props} />,
  youtube: <SmartDisplayRounded {...props} />,
  discord: <HeadsetMicRounded {...props} />,
  telegram: <SendRounded {...props} />,
  games: <SportsEsportsRounded {...props} />,
  music: <MusicNoteRounded {...props} />,
  twitch: <LiveTvRounded {...props} />,
  ai: <AutoAwesomeRounded {...props} />,
  google: <SearchRounded {...props} />,
  russia: <AccountBalanceRounded {...props} />,
  unknown: <CategoryRounded {...props} />,
}

export const ServiceIcon = ({ groupName }: { groupName: string }) =>
  ICONS[serviceIconKey(groupName)]
