/**
 * The service host contract: everything the orchestration core needs from
 * whatever is hosting it, and the only channel through which it may ask.
 *
 * Derived by inventory, not designed — every member exists because a module
 * moving into this package used to reach for it. Two sources fed the list:
 * the platform surfaces the core calls (`platform`, see ./platform.ts) and
 * the ambient services it reaches for directly. The second list is small:
 * across ~2,800 lines the moved code calls `i18n.t` once, `captureEvent`
 * twice and reads `APP_DIR_NAME` once. That is the whole ambient surface.
 *
 * ## Two rules
 *
 * **Capabilities, never platform identity.** Core code asks what a host can
 * do; it never branches on `isBrowser`/`isDesktop`, and never guesses from
 * where it thinks it is running.
 *
 * **Degrade, don't disappear.** A host that lacks something still satisfies
 * the contract, so the tool surface is identical everywhere and a harness
 * gets a declared answer instead of a missing tool.
 *
 * ## Which degradation style
 *
 * Both styles below are legitimate; the difference is who needs the answer
 * and when.
 *
 *   - **Optional member** — when a caller must branch *before* acting, so
 *     the compiler should force the check. `platform.proc` is absent on a
 *     host that cannot spawn processes: task creation asks first and fails
 *     with a declared error.
 *
 *   - **Always present, self-declaring** — when the thing must still answer
 *     rather than vanish. `editor` is always there; a headless host supplies
 *     `detachedEditorContext`, whose `attached: false` is the answer. Making
 *     it optional instead would let editor-backed tools disappear from the
 *     registry, which is exactly what this contract exists to prevent.
 *
 * A capability that duplicates a surface belongs to neither style and should
 * not exist. An earlier draft carried `canSpawnHarnesses`, which restated
 * what `platform.proc`'s presence already says; it is gone.
 */
import type { PathFlavor } from "@notefig/shared/utils";
import type { EditorContextPort } from "./editor-context-port";
import type { CorePlatform } from "./platform";

/**
 * What this host can do, where no surface already answers the question.
 * Deliberately small — if a capability can be expressed as the presence of a
 * surface, express it that way instead.
 */
export type HostCapabilities = {
  /**
   * Whether work continues when no UI is attached. False in a browser tab
   * (closing it stops everything) and true for a service process. Triggers
   * and background reconciliation consult this rather than pretending
   * background execution exists.
   *
   * This has no surface equivalent, which is why it is a flag.
   */
  runsInBackground: boolean;
};

/** Analytics sink. The core emits events; it never decides whether they are
 *  collected, batched, or dropped — that is the host's consent question. */
export type TelemetrySink = {
  captureEvent(name: string, properties?: Record<string, unknown>): void;
};

export type ServiceHost = {
  /** fs, and optionally proc and db. See ./platform.ts. */
  platform: CorePlatform;

  capabilities: HostCapabilities;

  /**
   * The host's bound path flavor: win32 iff the shell runs on Windows,
   * posix everywhere else (MET-157). A member rather than something this
   * package detects, because detection needs an OS the core cannot see —
   * and because the host has already made the decision for its adapters,
   * so asking twice is how the two come to disagree.
   */
  path: PathFlavor;

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

  /** Always present; `attached: false` when there is no editor. */
  editor: EditorContextPort;
};
