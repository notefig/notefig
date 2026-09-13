/**
 * The claim MET-183 rests on: `CoreFileSystem` is a *subset* of the
 * `FileSystemSurface` the platform adapters already implement, so extracting
 * the core needs no adapter changes at all.
 *
 * That claim is only worth anything if it is checked. These are type-level
 * assignments — they pass or fail at `tsc`, and the runtime `expect` is just
 * there to make the file a test rather than a comment. If someone widens
 * `CoreFileSystem` beyond what a platform can do, this stops compiling here
 * rather than at the far end of the extraction.
 *
 * Deliberately asserts against the *interface*, not a live adapter instance:
 * constructing the Tauri adapter needs a Tauri host, and the property under
 * test is structural.
 */
import { describe, expect, it } from "vitest";
import type { CoreFileSystem, CoreProcess } from "@notefig/core";
import type {
  FileSystemSurface,
  ProcessSurface,
} from "../platform-adapter.interface";

describe("core surfaces are subsets of the platform adapter", () => {
  it("FileSystemSurface satisfies CoreFileSystem", () => {
    // Fails to compile if CoreFileSystem asks for anything the adapters do
    // not already provide, or asks for it with a different signature.
    const widen = (surface: FileSystemSurface): CoreFileSystem => surface;
    expect(widen).toBeTypeOf("function");
  });

  it("ProcessSurface satisfies CoreProcess", () => {
    const widen = (surface: ProcessSurface): CoreProcess => surface;
    expect(widen).toBeTypeOf("function");
  });

  it("does not accept a surface missing a core member", () => {
    // The negative case, so the assertions above cannot pass vacuously.
    const incomplete = {} as Omit<FileSystemSurface, "readFiles">;
    // @ts-expect-error readFiles is required by CoreFileSystem
    const widen = (): CoreFileSystem => incomplete;
    expect(widen).toBeTypeOf("function");
  });
});
