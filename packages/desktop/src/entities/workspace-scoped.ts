/**
 * One idiom for "a thing that exists per open workspace".
 *
 * File collections, the git collection, the tree's expansion memory and the
 * sidebar's last-used tool each used to keep a module-level `Map` keyed by
 * workspace, with its own get-or-create and — sometimes — its own clear that
 * `closeWorkspace` had to remember to call. Two of the four never cleared at
 * all, and the git one could be resurrected by any lazy read after close,
 * with nothing left to dispose it.
 *
 * The open-workspaces collection already says what is open. This mirrors it
 * exactly the way `utils/workspace-watchers.ts` does: one subscription, armed
 * at boot, disposes a scope's value when its row leaves the set. A scope is a
 * `create` (and optional `dispose`) — nothing else.
 *
 * Membership is only enforceable while something publishes it. With the
 * subscription live (every real boot), `get` refuses a workspace that is not
 * open, so a straggling read after close creates nothing. Without it (unit
 * tests that never boot the runtime) `get` behaves like the old get-or-create,
 * so suites that never inserted an open row keep working unchanged.
 */
import { openWorkspacesCollection } from "@/entities/open-workspaces";
import { path as pathutil, workspaceKey } from "@/utils/path";

export interface WorkspaceScope<T> {
  /**
   * The workspace's value, created on first read. `undefined` when the
   * workspace is not open (only while the subscription is live — see above).
   */
  get(workspacePath: string): T | undefined;
  /**
   * The value whether or not the workspace is open. Still tracked: a row
   * deleted later disposes it. For call sites that predate the membership
   * rule and dereference the result unconditionally; prefer `get`.
   */
  getOrCreate(workspacePath: string): T;
  /** The value if it exists, without creating one. */
  peek(workspacePath: string): T | undefined;
  /** Dispose and forget the value now; the next read recreates it. */
  drop(workspacePath: string): void;
  /** Every live value — for the rare scan that has no workspace in hand. */
  values(): Iterable<T>;
}

interface Scope {
  drop(key: string): void;
  dropAll(): void;
}

/** Every scope ever declared; the subscription fans a delete out to all. */
const scopes = new Set<Scope>();

let activeSubscription: (() => void) | null = null;

export function workspaceScoped<T>(options: {
  /** Receives the normalized native spelling, like every downstream call. */
  create: (nativePath: string) => T;
  dispose?: (value: T, nativePath: string) => void;
}): WorkspaceScope<T> {
  const values = new Map<string, { value: T; native: string }>();

  const create = (workspacePath: string): T => {
    const key = workspaceKey(workspacePath);
    const existing = values.get(key);
    if (existing) return existing.value;
    // Registry key vs value: workspaceKey collapses Windows respellings onto
    // one entry; the value is built from the first caller's native spelling.
    const native = pathutil.normalize(workspacePath);
    const value = options.create(native);
    values.set(key, { value, native });
    return value;
  };

  const scope: Scope = {
    drop(key) {
      const entry = values.get(key);
      if (!entry) return;
      values.delete(key);
      options.dispose?.(entry.value, entry.native);
    },
    dropAll() {
      for (const key of [...values.keys()]) scope.drop(key);
    },
  };
  scopes.add(scope);

  return {
    get(workspacePath) {
      const key = workspaceKey(workspacePath);
      if (values.has(key)) return values.get(key)!.value;
      if (activeSubscription && !openWorkspacesCollection.has(key)) {
        return undefined;
      }
      return create(workspacePath);
    },
    getOrCreate: create,
    peek(workspacePath) {
      return values.get(workspaceKey(workspacePath))?.value;
    },
    drop(workspacePath) {
      scope.drop(workspaceKey(workspacePath));
    },
    values() {
      return [...values.values()].map((entry) => entry.value);
    },
  };
}

/**
 * Begin mirroring the open set into every scope's lifetime. Idempotent per
 * process: call it once during boot — a second call while one is live is a
 * no-op that returns the same disposer. The disposer also drops every
 * scope's values — app teardown and tests both need that.
 */
export function startWorkspaceScopeSubscription(): () => void {
  if (activeSubscription) return activeSubscription;

  const subscription = openWorkspacesCollection.subscribeChanges((changes) => {
    for (const change of changes) {
      if (change.type !== "delete") continue;
      const key = String(change.key);
      for (const scope of scopes) scope.drop(key);
    }
  });

  const dispose = () => {
    if (activeSubscription !== dispose) return;
    activeSubscription = null;
    subscription.unsubscribe();
    for (const scope of scopes) scope.dropAll();
  };
  activeSubscription = dispose;
  return dispose;
}
