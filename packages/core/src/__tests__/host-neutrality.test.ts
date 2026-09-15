/**
 * The guard that actually enforces this package's reason to exist.
 *
 * The compiler cannot do it. `lib: ["ES2020"]` removes the DOM globals, and
 * `types: []` stops the automatic @types/* sweep, but `@types/node` still
 * lands in the program via a `/// <reference types="node" />` inside
 * `@types/ws`, which arrives with `@notefig/agent`'s source — and a
 * reference directive from a file already in the program is not something
 * `types` can turn off. Measured: with both settings in place, `process.env`
 * and `import * as fs from "fs"` compile clean in here.
 *
 * So the boundary is enforced by reading the source instead. This is a
 * blunter instrument than a type error, but it is the one that works, and it
 * fails with the name of the offending file rather than a green build and a
 * host assumption that ships.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("..", import.meta.url).pathname;

/** Module specifiers a host-neutral package must never reach for. Anything
 *  platform-shaped arrives through the ServiceHost contract instead. */
const BANNED_IMPORTS = [
  "fs",
  "node:fs",
  "path",
  "node:path",
  "os",
  "node:os",
  "child_process",
  "node:child_process",
  "crypto",
  "node:crypto",
  "react",
  "react-dom",
  "@tiptap/core",
  "prosemirror-model",
  "@tauri-apps/api",
];

/** Globals that only exist on one kind of host. */
const BANNED_GLOBALS = [
  "process",
  "window",
  "document",
  "localStorage",
  "navigator",
  "__dirname",
  "require",
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // The tests themselves run on Node and are not shipped.
      if (entry === "__tests__") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Strip comments and string literals so prose about `process` or a message
 *  containing the word "require" cannot fail the scan. */
function stripNonCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

describe("host neutrality", () => {
  const files = sourceFiles(SRC);

  it("scans a non-empty source tree", () => {
    // Guards the guard: a bad SRC path would make every case below vacuous.
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)("%s imports no platform module", (file) => {
    const source = readFileSync(file, "utf8");
    // Import specifiers survive stripNonCode's string removal, so match them
    // on the raw source before it runs.
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (m) => m[1],
    );
    const dynamic = [...source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map(
      (m) => m[1],
    );
    const offending = [...specifiers, ...dynamic].filter((s) =>
      BANNED_IMPORTS.includes(s),
    );
    expect(offending).toEqual([]);
  });

  it.each(files)("%s touches no platform global", (file) => {
    const code = stripNonCode(readFileSync(file, "utf8"));
    const offending = BANNED_GLOBALS.filter((name) =>
      new RegExp(`(?<![\\w.$])${name}\\b`).test(code),
    );
    expect(offending).toEqual([]);
  });
});
