/**
 * The registries a module widens through declaration merging. A package that
 * registers a module adds its API here, so every consumer of core sees it
 * typed with no central list:
 *
 *   declare module "@notefig/core" {
 *     interface CoreModules { files: FilesApi }
 *     interface WorkspaceModules { files: WorkspaceFiles }
 *     interface CoreHookMap { "file:written": { path: string } }
 *   }
 *
 * `CoreServices` is widened by the composition root, not by modules: it names
 * what the host hands every module (the platform adapter, the query client).
 */

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CoreServices {}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CoreModules {}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WorkspaceModules {}

/** A workspace as core tracks it: `key` identifies it, `path` is native. */
export interface WorkspaceRef {
  key: string;
  path: string;
}

/** Hooks core itself fires. Modules add theirs by widening this map. */
export interface CoreHookMap {
  /** Every module has booted. */
  "core:booted": undefined;
  /** Core is shutting down; awaited in order before disposers run. */
  "core:shutdown": undefined;
  /** Every workspace instance for this workspace has been created. Fires
   *  for any open, a module's restore included. */
  "workspace:opened": WorkspaceRef;
  /**
   * Brought to the front through its handle (`open` or `focus`), after it
   * opened if it was not open. Awaited in order before the call resolves.
   */
  "workspace:focused": WorkspaceRef;
  /**
   * Entered through its handle's `open`: someone chose this workspace, as
   * opposed to a module restoring it or a `focus` bringing it forward.
   * After `workspace:focused`; awaited in order.
   */
  "workspace:entered": WorkspaceRef;
  /** The workspace is closing; awaited in order before its instances go. */
  "workspace:closing": WorkspaceRef;
}

/** Anything a module can `use`: services and other modules' APIs. */
export type Provided = CoreServices & CoreModules;
export type ProvidedName = keyof Provided & string;
export type WorkspaceModuleName = keyof WorkspaceModules & string;
export type HookName = keyof CoreHookMap & string;

export type Disposer = () => void | Promise<void>;

/** What a workspace handle does, open or not. */
export interface WorkspaceControls {
  readonly path: string;
  /** Identity: two spellings of one workspace share it. */
  readonly key: string;
  isOpen(): boolean;
  /**
   * Open it if it is not open, then announce the entry: `workspace:focused`
   * and `workspace:entered`, each awaited. Resolves once every handler has
   * run. Calls for one workspace while one is in flight join it. Does
   * nothing if a close supersedes it while it waits. Rejects with a
   * `WorkspaceOpenError`, skipping what follows, when a module failed to
   * create its instance or a handler failed.
   */
  open(): Promise<void>;
  /** Open it if needed and bring it forward: `workspace:focused` only.
   *  Rejects like `open`. */
  focus(): Promise<void>;
  /** Fire `workspace:closing` (awaited), then dispose its instances. */
  close(): Promise<void>;
}

/**
 * A workspace, open or not. Its module instances (`handle.files`) read
 * while it is open — and while it is closing, so `closing` handlers can
 * reach what they tear down. Reading one otherwise throws.
 */
export type WorkspaceHandle = WorkspaceControls & Readonly<WorkspaceModules>;
