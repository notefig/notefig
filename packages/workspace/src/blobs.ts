/**
 * BlobHandle — identity + reads over one fenced blob inside a file's
 * markdown, plus the reverse link (`.file()`) and the authoring-task lookup.
 * Blobs aren't stored anywhere; they're re-parsed from the file's current
 * content on every call, preferring the live editor over disk (matching
 * desktop's existing `answerBlob`/`readAuthoritativeMarkdown` precedent).
 */
import { findBlobs, type BlobEnvelope, type BlobLocation } from "@metrists/shared";
import { createProvider } from "./provider";
import { editor } from "./editors";
import { file, type FileHandle } from "./files";

export interface AuthorTaskInfo {
  taskId: string;
  blobType: string;
  path: string;
}

export type AuthorTaskLookup = (blobId: string) => AuthorTaskInfo | undefined;

const authorTaskProvider = createProvider<[string], AuthorTaskInfo | undefined>(
  () => undefined,
);

export const registerAuthorTaskLookup: (next: AuthorTaskLookup) => void =
  authorTaskProvider.register;

export interface BlobHandle {
  readonly workspacePath: string;
  readonly filePath: string;
  readonly blobId: string;
  envelope(): BlobEnvelope | undefined;
  file(): FileHandle;
  authorTask(): AuthorTaskInfo | undefined;
}

function currentContent(workspacePath: string, filePath: string): string | undefined {
  const mounted = editor(workspacePath, filePath).markdownText();
  if (mounted !== undefined) return mounted;
  return file(workspacePath, filePath).content();
}

export function blob(workspacePath: string, filePath: string, blobId: string): BlobHandle {
  return {
    workspacePath,
    filePath,
    blobId,
    envelope() {
      const content = currentContent(workspacePath, filePath);
      if (content === undefined) return undefined;
      return findBlobs(content).find(
        (loc: BlobLocation) => loc.blob.envelope.id === blobId,
      )?.blob.envelope;
    },
    file() {
      return file(workspacePath, filePath);
    },
    authorTask() {
      return authorTaskProvider.resolve(blobId);
    },
  };
}

/** All blobs currently present in a file's content — backs both
 *  `TabHandle.blobs()` and `FileHandle.blobs()`. */
export function blobsForFile(workspacePath: string, filePath: string): BlobHandle[] {
  const content = currentContent(workspacePath, filePath);
  if (content === undefined) return [];
  return findBlobs(content).map((loc: BlobLocation) =>
    blob(workspacePath, filePath, loc.blob.envelope.id),
  );
}
