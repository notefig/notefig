import { describe, expect, it } from "vitest";
import {
  compareScoredPaths,
  fuzzyScore,
  rankFileRows,
  scoreFilePath,
} from "@/utils/file-score";

describe("fuzzyScore", () => {
  it("gives an exact match a perfect score", () => {
    expect(fuzzyScore("notes.md", "notes.md")).toBe(1);
  });

  it("matches subsequences (fuzzy typos)", () => {
    expect(fuzzyScore("noes", "notes.md")).toBeGreaterThan(0);
    expect(fuzzyScore("nts", "notes.md")).toBeGreaterThan(0);
  });

  it("returns 0 when the query is not a subsequence", () => {
    expect(fuzzyScore("xyz", "notes.md")).toBe(0);
    expect(fuzzyScore("noteszz", "notes.md")).toBe(0);
  });

  it("returns 0 for an empty query or target", () => {
    expect(fuzzyScore("", "notes.md")).toBe(0);
    expect(fuzzyScore("notes", "")).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("README", "readme.md")).toBe(1);
  });

  it("scores a start-of-string match above a mid-word match", () => {
    expect(fuzzyScore("note", "notebook.md")).toBeGreaterThan(
      fuzzyScore("note", "footnote.md"),
    );
  });

  it("scores a word-boundary match above a mid-word match", () => {
    expect(fuzzyScore("notes", "old-notes.md")).toBeGreaterThan(
      fuzzyScore("notes", "footnotes.md"),
    );
  });
});

describe("scoreFilePath", () => {
  it("ranks an exact basename above a directory-segment match", () => {
    expect(scoreFilePath("readme", "readme.md")).toBeGreaterThan(
      scoreFilePath("readme", "readme/index.md"),
    );
  });

  it("boosts basename matches over deep-path matches", () => {
    expect(scoreFilePath("notes", "notes.md")).toBeGreaterThan(
      scoreFilePath("notes", "archive/old-notes.md"),
    );
  });

  it("matches across segments when the query contains a separator", () => {
    expect(scoreFilePath("docs/read", "docs/readme.md")).toBeGreaterThan(0);
    expect(scoreFilePath("docs/read", "readme.md")).toBe(0);
  });

  it("still surfaces directory-only matches, discounted", () => {
    const score = scoreFilePath("archive", "archive/notes.md");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(scoreFilePath("archive", "archive.md"));
  });

  it("returns 0 for whitespace-only queries and non-matches", () => {
    expect(scoreFilePath("   ", "notes.md")).toBe(0);
    expect(scoreFilePath("zzz", "notes.md")).toBe(0);
  });
});

describe("compareScoredPaths", () => {
  it("sorts by score descending first", () => {
    const rows = [
      { score: 0.4, relativePath: "a.md" },
      { score: 0.9, relativePath: "b.md" },
    ];
    expect([...rows].sort(compareScoredPaths)[0].relativePath).toBe("b.md");
  });

  it("breaks score ties by shorter path, then alphabetically", () => {
    const rows = [
      { score: 0.5, relativePath: "deeply/nested/a.md" },
      { score: 0.5, relativePath: "b.md" },
      { score: 0.5, relativePath: "a.md" },
    ];
    expect(
      [...rows].sort(compareScoredPaths).map((r) => r.relativePath),
    ).toEqual(["a.md", "b.md", "deeply/nested/a.md"]);
  });
});

describe("rankFileRows edge cases", () => {
  const rows = [
    { path: "/ws/notes.md", relativePath: "notes.md" },
    { path: "/ws/src/readme.md", relativePath: "src/readme.md" },
  ];

  it("returns an empty list when the cap is zero", () => {
    expect(rankFileRows(rows, "md", { limit: 0 })).toEqual([]);
  });

  it("returns an empty list for a negative cap", () => {
    expect(rankFileRows(rows, "md", { limit: -1 })).toEqual([]);
  });
});

describe("rankFileRows keeps exactly the best results", () => {
  // Deep, overlapping paths: the shape where skipping rows that cannot make
  // the cut, and paths that cannot beat their basename, matters most.
  const words = ["notes", "src", "components", "readme", "2026", "q3", "draft"];
  const rows = Array.from({ length: 400 }, (_, i) => {
    const segments = Array.from(
      { length: 1 + (i % 6) },
      (_, k) => words[(i * 7 + k * 3) % words.length],
    );
    const relativePath = `${segments.join("/")}/${words[i % words.length]}-${i}.md`;
    return { path: `/ws/${relativePath}`, relativePath };
  });

  it.each(["r", "rea", "readme", "nts", "src/comp", "q3/dr", "co-1"])(
    "matches scoring and sorting every file for %j",
    (query) => {
      const expected = rows
        .map((row) => ({
          ...row,
          score: scoreFilePath(query, row.relativePath),
        }))
        .filter((row) => row.score > 0)
        .sort(compareScoredPaths)
        .slice(0, 10)
        .map((row) => [row.relativePath, row.score]);
      expect(
        rankFileRows(rows, query).map((r) => [r.relativePath, r.score]),
      ).toEqual(expected);
    },
  );
});
