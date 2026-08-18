import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { platformAdapter } from "@/adapters";
import {
  LAYOUT_PARAM,
  findLayoutSelectedTab,
  parseLayout,
} from "@/utils/layout-codec";
import { openFileInLayout } from "@/utils/dockable-layout";
import { ensureMarketingWorkspaceSeeded } from "./seed";
import { marketingDocs, type MarketingDoc } from "./content-manifest";

// One seed per page load, shared by every docs route mount.
let seedPromise: Promise<void> | null = null;

/**
 * True once the workspace can mount for this doc: content seeded AND the
 * URL layout has been initialized for a doc at least once. Deliberately
 * latches — tab interactions inside the workspace must never unmount it.
 */
export function useDocsWorkspaceReady(doc: MarketingDoc): boolean {
  const seeded = useMarketingSeed();
  const layoutReady = useDocsUrlSync(doc);
  return seeded && layoutReady;
}

/** True once the marketing workspace content is in IndexedDB. */
function useMarketingSeed(): boolean {
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    seedPromise ??= ensureMarketingWorkspaceSeeded(platformAdapter.fs);
    void seedPromise.then(() => {
      if (!cancelled) setSeeded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return seeded;
}

export interface PendingSync {
  /** Which side we wrote and are waiting to observe back. */
  type: "nav" | "layout";
  slug: string;
}

/** Has the write recorded in `pending` landed in the router state yet? */
export function isPendingSettled(
  pending: PendingSync,
  pathSlug: string,
  layoutSlug: string | null,
): boolean {
  return pending.type === "nav"
    ? pathSlug === pending.slug
    : layoutSlug === pending.slug;
}

export type SyncAction =
  | { kind: "settled"; slug: string }
  | { kind: "follow-path"; slug: string }
  | { kind: "follow-layout"; slug: string }
  | { kind: "none" };

/**
 * Which side of the URL moved, and therefore which side follows. `lastSlug`
 * is the slug both sides last agreed on; whichever side no longer matches it
 * is the one the user changed. A selected non-doc file (layoutSlug null)
 * yields "none" — the URL deliberately stays on the last doc.
 */
export function decideSync(
  pathSlug: string,
  layoutSlug: string | null,
  lastSlug: string | null,
): SyncAction {
  if (layoutSlug === pathSlug) return { kind: "settled", slug: pathSlug };
  if (pathSlug !== lastSlug) return { kind: "follow-path", slug: pathSlug };
  if (layoutSlug !== null && layoutSlug !== lastSlug) {
    return { kind: "follow-layout", slug: layoutSlug };
  }
  return { kind: "none" };
}

/**
 * Reconciles the `/docs/<slug>` pathname with the `?layout=` param (the
 * workspace's single source of truth for open tabs):
 *
 *   path moved   (sidebar anchor, back/forward, first load)
 *                → that doc's tab is opened and selected;
 *   layout moved (file tree, tab click, Ctrl+Tab selecting another doc)
 *                → the pathname follows.
 *
 * One reconciler, not two competing effects: navigation and layout writes
 * apply asynchronously, so intermediate commits legitimately show one side
 * updated and the other not. `pendingRef` records the write in flight and
 * the reconciler stays hands-off until the router state reflects it —
 * otherwise a half-applied commit reads as user intent and gets "corrected"
 * backwards (the file-tree snap-back this replaced). All writes use history
 * replacement: the entry that initiated the change (anchor push or the
 * workspace's own layout push) is the one navigation entry.
 */
function useDocsUrlSync(doc: MarketingDoc): boolean {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [initialized, setInitialized] = useState(false);
  const lastSlugRef = useRef<string | null>(null);
  const pendingRef = useRef<PendingSync | null>(null);

  const layoutParam = searchParams.get(LAYOUT_PARAM);
  const selectedTab = useMemo(
    () => findLayoutSelectedTab(parseLayout(layoutParam)),
    [layoutParam],
  );

  useEffect(() => {
    const pathSlug = doc.slug;
    const layoutSlug = selectedTab
      ? (marketingDocs.find((d) => d.path === selectedTab)?.slug ?? null)
      : null;

    if (
      pendingRef.current &&
      !isPendingSettled(pendingRef.current, pathSlug, layoutSlug)
    ) {
      return;
    }
    pendingRef.current = null;

    const action = decideSync(pathSlug, layoutSlug, lastSlugRef.current);
    switch (action.kind) {
      case "settled":
        lastSlugRef.current = action.slug;
        setInitialized(true);
        break;
      case "follow-path":
        pendingRef.current = { type: "layout", slug: action.slug };
        lastSlugRef.current = action.slug;
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            const layout = openFileInLayout(
              parseLayout(next.get(LAYOUT_PARAM)),
              { tabId: doc.path, intent: "replace" },
            );
            next.set(LAYOUT_PARAM, JSON.stringify(layout));
            return next;
          },
          { replace: true },
        );
        setInitialized(true);
        break;
      case "follow-layout":
        pendingRef.current = { type: "nav", slug: action.slug };
        lastSlugRef.current = action.slug;
        navigate(
          {
            pathname: `/docs/${action.slug}`,
            search: searchParams.toString(),
          },
          { replace: true },
        );
        break;
      case "none":
        break;
    }
  }, [doc.slug, doc.path, selectedTab, searchParams, setSearchParams, navigate]);

  return initialized;
}
