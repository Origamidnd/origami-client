import type { Components, Theme } from '@mui/material'

import { paperFonts, paperTokens, type PaperMode } from './tokens'

// Paper look for stock MUI components: ink outlines, flat plates, offset shadow on primary actions.
export const paperComponents = (mode: PaperMode): Components<Theme> => {
  const t = paperTokens[mode]
  return {
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          textTransform: 'none',
          fontWeight: 500,
          variants: [
            {
              props: { variant: 'text', color: 'primary' },
              style: { color: t.accentText },
            },
          ],
        },
        contained: {
          backgroundColor: t.action,
          color: t.onAction,
          border: `1.5px solid ${t.line}`,
          boxShadow: `3px 3px 0 ${t.shadow} !important`,
          '&:hover': { backgroundColor: t.accent },
        },
        outlined: {
          borderColor: t.line,
          color: t.ink,
          borderWidth: 1.5,
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          backgroundColor: `${t.plate} !important`,
          border: `1.5px solid ${t.line}`,
          borderRadius: 10,
        },
      },
    },
    MuiDialogTitle: {
      styleOverrides: {
        root: { fontFamily: paperFonts.display, fontSize: 24, fontWeight: 800 },
      },
    },
    MuiMenu: {
      styleOverrides: {
        paper: {
          backgroundColor: t.plate,
          border: `1.5px solid ${t.line}`,
          borderRadius: 8,
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { borderRadius: 6 },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: { backgroundColor: t.ink, color: t.bg, fontSize: 12 },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          '&.Mui-selected': { backgroundColor: t.pale },
          '&.Mui-selected:hover': { backgroundColor: t.pale },
        },
      },
    },
  }
}
