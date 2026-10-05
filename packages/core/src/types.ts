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
  /** Every workspace instance for this workspace has been created. */
  "workspace:opened": WorkspaceRef;
  /** The workspace is closing; awaited in order before its instances go. */
  "workspace:closing": WorkspaceRef;
}

/** Anything a module can `use`: services and other modules' APIs. */
export type Provided = CoreServices & CoreModules;
export type ProvidedName = keyof Provided & string;
export type WorkspaceModuleName = keyof WorkspaceModules & string;
export type HookName = keyof CoreHookMap & string;

export type Disposer = () => void | Promise<void>;
