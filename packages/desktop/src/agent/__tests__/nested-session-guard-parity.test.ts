/**
 * The nested-session guard list exists twice: in @notefig/shared for every
 * Node spawner, and in agent_proc.rs for the desktop's Rust spawner, which
 * cannot import it. A var added to one and not the other reappears as
 * "cannot be launched inside another Claude Code session" on one host only.
 * The desktop owns the Rust file, so the parity check lives here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { NESTED_SESSION_GUARD_VARS } from "@notefig/shared/agent";

describe("nested-session guard vars", () => {
  it("match NESTED_SESSION_GUARD_VARS in agent_proc.rs", () => {
    const rust = readFileSync(
      resolve(__dirname, "../../../src-tauri/src/agent_proc.rs"),
      "utf8",
    );
    const start = rust.indexOf("const NESTED_SESSION_GUARD_VARS");
    expect(start).toBeGreaterThan(-1);
    const block = rust.slice(start, rust.indexOf("];", start));
    const rustVars = [...block.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
    expect(rustVars).toEqual([...NESTED_SESSION_GUARD_VARS]);
  });
});
