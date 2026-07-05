/**
 * Off-thread markdown ↔ ProseMirror-doc conversion, behind the same call
 * shape as calling the codec directly — just promise-based:
 *
 *   const doc = await parseMarkdown(markdown);
 *   const { markdown, hash } = await serializeDoc(doc);
 *
 * Conversion runs in a Web Worker; if the worker cannot boot (or dies), the
 * identical codec runs inline on the main thread so behavior never changes,
 * only where the work happens.
 */

import type { JSONContent } from "@tiptap/core";
import type { MarkdownWorkerApi } from "@/workers/markdown-codec.worker";
import {
  createWorkerClient,
  WorkerRpcError,
  type WorkerClient,
} from "@/workers/worker-rpc";

export interface SerializedDoc {
  markdown: string;
  hash: string;
}

type Converter = WorkerClient<MarkdownWorkerApi>;

async function createInlineConverter(): Promise<Converter> {
  const { createMarkdownCodec } = await import(
    "@/components/editor/markdown-codec"
  );
  const codec = createMarkdownCodec();
  return {
    parse: async (markdown: string) => codec.parse(markdown),
    serialize: async (doc: JSONContent) => {
      const markdown = codec.serialize(doc);
      return { markdown, hash: codec.hash(markdown) };
    },
  };
}

async function bootConverter(): Promise<Converter> {
  try {
    const worker = new Worker(
      new URL("../workers/markdown-codec.worker.ts", import.meta.url),
      { type: "module" },
    );
    const { client, ready } = createWorkerClient<MarkdownWorkerApi>(worker);
    await ready;
    return client;
  } catch (error) {
    console.error(
      "[markdown-conversion] Worker failed to boot, converting on the main thread:",
      error,
    );
    return createInlineConverter();
  }
}

let converterPromise: Promise<Converter> | null = null;

function getConverter(): Promise<Converter> {
  if (!converterPromise) {
    const boot = bootConverter();
    converterPromise = boot;
    // If even the inline fallback failed to load (e.g. a dev server whose
    // dep cache went stale mid-session), don't pin the rejection forever —
    // let the next conversion attempt boot fresh.
    boot.catch(() => {
      if (converterPromise === boot) {
        converterPromise = null;
      }
    });
  }
  return converterPromise;
}

/** Retries on the inline converter if the worker died mid-call. */
async function withConverter<R>(
  call: (converter: Converter) => Promise<R>,
): Promise<R> {
  const converter = await getConverter();
  try {
    return await call(converter);
  } catch (error) {
    if (error instanceof WorkerRpcError && error.workerDead) {
      console.error(
        "[markdown-conversion] Worker died, switching to main-thread conversion:",
        error,
      );
      converterPromise = createInlineConverter();
      return call(await converterPromise);
    }
    throw error;
  }
}

export function parseMarkdown(markdown: string): Promise<JSONContent> {
  return withConverter((c) => c.parse(markdown));
}

export function serializeDoc(doc: JSONContent): Promise<SerializedDoc> {
  return withConverter((c) => c.serialize(doc));
}

/** Test hook: force a fresh boot (e.g. after stubbing Worker). */
export function resetConverterForTests(): void {
  converterPromise = null;
}

/**
 * Per-file sync pipeline. Everything stateful about keeping one markdown
 * file and one editor document in agreement lives here — the editor-side
 * hook only wires editor events in and `setContent` out.
 *
 * Save semantics: every `pushUpdate` ships as it comes; at most one
 * serialize+write is in flight, and edits arriving meanwhile collapse into
 * a single fresh snapshot when it completes (backpressure, no timers).
 */
export class DocumentSync {
  private saving = false;
  private dirty = false;
  /** Bumped on adoption/close so an in-flight serialization of a replaced
   * document is discarded instead of written. */
  private generation = 0;
  private getSnapshot: (() => JSONContent) | null = null;

  /** Markdown the file is known to contain (last write or loaded/adopted
   * content) and its hash. Answers external-change checks with a string
   * compare instead of re-serializing the doc per watcher event. */
  private lastMarkdown: string | null = null;
  private lastHash: string | null = null;

  /** Persists a serialization; assigned by the editor-side hook. */
  writer: ((markdown: string) => Promise<void>) | null = null;

  constructor(readonly path: string) {}

  /** Establish the file-content baseline once; later saves keep it fresh. */
  ensureBaseline(fileContent: string, contentHash?: string): void {
    if (this.lastMarkdown === null) {
      this.lastMarkdown = fileContent;
      this.lastHash = contentHash ?? null;
    }
  }

  /**
   * Whether file state warrants replacing the editor document. False while
   * no baseline exists (content still loading) and for hash churn over
   * unchanged content — replacing the doc then would only reset the caret.
   * trimEnd: files conventionally end with a newline the serializer never
   * emits; that difference alone is not a content change.
   */
  needsAdoption(contentHash: string, fileContent: string): boolean {
    if (this.lastHash === null && this.lastMarkdown === null) return false;
    if (contentHash === this.lastHash) return false;
    if (
      this.lastMarkdown !== null &&
      this.lastMarkdown.trimEnd() === fileContent.trimEnd()
    ) {
      this.lastHash = contentHash;
      return false;
    }
    return true;
  }

  /**
   * Parse external content for adoption. Returns null when local edits are
   * pending — the user's typing wins and its save overwrites the external
   * change (last-writer-wins). Does not mutate sync state; call
   * `commitAdoption` after the editor document has been replaced.
   */
  async prepareAdoption(fileContent: string): Promise<JSONContent | null> {
    const doc = await parseMarkdown(fileContent);
    if (this.saving || this.dirty) return null;
    return doc;
  }

  /** Record that the editor now holds the given file content. */
  commitAdoption(fileContent: string, contentHash: string): void {
    this.generation++;
    this.dirty = false;
    this.lastMarkdown = fileContent;
    this.lastHash = contentHash;
  }

  /** Ship an editor update. The snapshot is taken lazily so a burst of
   * updates costs one `doc.toJSON()` per serialize round, not per edit. */
  pushUpdate(getSnapshot: () => JSONContent): void {
    this.getSnapshot = getSnapshot;
    if (this.saving) {
      this.dirty = true;
      return;
    }
    void this.runSaveLoop();
  }

  close(): void {
    this.generation++;
    this.dirty = false;
    this.getSnapshot = null;
    this.writer = null;
  }

  private async runSaveLoop(): Promise<void> {
    this.saving = true;
    try {
      do {
        this.dirty = false;
        const generation = this.generation;
        const snapshot = this.getSnapshot;
        if (!snapshot) return;
        const { markdown, hash } = await serializeDoc(snapshot());
        // Document replaced (adoption) mid-serialize: drop the stale result;
        // the loop re-runs if post-adoption edits arrived.
        if (generation !== this.generation) continue;

        this.lastMarkdown = markdown;
        this.lastHash = hash;
        await this.writer?.(markdown);
      } while (this.dirty);
    } catch (error) {
      console.error(`Autosave failed for ${this.path}:`, error);
    } finally {
      this.saving = false;
      // An edit that landed during the error path must not go unsaved.
      if (this.dirty) {
        void this.runSaveLoop();
      }
    }
  }
}

const documentSyncs = new Map<string, DocumentSync>();

export function getDocumentSync(path: string): DocumentSync {
  let sync = documentSyncs.get(path);
  if (!sync) {
    sync = new DocumentSync(path);
    documentSyncs.set(path, sync);
  }
  return sync;
}

/** Called when an editor is disposed (tab closed / workspace switch). */
export function closeDocumentSync(path: string): void {
  documentSyncs.get(path)?.close();
  documentSyncs.delete(path);
  parsedDocuments.delete(path);
}

/**
 * Load-path parse: markdown → doc JSON through the worker, cached per path
 * so a component can `use()` it during render (stable promise identity
 * across re-renders). Re-parses if the content changes before the editor
 * mounts; once an editor exists the adoption path takes over and this cache
 * is no longer consulted.
 */
const parsedDocuments = new Map<
  string,
  { content: string; promise: Promise<JSONContent> }
>();

export function openDocument(
  path: string,
  fileContent: string,
  contentHash?: string,
): Promise<JSONContent> {
  const cached = parsedDocuments.get(path);
  if (cached && cached.content === fileContent) return cached.promise;

  const promise = parseMarkdown(fileContent).then((doc) => {
    getDocumentSync(path).ensureBaseline(fileContent, contentHash);
    return doc;
  });
  parsedDocuments.set(path, { content: fileContent, promise });
  return promise;
}
