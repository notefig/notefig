// Path-aware fuzzy scoring for file search (MET-155). Pure — no React, no
// collections — so ranking is unit-testable and shared by every consumer of
// useFileSearch (command palette today, editor link completion later).

const BONUS_START = 1;
const BONUS_MID_WORD = 0.3;

// Bonus for a match landing right after a boundary character. Consecutive
// matches always score 1, so an exact prefix/basename match normalizes to a
// perfect 1.0 and anything gappy lands below it.
const BOUNDARY_BONUS: Record<string, number> = {
  "/": 0.9,
  "\\": 0.9,
  " ": 0.9,
  "-": 0.8,
  _: 0.8,
  ".": 0.8,
};

// A directory-segment-only match must rank below the same query matching a
// basename, so full-path scores are discounted when the query has no "/".
const PATH_MATCH_FACTOR = 0.75;

// -Infinity marks "no alignment"; it survives addition, so the DP needs no
// reachability branches.
const NO_MATCH = Number.NEGATIVE_INFINITY;

function positionalBonus(target: string, index: number): number {
  if (index === 0) return BONUS_START;
  return BOUNDARY_BONUS[target[index - 1]] ?? BONUS_MID_WORD;
}

/** Row 0 of the DP: the query's first character matched at each position. */
function seedRow(queryChar: string, target: string): Float64Array {
  const row = new Float64Array(target.length).fill(NO_MATCH);
  for (let j = 0; j < target.length; j++) {
    if (target[j] === queryChar) row[j] = positionalBonus(target, j);
  }
  return row;
}

/**
 * One DP step: best bonus sum with this query character matched at each
 * target position, given the previous character's row. A consecutive match
 * (previous matched at j-1) scores 1; a jump scores the landing position's
 * boundary bonus.
 */
function advanceRow(
  queryChar: string,
  target: string,
  previous: Float64Array,
): Float64Array {
  const row = new Float64Array(target.length).fill(NO_MATCH);
  let bestJumpFrom = NO_MATCH; // max of previous[0..j-2]
  for (let j = 1; j < target.length; j++) {
    if (j >= 2) bestJumpFrom = Math.max(bestJumpFrom, previous[j - 2]);
    if (target[j] !== queryChar) continue;
    row[j] = Math.max(
      previous[j - 1] + 1,
      bestJumpFrom + positionalBonus(target, j),
    );
  }
  return row;
}

/**
 * Case-insensitive subsequence match, scored in (0, 1]; 0 when the query is
 * not a subsequence of the target.
 */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0 || q.length > t.length) return 0;

  let row = seedRow(q[0], t);
  for (let i = 1; i < q.length; i++) row = advanceRow(q[i], t, row);

  const best = Math.max(...row);
  return best === NO_MATCH ? 0 : best / q.length;
}

/**
 * Score a query against a workspace-relative file path. A query containing
 * "/" is matched against the whole path; otherwise the basename is scored
 * with priority and directory-segment matches are discounted.
 */
export function scoreFilePath(query: string, relativePath: string): number {
  const trimmed = query.trim();
  if (!trimmed) return 0;
  const pathScore = fuzzyScore(trimmed, relativePath);
  if (trimmed.includes("/")) return pathScore;
  const basename = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  return Math.max(fuzzyScore(trimmed, basename), pathScore * PATH_MATCH_FACTOR);
}

export interface ScoredPath {
  score: number;
  relativePath: string;
}

/** Score desc, then shorter path, then lexicographic — a total order so
 * result lists are stable across re-renders. */
export function compareScoredPaths(a: ScoredPath, b: ScoredPath): number {
  return (
    b.score - a.score ||
    a.relativePath.length - b.relativePath.length ||
    (a.relativePath > b.relativePath
      ? 1
      : a.relativePath < b.relativePath
        ? -1
        : 0)
  );
}
