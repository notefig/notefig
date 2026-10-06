/**
 * Documents — `core.documents`: reading and writing a workspace text file
 * as the agent does (ACP fs/read_text_file and fs/write_text_file,
 * author_blob, history_restore, blob answers), wherever it lives among the
 * open workspaces.
 *
 * The write is the *adopting* primitive. The platform watcher suppresses
 * its echo (consume-one registration in the adapters/src-tauri), and even
 * when one slips through, adoption is a no-op once the editor holds the
 * content — right for an autosave, but an agent write to a document open in
 * an editor must not wait on a watcher round-trip that may never come. So
 * after the disk write it brings every loaded row forward and pushes the
 * content into the live editor itself, through the same
 * `DocumentSync.prepareAdoption`/`commitAdoption` API `useEditorFileSync`
 * uses for external changes. `prepareAdoption` returning null (a local edit
 * mid-autosave-debounce) keeps last-writer-wins: the user's edit wins,
 * exactly like any external change arriving mid-edit.
 *
 * Writes to one path are serialized here, and a path being moved (a
 * scratchpad promotion renaming an open tab) redirects the writes that
 * overlap the move to wherever the file settles. Both are this module's
 * state: the mover (`core.tabs.renameOpenFile`) announces the move with
 * `beginMove` and waits for `whenWritesSettled` before touching the file.
 */
import { defineModule } from "@notefig/core";
import {
  FsError,
  type FileSystemSurface,
} from "@/adapters/platform-adapter.interface";
import type { WorkspaceFiles } from "@/modules/files";
import type { EditorsApi } from "@/modules/editors";
import { calculateContentHash } from "@/utils/hash";
import { getDocumentSync } from "@/utils/markdown-conversion";
import { path as pathutil } from "@/utils/path";
import {
  adoptExternalContent,
  type AdoptionSource,
} from "@/components/editor/adopt-external-content";
import { getEditorMarkdown } from "@/components/editor/use-editor-file-sync";

export interface DocumentsApi {
  /** A file's text, from disk; `line` (1-based) and `limit` cut a range. */
  read(
    path: string,
    options?: { line?: number; limit?: number },
  ): Promise<string>;
  /** Write a file's text and bring every loaded copy of it forward: rows
   *  and an open editor. Writes to one path run one after another; a write
   *  that overlaps a move of its path (`beginMove`) lands where the file
   *  settled. */
  write(path: string, content: string): Promise<void>;
  /** Resolves once every write in flight for `path` has landed (or failed). */
  whenWritesSettled(path: string): Promise<void>;
  /**
   * The file at `path` is about to move. Until `settle` names where it
   * ended up (the new path, or `path` itself if the move failed), a write
   * to `path` waits and then lands there. The check against a pending move
   * and the write's registration are one synchronous step, so a move that
   * begins after a write sees it in `whenWritesSettled`, and one that began
   * before redirects it. Throws if a move of `path` is already pending.
   */
  beginMove(path: string): { settle(finalPath: string): void };
}

/** What documents are built from. */
export interface DocumentsDeps {
  fs: Pick<FileSystemSurface, "readFiles" | "writeFiles">;
  /** The files of every open workspace (a path may sit in nested ones). */
  openFiles(): WorkspaceFiles[];
  /** The live editor of an open document, which the write adopts into. */
  editors: Pick<EditorsApi, "markdownEditor">;
  /** Which prompt round wrote adopted bytes (`core.turnWrites.attribute`). */
  attribute?: AdoptionSource["attribute"];
}

/**
 * The app-layer choke point for the "workspace paths are absolute"
 * invariant: a relative path here would reach the OS resolved against the
 * process CWD (src-tauri/ under `cargo tauri dev` — agent-supplied
 * workspace-relative paths once wrote into the app's own source tree and
 * restarted the dev app on every write). Callers with agent-supplied paths
 * resolve them first (resolveWorkspacePath in utils/fs); this throws into
 * the standard FsError boundary if anyone forgets.
 */
function assertAbsolute(path: string): void {
  if (!pathutil.isAbsolute(path)) {
    throw new FsError(
      "invalid_path",
      path,
      `workspace file paths must be absolute, got "${path}" (resolve agent paths with resolveWorkspacePath first)`,
    );
  }
}

export function createDocuments({
  fs,
  openFiles,
  editors,
  attribute,
}: DocumentsDeps): DocumentsApi {
  /** path → the chain of writes in flight on it. */
  const inFlight = new Map<string, Promise<void>>();
  /** path → where a pending move of it will have put the file. */
  const pendingMoves = new Map<string, Promise<string>>();

  /** Run `write`, serialized after any in-flight write to the same path. */
  const trackWrite = (path: string, write: () => Promise<void>) => {
    const previous = inFlight.get(path) ?? Promise.resolve();
    const op = previous.catch(() => {}).then(write);
    const settled = op.catch(() => {});
    inFlight.set(path, settled);
    void settled.then(() => {
      if (inFlight.get(path) === settled) inFlight.delete(path);
    });
    return op;
  };

  const writeToDisk = async (path: string, content: string) => {
    const result = await fs.writeFiles([{ path, content }]);
    const failure = result.failed[0];
    if (failure) throw new FsError(failure.type, failure.path, failure.message);
  };

  /** Rows lead disk for every app write: this write's echo is consumed
   *  natively, so nothing else would bring them forward, and adoption
   *  would later roll the editor back to the stale row. */
  const updateLoadedRows = (path: string, content: string) => {
    for (const files of openFiles()) files.updateLoadedContent(path, content);
  };

  return {
    async read(path, options) {
      assertAbsolute(path);
      const result = await fs.readFiles([path]);
      const failure = result.failed[0];
      if (failure) {
        throw new FsError(failure.type, failure.path, failure.message);
      }
      const content = result.succeeded[0].content;
      if (!options?.line && !options?.limit) return content;
      // ACP lines are 1-based.
      const lines = content.split("\n");
      const start = Math.max(0, (options.line ?? 1) - 1);
      const end = options.limit ? start + options.limit : lines.length;
      return lines.slice(start, end).join("\n");
    },

    async write(path, content) {
      assertAbsolute(path);
      // The file may be moving right now — wait it out and write to
      // wherever it settled, so an overlapping agent write can't resurrect
      // the old path.
      const move = pendingMoves.get(path);
      const target = move ? await move : path;
      return trackWrite(target, async () => {
        await writeToDisk(target, content);
        updateLoadedRows(target, content);

        const editor = editors.markdownEditor(target);
        if (!editor || editor.isDestroyed) return;
        const sync = getDocumentSync(target);
        const doc = await sync.prepareAdoption(content);
        if (!doc || editor.isDestroyed) return;
        const contentHash = calculateContentHash(content);
        const adoption = adoptExternalContent(editor, doc, {
          source: { path: target, contentHash, attribute },
        });
        if (adoption.reinsertedWidgets === 0) {
          sync.commitAdoption(content, contentHash);
          return;
        }
        // Re-asserted widget markers exist only in the editor at this
        // point. Repair the file INSIDE this tracked write — a
        // fire-and-forget save could still be in flight when the next
        // same-path agent write arrives, which would skip that write's
        // adoption (sync busy) and then clobber its newer content.
        const repaired = getEditorMarkdown(editor);
        await writeToDisk(target, repaired);
        updateLoadedRows(target, repaired);
        sync.commitAdoption(repaired, calculateContentHash(repaired));
      });
    },

    whenWritesSettled(path) {
      return inFlight.get(path) ?? Promise.resolve();
    },

    beginMove(path) {
      if (pendingMoves.has(path)) {
        throw new Error(`A move of "${path}" is already in progress`);
      }
      let settle!: (finalPath: string) => void;
      pendingMoves.set(
        path,
        new Promise<string>((resolve) => {
          settle = resolve;
        }),
      );
      return {
        settle(finalPath) {
          pendingMoves.delete(path);
          settle(finalPath);
        },
      };
    },
  };
}

declare module "@notefig/core" {
  interface CoreModules {
    documents: DocumentsApi;
  }
}

export const documentsModule = defineModule({
  name: "documents",
  needs: ["platform", "turnWrites", "editors"],
  register: (ctx) =>
    createDocuments({
      fs: ctx.use("platform").fs,
      editors: ctx.use("editors"),
      attribute: ctx.use("turnWrites").attribute,
      openFiles: () =>
        ctx.workspaces
          .list()
          .map((workspace) => ctx.workspaceHandle(workspace.path).files),
    }),
});
