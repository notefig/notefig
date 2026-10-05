/**
 * The kernel every app module registers with: one composition root
 * (`createCore`), a two-phase start (register, then boot), dependency order
 * from `needs`, per-workspace instances with ordered teardown, and a typed
 * hook bus. React bindings live in `@notefig/core/react`.
 */
export { createCore } from "./create-core";
export { WorkspaceClosedError, WorkspaceOpenError } from "./create-core";
export type {
  Core,
  CoreBase,
  CreateCoreOptions,
  WorkspaceControls,
  WorkspaceHandle,
} from "./create-core";
export { defineModule } from "./define-module";
export type {
  AnyModule,
  ModuleContext,
  ModuleDefinition,
  OpenWorkspaces,
  WorkspaceContext,
  WorkspaceLifecycle,
} from "./define-module";
export type { Hooks } from "./hooks";
export { CoreConfigError } from "./order";
export type {
  CoreHookMap,
  CoreModules,
  CoreServices,
  Disposer,
  HookName,
  Provided,
  ProvidedName,
  WorkspaceModuleName,
  WorkspaceModules,
  WorkspaceRef,
} from "./types";
