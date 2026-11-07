import { describe, expect, it, vi } from "vitest";
import type { DocumentWriteResult } from "@/modules/documents";
import type { SyncResult } from "../sync-types";
import { ApplyFailsafe, reconcileLocalEdits, type ApplyDeps } from "./sync-apply";

const ok = <T,>(value: T): SyncResult<T> => ({ ok: true, value });

/** Fakes for one open document whose editor moves on as scripted. */
function deps(script: {
  texts: string[];
  writes: DocumentWriteResult[];
  merged?: string;
}) {
  const versions = script.texts.map((text) => ({ text }));
  let read = 0;
  const writes = [...script.writes];
  const d: ApplyDeps = {
    api: {
      reconcile: vi.fn(async ({ ours }) =>
        ok({
          status: "merged" as const,
          write: { path: "note.md", kind: "text" as const, text: script.merged ?? `${(ours as { text: string }).text}+remote` },
          overwritten: null,
          recoveryRef: null,
        }),
      ),
      mergeTexts: vi.fn(async ({ ours, theirs }) =>
        ok({ status: "merged" as const, content: `${ours}|${theirs}`, overwritten: [] }),
      ),
    },
    documents: {
      editorText: vi.fn(async () => {
        const at = Math.min(read++, versions.length - 1);
        return { text: versions[at].text, version: versions[at] };
      }),
      write: vi.fn(async () => writes.shift() ?? "written"),
    },
    fs: {
      readFiles: vi.fn(),
      readBinaryFiles: vi.fn(),
      writeBinaryFiles: vi.fn(),
      deleteFiles: vi.fn(),
    },
    unwrap: <T,>(result: SyncResult<T>) => {
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    },
    overwritten: vi.fn(),
  };
  return { d, versions };
}

describe("merging local edits into an open editor", () => {
  it("writes the merge only while the editor holds the version that was merged", async () => {
    const { d, versions } = deps({ texts: ["local"], writes: ["written"] });
    const done = await reconcileLocalEdits(d, "/ws/note.md", "note.md", "prev");
    expect(done).toEqual({ content: "local+remote" });
    expect(d.api.reconcile).toHaveBeenCalledWith({ path: "note.md", previous: "prev", ours: { text: "local" } });
    expect(d.documents.write).toHaveBeenCalledWith("/ws/note.md", "local+remote", {
      source: "sync",
      expect: versions[0],
    });
  });

  it("merges again from the snapshot when the user typed meanwhile", async () => {
    const { d, versions } = deps({ texts: ["local", "local typed"], writes: ["stale", "written"] });
    const done = await reconcileLocalEdits(d, "/ws/note.md", "note.md", "prev");
    // base: the snapshot merged first; ours: the newer text; theirs: that merge.
    expect(d.api.mergeTexts).toHaveBeenCalledWith({
      path: "note.md",
      base: "local",
      ours: "local typed",
      theirs: "local+remote",
    });
    expect(done).toEqual({ content: "local typed|local+remote" });
    expect(d.documents.write).toHaveBeenLastCalledWith("/ws/note.md", "local typed|local+remote", {
      source: "sync",
      expect: versions[1],
    });
  });

  it("leaves the file pending while unsaved edits hold the write back", async () => {
    const { d } = deps({ texts: ["local"], writes: ["held"] });
    expect(await reconcileLocalEdits(d, "/ws/note.md", "note.md", "prev")).toBe("pending");
  });

  it("raises the failsafe when the worker can't merge", async () => {
    const { d } = deps({ texts: ["local"], writes: [] });
    d.api.reconcile = vi.fn(async () =>
      ok({ status: "failed" as const, reason: "validation" as const, detail: "unstable" }),
    );
    await expect(reconcileLocalEdits(d, "/ws/note.md", "note.md", "prev")).rejects.toBeInstanceOf(
      ApplyFailsafe,
    );
  });
});
