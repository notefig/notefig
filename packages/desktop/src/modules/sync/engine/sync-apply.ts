/**
 * Applying what the sync worker decided, on the main thread. Nothing here
 * parses, diffs or merges: text goes through the documents write path
 * (open editors adopt it as one diffed transaction, out of the undo
 * history, caret kept), binaries and deletions straight to the fs.
 *
 * The one loop is for a document whose open editor holds local edits the
 * remote's content must not clobber: its local text (after its pending
 * save) is sent to the worker to be merged with the branch's version; the
 * result is written only while the editor still holds the version that
 * was merged. If the user typed meanwhile, the newer text is merged again
 * with the snapshot as the base, so the typing survives too.
 */
import type { DocumentsApi } from "@/modules/documents";
import type {
  SyncOverwrite,
  SyncResult,
  SyncWorkerApi,
  SyncWrite,
} from "../sync-types";

/** Tries at writing a merge into an editor the user keeps typing in,
 *  before waiting for the next cycle. */
export const MAX_EDITOR_MERGE_TRIES = 10;
/** How long to wait for an editor's pending save before trying again next
 *  cycle (a save that never lands must not stall sync). */
export const EDITOR_SETTLE_TIMEOUT_MS = 5_000;

const TIMED_OUT = Symbol("timed out");

/** The editor's text once its save landed; `TIMED_OUT` if it didn't. */
async function settledEditorText(deps: ApplyDeps, absolute: string) {
  let cancel: (() => void) | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    const handle = setTimeout(() => resolve(TIMED_OUT), EDITOR_SETTLE_TIMEOUT_MS);
    cancel = () => clearTimeout(handle);
  });
  try {
    return await Promise.race([deps.documents.editorText(absolute), timeout]);
  } finally {
    cancel?.();
  }
}

/** Why applying stopped: the failsafe, with its reason. */
export class ApplyFailsafe extends Error {
  constructor(
    readonly reason: "unrelated" | "validation" | "divergence",
    readonly detail: string,
    readonly paths: string[],
  ) {
    super(detail);
  }
}

export interface ApplyDeps {
  api: Pick<SyncWorkerApi, "reconcile" | "mergeTexts">;
  documents: Pick<DocumentsApi, "write" | "editorText">;
  fs: {
    readFiles(paths: string[]): Promise<{ succeeded: { path: string; content: string }[] }>;
    readBinaryFiles(paths: string[]): Promise<{ succeeded: { path: string; data: Uint8Array }[] }>;
    writeBinaryFiles(files: { path: string; data: Uint8Array }[]): Promise<unknown>;
    deleteFiles(paths: string[]): Promise<unknown>;
  };
  /** A worker answer, or the cycle stops with its fault. */
  unwrap<T>(result: SyncResult<T>): T;
  /** A merge overwrote text (`recoveryRef` keeps the local side). */
  overwritten(record: SyncOverwrite, recoveryRef: string | null): void;
}

/** Merged text written into `path` and its editor. */
interface Written {
  content: string;
}

const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

type LocalSide = {
  editor: { text: string; version: object } | null;
  ours: { text: string } | { bytes: Uint8Array };
};

/** The file's local bytes: the editor's text, or what is on disk. */
async function localSide(
  deps: ApplyDeps,
  absolute: string,
  tree: string,
): Promise<LocalSide | null | typeof TIMED_OUT> {
  const editor = await settledEditorText(deps, absolute);
  if (editor === TIMED_OUT) return TIMED_OUT;
  if (editor) return { editor, ours: { text: editor.text } };
  if (isMarkdown(tree)) {
    const read = await deps.fs.readFiles([absolute]);
    const text = read.succeeded[0]?.content;
    return text === undefined ? null : { editor: null, ours: { text } };
  }
  const read = await deps.fs.readBinaryFiles([absolute]);
  const bytes = read.succeeded[0]?.data;
  return bytes === undefined ? null : { editor: null, ours: { bytes } };
}

/**
 * Write `content` into `absolute` while the editor still holds the text
 * it was merged from (`base`); merge again from the snapshot when it
 * moved on. Null when it couldn't land yet (the editor holds unsaved
 * edits, or kept moving): the caller retries next cycle.
 */
async function writeIntoEditor(
  deps: ApplyDeps,
  absolute: string,
  tree: string,
  merged: { content: string; base: string; version: object | undefined },
): Promise<Written | null> {
  let { content, base, version } = merged;
  for (let attempt = 0; attempt < MAX_EDITOR_MERGE_TRIES; attempt++) {
    const outcome = await deps.documents.write(absolute, content, {
      source: "sync",
      ...(version !== undefined ? { expect: version } : {}),
    });
    if (outcome === "written") return { content };
    if (outcome === "held") return null;
    const next = await settledEditorText(deps, absolute);
    if (next === TIMED_OUT) return null;
    if (!next) {
      version = undefined;
      continue;
    }
    const again = deps.unwrap(
      await deps.api.mergeTexts({ path: tree, base, ours: next.text, theirs: content }),
    );
    if (again.status === "failed") throw new ApplyFailsafe(again.reason, again.detail, [tree]);
    if (again.overwritten.length > 0) {
      deps.overwritten({ path: tree, fragments: again.overwritten }, null);
    }
    content = again.content;
    base = next.text;
    version = next.version;
  }
  return null;
}

async function writeOther(deps: ApplyDeps, absolute: string, write: SyncWrite) {
  if (write.kind === "binary") {
    await deps.fs.writeBinaryFiles([{ path: absolute, data: write.bytes }]);
  } else if (write.kind === "delete") {
    await deps.fs.deleteFiles([absolute]);
  }
}

/**
 * Bring local edits to `tree` made on `previous` (not committed) onto the
 * branch: the worker merges them, the result is written. Resolves with
 * the text written (null for a binary or deletion), or `"pending"` when
 * the editor kept it from landing yet.
 */
export async function reconcileLocalEdits(
  deps: ApplyDeps,
  absolute: string,
  tree: string,
  previous: string,
): Promise<Written | { content: null } | "pending"> {
  const local = await localSide(deps, absolute, tree);
  if (local === TIMED_OUT) return "pending";
  // Deleted here meanwhile: the deletion is what gets committed.
  if (!local) return { content: null };
  const outcome = deps.unwrap(await deps.api.reconcile({ path: tree, previous, ours: local.ours }));
  if (outcome.status === "failed") {
    throw new ApplyFailsafe(outcome.reason, outcome.detail, [tree]);
  }
  if (outcome.overwritten) deps.overwritten(outcome.overwritten, outcome.recoveryRef);
  const { write } = outcome;
  if (write.kind !== "text") {
    await writeOther(deps, absolute, write);
    return { content: null };
  }
  const written = await writeIntoEditor(deps, absolute, tree, {
    content: write.text,
    base: "text" in local.ours ? local.ours.text : "",
    version: local.editor?.version,
  });
  return written ?? "pending";
}

/**
 * Write `text` over whatever `absolute` holds, open editor included (the
 * failsafe's "Accept all incoming": the user chose the remote's version).
 */
export async function overwriteDocument(
  deps: ApplyDeps,
  absolute: string,
  text: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_EDITOR_MERGE_TRIES; attempt++) {
    const editor = await settledEditorText(deps, absolute);
    if (editor === TIMED_OUT) continue;
    const outcome = await deps.documents.write(absolute, text, {
      source: "sync",
      ...(editor ? { expect: editor.version } : {}),
    });
    if (outcome === "written") return true;
  }
  return false;
}
