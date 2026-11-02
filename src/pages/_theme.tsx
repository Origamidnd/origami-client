import getSystem from '@/utils/get-system'
const OS = getSystem()

// default theme setting
export const defaultTheme = {
  primary_color: '#E0702B',
  secondary_color: '#16203C',
  primary_text: '#16203C',
  secondary_text: '#5B6078',
  info_color: '#3A4C7E',
  error_color: '#BE3A22',
  warning_color: '#C77412',
  success_color: '#2A8A5E',
  background_color: '#F2F2EF',
  font_family: `Onest, -apple-system, BlinkMacSystemFont,"Microsoft YaHei UI", "Microsoft YaHei", Roboto, "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji"${
    OS === 'windows' ? ', twemoji mozilla' : ''
  }`,
}

// dark mode
export const defaultDarkTheme = {
  ...defaultTheme,
  primary_color: '#F08A3E',
  secondary_color: '#9EA4BF',
  primary_text: '#F2F2EF',
  background_color: '#0E1530',
  secondary_text: '#9EA4BF',
  info_color: '#8497CC',
  error_color: '#E2664C',
  warning_color: '#E0A04A',
  success_color: '#3DB37E',
}
