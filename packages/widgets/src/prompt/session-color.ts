/**
 * A session's color as CSS (MET-284): the theme's `--session-N` hue for its
 * slot, the one color for everything the session does — its widgets' rail
 * and chip, and the change marks its edits leave in the document. A widget
 * with no known slot (its session is gone, or its row hasn't loaded) gets a
 * neutral muted color, never a guessed one.
 */
export function sessionColor(slot: number | undefined | null, alpha = 1): string {
  const token = slot == null ? "--muted-foreground" : `--session-${slot + 1}`;
  return alpha === 1 ? `hsl(var(${token}))` : `hsl(var(${token}) / ${alpha})`;
}
