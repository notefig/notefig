/**
 * A session's mark (MET-284): one of the theme's session colors
 * (`--session-1` … `--session-12`) and one of the shapes the widgets draw
 * (`session-mark.tsx` in @notefig/widgets). A session reads the same on
 * every widget that joins it, in the sessions panel, and (its color) on the
 * edits it made; the app picks both once and keeps them on the task row
 * (`colorSlot`, `shapeSlot`).
 */
export const SESSION_COLOR_SLOTS = 12;
export const SESSION_SHAPES = 24;
