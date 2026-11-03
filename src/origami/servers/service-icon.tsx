import type { CSSProperties } from 'react'

import { GLYPHS, type GlyphKey } from './service-glyphs'
import { GLYPH_HUES, serviceIconKey } from './service-names'

/** Origami tile: a glyph on a soft square in the category colour, with a folded top corner. */
export const GlyphTile = ({
  glyph,
  small = false,
}: {
  glyph: GlyphKey
  small?: boolean
}) => (
  <span
    className={`o-tile${small ? ' o-tile--small' : ''}`}
    style={{ '--o-tile-hue': GLYPH_HUES[glyph] } as CSSProperties}
    aria-hidden="true"
  >
    <svg viewBox="0 0 256 256" fill="currentColor">
      <path d={GLYPHS[glyph]} />
    </svg>
  </span>
)

export const ServiceIcon = ({
  groupName,
  small,
}: {
  groupName: string
  small?: boolean
}) => <GlyphTile glyph={serviceIconKey(groupName)} small={small} />
