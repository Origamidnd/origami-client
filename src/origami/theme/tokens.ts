export type PaperMode = 'light' | 'dark'

export interface PaperTokens {
  bg: string
  plate: string
  ink: string
  muted: string
  line: string
  crease: string
  accent: string
  action: string
  onAction: string
  pale: string
  ok: string
  okBg: string
  okText: string
  warn: string
  warnBg: string
  warnText: string
  danger: string
  dangerBg: string
  dangerText: string
  chip: string
  shadow: string
}

// Same palette as the subscription page (sub.origamivpn.pro).
export const paperTokens: Record<PaperMode, PaperTokens> = {
  light: {
    bg: '#F2F2EF',
    plate: '#FFFFFF',
    ink: '#16203C',
    muted: '#5B6078',
    line: '#16203C',
    crease: '#A9ABB3',
    accent: '#E0702B',
    action: '#EE7C34',
    onAction: '#16203C',
    pale: '#FBE3CC',
    ok: '#2A8A5E',
    okBg: '#E3F3EA',
    okText: '#1F6B48',
    warn: '#C77412',
    warnBg: '#FBEBD3',
    warnText: '#94560B',
    danger: '#BE3A22',
    dangerBg: '#F8E1DC',
    dangerText: '#A1301B',
    chip: '#ECECE8',
    shadow: '#16203C',
  },
  dark: {
    bg: '#0E1530',
    plate: '#16203C',
    ink: '#F2F2EF',
    muted: '#9EA4BF',
    line: '#5C668F',
    crease: '#4A5379',
    accent: '#F08A3E',
    action: '#EE7C34',
    onAction: '#16203C',
    pale: '#3A2A22',
    ok: '#3DB37E',
    okBg: '#173B33',
    okText: '#8FE0B8',
    warn: '#E0A04A',
    warnBg: '#3B3020',
    warnText: '#F2C27E',
    danger: '#E2664C',
    dangerBg: '#3E2230',
    dangerText: '#F4A08E',
    chip: '#222C4D',
    shadow: '#05081A',
  },
}

export const paperFonts = {
  display: "'Sofia Sans Extra Condensed', 'Arial Narrow', sans-serif",
  body: "Onest, system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace",
}

export const applyPaperCssVars = (mode: PaperMode) => {
  const tokens = paperTokens[mode]
  const root = document.documentElement
  for (const [key, value] of Object.entries(tokens)) {
    root.style.setProperty(
      `--o-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
      value,
    )
  }
  root.dataset.origamiMode = mode
}
