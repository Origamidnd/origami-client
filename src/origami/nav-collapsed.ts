import { useMediaQuery } from '@mui/material'

import { useVerge } from '@/hooks/use-verge'

// Under this width the full sidebar leaves the page about 300px, so it folds to icons by itself.
const NARROW_WINDOW = '(max-width: 720px)'

/** The sidebar folds when the user asked for it or the window is too narrow for labels. */
export const useNavCollapsed = () => {
  const { verge } = useVerge()
  const narrow = useMediaQuery(NARROW_WINDOW)
  return (verge?.collapse_navbar ?? false) || narrow
}
