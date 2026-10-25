/**
 * The last session's URL — layout, sidebar, open dialogs — kept across
 * launches. The URL carries the session; this module restores it on a cold
 * boot (a bare "/") and records it as it changes.
 *
 * It lives in a KV namespace of its own: nothing renders from it, so
 * recording a tab click is a write and nothing else. Kept in the settings
 * namespace, every URL change re-rendered everything that reads settings
 * — the app root among them.
 */
import { defineModule } from "@notefig/core";
import { urlModule } from "@/core/services";
import { kvModule, type KvApi } from "@/modules/kv";
import type { UrlState } from "@/modules/layout";

const NAMESPACE = "session";
const KEY = "lastSearch";
/** Where the last search was kept before it had a namespace of its own;
 *  read when this one has none yet, so an update keeps the user's layout. */
const LEGACY_NAMESPACE = "settings";

declare module "@notefig/core" {
  interface CoreModules {
    session: undefined;
  }
}

/** The search to restore, if any: this namespace's, else the legacy key. */
async function savedSearch(kv: KvApi): Promise<string | null> {
  const saved = await kv.read<string | null>(NAMESPACE, KEY);
  if (saved !== undefined) return saved;
  return (await kv.read<string | null>(LEGACY_NAMESPACE, KEY)) ?? null;
}

/**
 * Restore once the saved search has loaded, then record the URL as it
 * stands and every change after. Each is written as it happens — a quit leaves nothing pending — and recording
 * starts only after the restore, so the bare boot URL is never saved over
 * the last session. Only the app's own route ("/") is restored or recorded.
 * Returns the stop.
 */
export function trackSession(kv: KvApi, url: UrlState): () => void {
  let stopped = false;
  let unsubscribe = () => {};
  const record = () => {
    if (url.pathname() !== "/") return;
    // One encoding of "nothing": an empty search is stored as null.
    void kv.write(NAMESPACE, KEY, url.search() || null);
  };

  void savedSearch(kv).then((saved) => {
    if (stopped) return;
    if (url.pathname() === "/" && !url.search() && saved) {
      url.setSearch(saved, { replace: true });
    }
    // The URL as it stands now is the session too — one opened with a
    // layout, and kept unchanged until quit, must outlive the launch.
    record();
    unsubscribe = url.subscribe(record);
  });

  return () => {
    stopped = true;
    unsubscribe();
  };
}

export const sessionModule = defineModule({
  name: "session",
  needs: [kvModule, urlModule],
  boot: (_api, ctx) => trackSession(ctx.use("kv"), ctx.use("url")),
});
