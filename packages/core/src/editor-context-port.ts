/**
 * The editor seam. Four things in the core need to know what a human has on
 * screen — the `workspace_open_files`, `document_read_range` and
 * `author_blob` tools, and the widget-context MCP resource — and in the
 * desktop app all four reach into ProseMirror, the editor store, the
 * document outline, the markdown codec and the blob registry.
 *
 * None of that can live here: this package compiles without DOM types, and a
 * headless host has no editor at all. So the port exposes **projections, not
 * documents** — every method returns plain data. ProseMirror stays entirely
 * on the desktop side of this interface, which is what lets a `PMNode` never
 * appear in a core signature.
 *
 * `attached` is the degradation switch. A headless host implements this
 * interface with `attached: false` and null-returning methods, so the tools
 * still exist and still answer — with a declared "no editor is attached to
 * this session" — instead of vanishing from the registry and making the tool
 * surface depend on where the core happens to be running.
 */

/** One heading in a document's structure. */
export type OutlineEntry = { level: number; text: string };

/** What the user has open in one workspace. Mirrors the desktop's
 *  `WorkspaceEditorContext`, which is read from the layout URL. */
export type WorkspaceEditorSnapshot = {
  openFiles: Array<{ path: string; dirty: boolean; active: boolean }>;
  activeFile: string | null;
  /** Whether the active file has a non-empty selection. */
  selection?: boolean;
};

/**
 * A document as seen from one position in it — what the widget-context
 * resource needs to tell an agent where the user is standing.
 */
export type DocumentPositionContext = {
  /** Full heading structure: a map of the document without its body text. */
  outline: OutlineEntry[];
  /** Nearest heading at or before the position. */
  headingText: string | null;
  /** Text window around the position. */
  surroundingText: string;
  /** Current selection in this document, if any. */
  selectedText: string | null;
};

/** A blob type the host can author, as `author_blob` advertises it. */
export type BlobTypeDescriptor = {
  type: string;
  description: string;
};

export interface EditorContextPort {
  /**
   * Whether a real editor backs this port. When false every method below
   * returns null, and callers report that as a declared outcome rather than
   * an error — a headless run legitimately has nothing open.
   */
  readonly attached: boolean;

  /** What the user has open. Null when nothing is attached. */
  openFiles(workspacePath: string): WorkspaceEditorSnapshot | null;

  /**
   * Project a document around `pos`. The desktop implementation prefers the
   * live editor's in-memory doc and falls back to parsing the file from
   * disk, so an unopened file still answers.
   */
  documentContext(
    absolutePath: string,
    pos: number,
  ): Promise<DocumentPositionContext | null>;

  /**
   * Text of a ProseMirror range — the same coordinate space the widget
   * context's `selectedRange` reports, so an agent can hand one back here.
   */
  readRange(
    absolutePath: string,
    from: number,
    to: number,
  ): Promise<string | null>;

  /** Blob types available for authoring. Null when nothing is attached. */
  blobTypes(): BlobTypeDescriptor[] | null;
}

/**
 * The headless implementation: everything declines, nothing throws.
 *
 * Kept here rather than in each host so "no editor" has exactly one
 * definition, and so a new port method cannot be added without deciding what
 * a headless host answers for it — the compiler asks.
 */
export const detachedEditorContext: EditorContextPort = {
  attached: false,
  openFiles: () => null,
  documentContext: async () => null,
  readRange: async () => null,
  blobTypes: () => null,
};
