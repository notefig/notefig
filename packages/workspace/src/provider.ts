/**
 * The one seam shape every desktop-facing boundary in this package uses:
 * a single-slot function reference, swapped in once at app boot, read
 * through on every call. This is `registry.ts`'s counterpart for state that
 * isn't identity-keyed — desktop has exactly one live Tiptap layer, one file
 * collection layer, one git layer, one dockable layout, so there's exactly
 * one implementation to register, not a per-id map.
 *
 * Deliberately holds only the current function reference, nothing else —
 * registering a new implementation drops the old one immediately (GC'd, no
 * accumulation). No snapshot or handle is ever cached here; see the note in
 * each handle module for why that matters.
 */
export type ProviderFn<Args extends unknown[], Snapshot> = (...args: Args) => Snapshot;

export interface Provider<Args extends unknown[], Snapshot> {
  register(impl: ProviderFn<Args, Snapshot>): void;
  resolve: ProviderFn<Args, Snapshot>;
}

export function createProvider<Args extends unknown[], Snapshot>(
  fallback: ProviderFn<Args, Snapshot>,
): Provider<Args, Snapshot> {
  let impl: ProviderFn<Args, Snapshot> = fallback;
  return {
    register(next) {
      impl = next;
    },
    resolve(...args) {
      return impl(...args);
    },
  };
}
