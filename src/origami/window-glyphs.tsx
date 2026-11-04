// Thin window-control glyphs drawn on one 10px box, so minimize sits on the same centre line as
// maximize and close (the Material "Minimize" icon draws its bar at the bottom of the box).
const Glyph = ({ d }: { d: string }) => (
  <svg
    width="10"
    height="10"
    viewBox="0 0 10 10"
    fill="none"
    stroke="currentColor"
    strokeWidth="1"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
)

export const MinimizeGlyph = () => <Glyph d="M0.5 5h9" />

export const MaximizeGlyph = () => (
  <Glyph d="M2 0.5h6a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-6a1.5 1.5 0 0 1-1.5-1.5v-6a1.5 1.5 0 0 1 1.5-1.5z" />
)

export const RestoreGlyph = () => (
  <Glyph d="M2.5 2.5v-0.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-0.5M2 2.5h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5v-4a1.5 1.5 0 0 1 1.5-1.5z" />
)

export const CloseGlyph = () => <Glyph d="M1 1l8 8M9 1l-8 8" />
