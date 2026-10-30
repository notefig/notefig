/**
 * The document minimap's contract with the elements it maps (MET-172).
 *
 * The minimap is a generic mechanism: it walks the document for nodes
 * whose widget declared a `MinimapSource`, draws one dot per match on a
 * rail beside the editor, and never learns who those elements are. The
 * element owns what its dot SAYS — title and live state — the minimap
 * owns how a dot LOOKS (the goo, the wave, the two-axis vocabulary).
 *
 * The dot-state vocabulary is the settled two-axis map:
 * CORE = where the element's round is in its lifecycle (hollow: empty
 * vessel; solid: being filled; deepened tint: holds a result — rendered
 * as a tonal shift of the whole bump, never an inner core).
 * MOTION = what's needed (still: nothing; body breathe: system busy;
 * emitted wave: a human must act — silenced by acting or by seeing).
 * Hover/press motion is reserved for interaction feedback, never state.
 */
import type { Node as PMNode } from "@tiptap/pm/model";

export type MinimapDotCore =
  | "neutral" // settled and working states
  | "attention" // blocked on the user
  | "error"
  | "fresh"; // holds a result the user hasn't seen

export type MinimapDotState = {
  core: MinimapDotCore;
  /** Phase description, shown as the tooltip's first line and folded
   *  into the accessible name — it names what the dot's visuals mean, so
   *  the vocabulary is learnable by hovering. */
  label: string | null;
  /** Background-colored punch in the bump's center — an empty vessel. */
  hollow: boolean;
  /** Goo bump breathes (radius oscillation through the filter). */
  breathe: boolean;
  /** The hollow punch slowly pulses (waiting states). */
  pulse: boolean;
  /** Attention pulse: a bright core and a wave bursting past the bump. */
  ping: boolean;
};

/** A dot with nothing to say — the default for sources with no observer. */
export const MINIMAP_STILL_DOT: MinimapDotState = {
  core: "neutral",
  label: null,
  hollow: false,
  breathe: false,
  pulse: false,
  ping: false,
};

export type MinimapEntryInfo = {
  /** Stable identity across position changes (e.g. the widget's blobId).
   *  Optional — without it the entry is keyed by position. */
  id?: string;
  /** Short human handle shown in the hover tooltip. */
  title: string;
};

export interface MinimapObserver {
  /** Current dot state; called after every `onChange` and on mount. */
  get(): MinimapDotState;
  destroy(): void;
}

export interface MinimapObserveHandle {
  /** The mapped node, re-read on each call (positions move under edits). */
  getNode(): PMNode | null;
  /** The node's rendered DOM, for visibility tracking. */
  getElement(): HTMLElement | null;
}

/** What an element type declares to appear on the minimap. */
export interface MinimapSource {
  /** Static derivation from the node; null skips this instance. */
  entry(node: PMNode): MinimapEntryInfo | null;
  /** Live dot state; omit for a plain still dot. */
  observe?(handle: MinimapObserveHandle, onChange: () => void): MinimapObserver;
}

/** One mapped element, as derived from the live document. */
export type MinimapEntry = {
  /** Unique per entry (id can recur when markers are duplicated by
   *  external edits, so the position disambiguates). */
  key: string;
  /** Identity for observers — stable while the id is; position otherwise. */
  observerKey: string;
  nodeTypeName: string;
  pos: number;
  /** 0..1 position of the element within the document. */
  ratio: number;
  title: string;
};

const TITLE_MAX_CHARS = 48;
const RATIO_LO = 0.01;
const RATIO_HI = 0.99;
/** Minimum rail distance between adjacent dots (≈12px on the 7rem rail) —
 *  enough that bumps read as separate beads and hit targets don't stack. */
const MIN_GAP = 0.07;

/**
 * Nudge crowded dots apart while preserving document order. Two passes:
 * forward pushes each dot below its predecessor's minimum, backward pulls
 * everything up from the clamped end. The gap shrinks when the rail is
 * genuinely full, so the result is always feasible — approximate
 * proportionality traded for guaranteed distinctness (clustering is the
 * deliberate non-solution until the rail actually needs it).
 */
function spreadRatios(ratios: number[]): number[] {
  if (ratios.length < 2) return ratios;
  const gap = Math.min(MIN_GAP, (RATIO_HI - RATIO_LO) / (ratios.length - 1));
  const out = [...ratios];
  for (let i = 1; i < out.length; i++)
    out[i] = Math.max(out[i], out[i - 1] + gap);
  out[out.length - 1] = Math.min(out[out.length - 1], RATIO_HI);
  for (let i = out.length - 2; i >= 0; i--)
    out[i] = Math.min(out[i], out[i + 1] - gap);
  return out;
}

/** Pure derivation, exported for tests. */
/** A dot's title as the rail shows it: clamped, with an ellipsis. */
export function dotTitle(title: string): string {
  return title.length > TITLE_MAX_CHARS
    ? `${title.slice(0, TITLE_MAX_CHARS)}…`
    : title;
}

export function deriveMinimapEntries(
  doc: PMNode,
  sources: Record<string, MinimapSource>,
): MinimapEntry[] {
  const found: Found[] = [];
  doc.descendants((node, pos) => {
    const source = sources[node.type.name];
    if (!source) return true;
    const info = source.entry(node);
    if (!info) return false;
    found.push({
      observerKey: `${node.type.name}:${info.id ?? `pos:${pos}`}`,
      nodeTypeName: node.type.name,
      pos,
      title: dotTitle(info.title),
    });
    return false;
  });
  return place(found, doc);
}

/** An entry before it is placed on the rail. */
type Found = Pick<MinimapEntry, "observerKey" | "nodeTypeName" | "pos" | "title">;

function place(found: Found[], doc: PMNode): MinimapEntry[] {
  const size = Math.max(doc.content.size, 1);
  // Clamped in from the edges so the first/last dot never sits on the
  // rail's boundary; crowding is resolved by spreadRatios.
  const spread = spreadRatios(
    found.map(({ pos }) => Math.min(Math.max(pos / size, RATIO_LO), RATIO_HI)),
  );
  return found.map((entry, i) => ({
    ...entry,
    key: `${entry.observerKey}:${entry.pos}`,
    ratio: spread[i],
  }));
}

/**
 * `previous`, derived from `prevDoc`, moved to where the edit to `doc` put
 * its elements — walking only what the edit changed, where deriving again
 * walks the whole document (~0.8 ms a keystroke in an 8,000-line one).
 * Null when the change takes in a mapped element, or lies inside one (its
 * title may read it): derive again.
 */
export function shiftMinimapEntries(
  prevDoc: PMNode,
  doc: PMNode,
  previous: readonly MinimapEntry[],
  sources: Record<string, MinimapSource>,
): MinimapEntry[] | null {
  const start = prevDoc.content.findDiffStart(doc.content);
  if (start === null) return place([...previous], doc);
  let { a: endA, b: endB } = prevDoc.content.findDiffEnd(doc.content)!;
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  const mapped = (node: PMNode, to: number) => {
    let hit = false;
    node.nodesBetween(start, to, (child) => {
      if (sources[child.type.name]) hit = true;
      return !hit;
    });
    return hit;
  };
  if (mapped(prevDoc, endA) || mapped(doc, endB)) return null;
  const shift = endB - endA;
  // An element without an id is known by its position, which moves.
  const moves = previous.filter((entry) => entry.pos >= start);
  if (moves.some((e) => e.observerKey === `${e.nodeTypeName}:pos:${e.pos}`)) return null;
  return place(
    previous.map((entry) =>
      entry.pos < start ? entry : { ...entry, pos: entry.pos + shift },
    ),
    doc,
  );
}
