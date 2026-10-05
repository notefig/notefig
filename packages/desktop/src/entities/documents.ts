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
 * Per-path write serialization across parallel tasks is deliberately not
 * implemented here — two tasks writing the same path race like any two
 * independent writes. If that becomes a real problem, serialization returns
 * as an internal detail of `write`.
 */
import { defineModule } from "@notefig/core";
import {
  FsError,
  type FileSystemSurface,
} from "@/adapters/platform-adapter.interface";
import type { WorkspaceFiles } from "./files";
import { getMarkdownEditor } from "./editors";
import { activeRenameTarget } from "./tabs";
import { calculateContentHash } from "@/utils/hash";
import { getDocumentSync } from "@/utils/markdown-conversion";
import { path as pathutil } from "@/utils/path";
import { trackWorkspaceWrite } from "@/utils/workspace-write-tracker";
import { adoptExternalContent } from "@/components/editor/adopt-external-content";
import { getEditorMarkdown } from "@/components/editor/use-editor-file-sync";

export interface DocumentsApi {
  /** A file's text, from disk; `line` (1-based) and `limit` cut a range. */
  read(
    path: string,
    options?: { line?: number; limit?: number },
  ): Promise<string>;
  /** Write a file's text and bring every loaded copy of it forward: rows
   *  and an open editor. */
  write(path: string, content: string): Promise<void>;
}

/** What documents are built from. */
export interface DocumentsDeps {
  fs: Pick<FileSystemSurface, "readFiles" | "writeFiles">;
  /** The files of every open workspace (a path may sit in nested ones). */
  openFiles(): WorkspaceFiles[];
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
}: DocumentsDeps): DocumentsApi {
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
      // A rename-open-tab (scratchpad promotion) may be moving this exact
      // file right now — wait it out and write to wherever the file
      // settled, so an overlapping agent write can't resurrect the old
      // path. The redirect check and the in-flight registration below are
      // one synchronous block: a rename beginning after it sees this write
      // via whenWorkspaceWritesSettled; one beginning before is seen here.
      const renameTarget = activeRenameTarget(path);
      const target = renameTarget ? await renameTarget : path;
      return trackWorkspaceWrite(target, async () => {
        await writeToDisk(target, content);
        updateLoadedRows(target, content);

        const editor = getMarkdownEditor(target);
        if (!editor || editor.isDestroyed) return;
        const sync = getDocumentSync(target);
        const doc = await sync.prepareAdoption(content);
        if (!doc || editor.isDestroyed) return;
        const contentHash = calculateContentHash(content);
        const adoption = adoptExternalContent(editor, doc, {
          source: { path: target, contentHash },
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
  };
}

declare module "@notefig/core" {
  interface CoreModules {
    documents: DocumentsApi;
  }
}

export const documentsModule = defineModule({
  name: "documents",
  needs: ["platform"],
  register: (ctx) =>
    createDocuments({
      fs: ctx.use("platform").fs,
      openFiles: () =>
        ctx.workspaces
          .list()
          .map((workspace) => ctx.workspaceHandle(workspace.path).files),
    }),
});
