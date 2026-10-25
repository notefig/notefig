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

// The DP's two rows, reused across calls and grown as needed: the search
// scores every file per keystroke, and allocating rows per file dominated
// its cost.
let previousRow = new Float64Array(256);
let currentRow = new Float64Array(256);

/** Whether `query` is a subsequence of `target` (both lowercased). */
function isSubsequence(query: string, target: string): boolean {
  let i = 0;
  for (let j = 0; j < target.length && i < query.length; j++) {
    if (target[j] === query[i]) i++;
  }
  return i === query.length;
}

/** Row 0 of the DP: the query's first character matched at each position.
 * Returns the row's best. */
function seedRow(queryChar: string, target: string, row: Float64Array) {
  let best = NO_MATCH;
  for (let j = 0; j < target.length; j++) {
    row[j] = target[j] === queryChar ? positionalBonus(target, j) : NO_MATCH;
    best = Math.max(best, row[j]);
  }
  return best;
}

/**
 * One DP step: best bonus sum with this query character matched at each
 * target position, given the previous character's row. A consecutive match
 * (previous matched at j-1) scores 1; a jump scores the landing position's
 * boundary bonus. Returns the row's best.
 */
function advanceRow(
  queryChar: string,
  target: string,
  previous: Float64Array,
  row: Float64Array,
) {
  let best = NO_MATCH;
  let bestJumpFrom = NO_MATCH; // max of previous[0..j-2]
  row[0] = NO_MATCH;
  for (let j = 1; j < target.length; j++) {
    if (j >= 2) bestJumpFrom = Math.max(bestJumpFrom, previous[j - 2]);
    row[j] =
      target[j] === queryChar
        ? Math.max(
            previous[j - 1] + 1,
            bestJumpFrom + positionalBonus(target, j),
          )
        : NO_MATCH;
    best = Math.max(best, row[j]);
  }
  return best;
}

/**
 * The DP over lowercased strings. Each remaining query character adds at
 * most 1, so once even that cannot reach `floor` the target is given up on
 * (scored 0).
 */
function scoreLowercased(q: string, t: string, floor = 0): number {
  if (q.length === 0 || q.length > t.length || !isSubsequence(q, t)) return 0;
  if (previousRow.length < t.length) {
    previousRow = new Float64Array(t.length * 2);
    currentRow = new Float64Array(t.length * 2);
  }
  let previous = previousRow;
  let row = currentRow;
  let best = seedRow(q[0], t, previous);
  for (let i = 1; i < q.length; i++) {
    if ((best + q.length - i) / q.length < floor) return 0;
    best = advanceRow(q[i], t, previous, row);
    [previous, row] = [row, previous];
  }
  return best === NO_MATCH ? 0 : best / q.length;
}

/**
 * Case-insensitive subsequence match, scored in (0, 1]; 0 when the query is
 * not a subsequence of the target.
 */
export function fuzzyScore(query: string, target: string): number {
  return scoreLowercased(query.toLowerCase(), target.toLowerCase());
}

/** What paths are matched against: the relative path, lowercased. */
export function searchKeyOf(relativePath: string): string {
  return relativePath.toLowerCase();
}

/**
 * scoreFilePath over a trimmed, lowercased query and a search key. With a
 * `floor` (the worst score a ranking still keeps), the whole path is only
 * scored when its discounted score could reach it; below it the result is
 * just a bound, which the caller drops anyway.
 */
function scoreSearchKey(q: string, t: string, floor = 0): number {
  if (q.includes("/")) return scoreLowercased(q, t, floor);
  const basename = t.slice(t.lastIndexOf("/") + 1);
  const basenameScore = scoreLowercased(q, basename, floor);
  // A discounted path score never exceeds PATH_MATCH_FACTOR, so a basename
  // score that reaches it wins without scoring the whole path, and so does
  // any basename when the ranking already keeps nothing below that.
  if (basenameScore >= PATH_MATCH_FACTOR || floor > PATH_MATCH_FACTOR)
    return basenameScore;
  const pathFloor = Math.max(floor, basenameScore) / PATH_MATCH_FACTOR;
  return Math.max(
    basenameScore,
    scoreLowercased(q, t, pathFloor) * PATH_MATCH_FACTOR,
  );
}

/**
 * Score a query against a workspace-relative file path. A query containing
 * "/" is matched against the whole path; otherwise the basename is scored
 * with priority and directory-segment matches are discounted.
 */
export function scoreFilePath(query: string, relativePath: string): number {
  const trimmed = query.trim();
  if (!trimmed) return 0;
  return scoreSearchKey(trimmed.toLowerCase(), searchKeyOf(relativePath));
}

export interface ScoredPath {
  score: number;
  relativePath: string;
}

export interface FileSearchResult {
  path: string;
  relativePath: string;
  title: string;
  score: number;
}

export interface FileSearchOptions {
  /** Cap on returned rows — the result lists are not virtualized. */
  limit?: number;
  /** Openability gate (e.g. canOpenFile); paths failing it never surface. */
  filter?: (path: string) => boolean;
  /**
   * Empty-query behavior: [] by default; the mention picker passes true to
   * list files immediately on a bare "@" (shallowest paths first).
   */
  matchAllWhenEmpty?: boolean;
}

export const DEFAULT_FILE_SEARCH_LIMIT = 10;

/**
 * Rank workspace file rows against a query — the pure core shared by
 * useFileSearch (live rows) and the prompt editor's mention suggestion
 * (one-shot collection reads). Rows without a relativePath are loose files
 * (outside the workspace tree) and are hidden to match the file tree.
 */
export function rankFileRows(
  // A row's searchKey (searchKeyOf its relativePath), when the caller keeps
  // one, saves lowercasing every path on every search.
  rows: Iterable<{ path: string; relativePath?: string; searchKey?: string }>,
  query: string,
  {
    limit = DEFAULT_FILE_SEARCH_LIMIT,
    filter,
    matchAllWhenEmpty = false,
  }: FileSearchOptions = {},
): FileSearchResult[] {
  const trimmedQuery = query.trim().toLowerCase();
  if (!trimmedQuery && !matchAllWhenEmpty) return [];
  // Only the best `limit` are kept, in order, as the rows stream past:
  // nearly every file matches a one-letter query, and building and sorting
  // all of them to keep ten dominated the search.
  const top = createTopResults(limit);
  for (const row of rows) {
    if (!row.relativePath) continue;
    const score = scoreRow(
      trimmedQuery,
      row.searchKey ?? searchKeyOf(row.relativePath),
      top.floor(),
    );
    if (score === undefined) continue;
    if (!top.admits({ score, relativePath: row.relativePath })) continue;
    if (filter && !filter(row.path)) continue;
    top.insert({
      path: row.path,
      relativePath: row.relativePath,
      title: row.relativePath.slice(row.relativePath.lastIndexOf("/") + 1),
      score,
    });
  }
  return top.results;
}

/**
 * A row's score, or undefined when it does not match. An empty query
 * (matchAllWhenEmpty) scores every file 0 — the comparator then orders by
 * shortest path, then alphabetically.
 */
function scoreRow(q: string, searchKey: string, floor: number) {
  if (!q) return 0;
  const score = scoreSearchKey(q, searchKey, floor);
  return score > 0 ? score : undefined;
}

/** The best `limit` results so far, in compareScoredPaths order. */
function createTopResults(limit: number) {
  const results: FileSearchResult[] = [];
  const full = () => results.length >= limit;
  return {
    results,
    /** The worst kept score once full: nothing below it can get in. */
    floor: () => (full() ? results[limit - 1].score : 0),
    admits: (candidate: ScoredPath) =>
      !full() || compareScoredPaths(candidate, results[limit - 1]) < 0,
    insert(result: FileSearchResult) {
      let at = results.length;
      while (at > 0 && compareScoredPaths(result, results[at - 1]) < 0) at--;
      results.splice(at, 0, result);
      if (results.length > limit) results.pop();
    },
  };
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
