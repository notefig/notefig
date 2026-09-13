/**
 * The service host contract: everything the orchestration core needs from
 * whatever is hosting it, and the only channel through which it may ask.
 *
 * This interface was derived by inventory, not designed — every member below
 * exists because a module moved into this package used to import it from
 * `packages/desktop/src`. The list turned out small: the desktop-reaching
 * imports were dominated by `utils/fs`, `utils/file-sync` and
 * `utils/history-service`, which are already platform abstractions and arrive
 * as surfaces rather than host members. What was left is four ambient
 * services and the editor.
 *
 * Two rules keep it honest:
 *
 *  - **Capabilities, never platform identity.** Core code branches on
 *    `capabilities.canSpawnHarnesses`, never on `isBrowser`/`isDesktop`. A
 *    host that cannot do something says so; the core does not guess from
 *    where it thinks it is running.
 *  - **Degrade, don't disappear.** A host that has no editor still satisfies
 *    `editor` — with an implementation that returns `{ attached: false }`.
 *    The tool surface is then identical everywhere, and a harness gets a
 *    declared answer instead of a missing tool.
 */
import type { EditorContextPort } from "./editor-context-port";

/**
 * What this host can do. Declared, not inferred — a headless CLI and a
 * browser tab differ here, and nowhere else, as far as the core is
 * concerned.
 */
export type HostCapabilities = {
  /**
   * Whether the host can start harness processes. False in an unpaired
   * browser tab, which has no process surface at all; task creation fails
   * with a declared error rather than an exception from deep in the core.
   */
  canSpawnHarnesses: boolean;
  /**
   * Whether work continues when no UI is attached. False in a browser tab
   * (closing it stops everything) and true for a service process. Triggers
   * consult this rather than pretending background execution exists.
   */
  runsInBackground: boolean;
};

/** Analytics sink. The core emits events; it never decides whether they are
 *  collected, batched, or dropped — that is the host's consent question. */
export type TelemetrySink = {
  captureEvent(name: string, properties?: Record<string, unknown>): void;
};

export type ServiceHost = {
  capabilities: HostCapabilities;

  telemetry: TelemetrySink;

  /**
   * Resolve a translation key. One call site today (the ACP client's
   * `translate`), which is exactly why this is a function rather than an
   * i18n instance: the core should not gain the ability to do more i18n
   * without that showing up as a contract change.
   */
  translate(key: string): string;

  /**
   * Name of the app's per-workspace directory (`.notefig`). Passed to
   * harness adapters that need to scope files. A value, not a service —
   * hosts agree on it, but the core should not hardcode branding.
   */
  appDirName: string;

  editor: EditorContextPort;
};
